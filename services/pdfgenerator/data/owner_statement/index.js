import { Collections, OwnerStatement, Service, logger } from '@microrealestate/common';
import fileUrl from 'file-url';
import moment from 'moment';
import path from 'path';

// Owner expense statement (Εκκαθαριστικό εξόδων ιδιοκτήτη) — the OWNER twin of
// the tenant receipt (απόδειξη). It reuses the SAME EJS template family
// (header / recipient / place+date / reference / body table / totals / footer)
// so the document is visually equivalent to the tenant receipt; only the
// recipient (owner instead of tenant) and the line items (eksoda + repairs
// instead of rent) differ. Numbers come from the SHARED
// common/OwnerStatement.buildOwnerStatement so they match the on-screen owner
// ledger exactly (no divergence between PDF and UI).
//
// params: { ownerKey, term, realmId }. term is a YYYYMMDDHH or YYYY prefix, or
// a comma-separated list (same shape as the receipt's multi-month batch).
export async function get(params) {
  const { TEMPLATES_DIRECTORY } = Service.getInstance().envConfig.getValues();
  // Express already URL-decodes the :ownerKey path param ONCE in the route
  // handler, so do NOT decode again — a second decode throws URIError on names
  // containing a literal '%' (e.g. "50% off realty") → a misleading 404 for an
  // owner who genuinely has charges (adversarial finding, June 2026). The
  // canonical un-encoded ownerKey is what buildOwnerStatement expects.
  const ownerKey = String(params.ownerKey || '');
  const realmId = String(params.realmId || '');
  if (!ownerKey || !realmId) {
    throw new Error('owner_statement requires ownerKey + realmId');
  }

  const realm = await Collections.Realm.findById(realmId).lean();
  if (!realm) throw new Error(`realm ${realmId} not found`);

  const buildings = await Collections.Building.find({ realmId }).lean();

  // Resolve which terms to include. A 4-digit prefix (a whole year) expands to
  // the distinct terms present in this owner's charges for that year; a full
  // 10-digit term selects that month. Empty term → all of the owner's charges.
  const termParam = String(params.term || '').trim();
  const subTerms = termParam ? termParam.split(',').filter(Boolean) : [];

  // First pass: get ALL the owner's charges (no term filter) so we can expand
  // year-prefixes to concrete terms.
  const all = OwnerStatement.buildOwnerStatement(buildings, ownerKey, []);
  let terms = [];
  if (subTerms.length === 0) {
    terms = [...new Set(all.charges.map((c) => c.term))];
  } else {
    const allTerms = [...new Set(all.charges.map((c) => c.term))];
    terms = allTerms.filter((t) =>
      subTerms.some((st) => String(t).startsWith(st))
    );
  }

  // Resolve tenant occupancy for the requested terms so the statement drops a
  // stale 'vacant'/'owner-resident' owner row whose unit is actually
  // tenant-occupied — same guard the on-screen breakdown + dashboard apply, so
  // the settlement document never bills the owner for a euro that is also the
  // tenant's rent (round-4 review). One occupancy algorithm (common).
  const unitPropIds = [];
  for (const b of buildings) {
    for (const u of b.units || []) {
      if (u.propertyId) unitPropIds.push(String(u.propertyId));
    }
  }
  const occTenants = unitPropIds.length
    ? await Collections.Tenant.find(
        { realmId, 'properties.propertyId': { $in: unitPropIds } },
        {
          beginDate: 1,
          endDate: 1,
          terminationDate: 1,
          'properties.propertyId': 1,
          'properties.entryDate': 1,
          'properties.exitDate': 1
        }
      ).lean()
    : [];
  const occupiedKeys = OwnerStatement.occupiedPropertyTermKeys(
    occTenants,
    terms
  );

  const statement = OwnerStatement.buildOwnerStatement(
    buildings,
    ownerKey,
    terms,
    occupiedKeys
  );
  if (!statement.owner) {
    throw new Error(`owner ${ownerKey} not found in realm ${realmId}`);
  }
  if (statement.charges.length === 0) {
    throw new Error(`no owner charges for ${ownerKey} in term ${termParam}`);
  }

  // ── Build the landlord block (issuer formatters: locale/currency) exactly
  // like getRentsData does for the receipt. ──
  const landlord = { ...realm };
  const realmSlugName = String(realm?.name || '');
  landlord.name =
    (realm.isCompany ? realm.companyInfo?.name : realm.contacts?.[0]?.name) ||
    realmSlugName ||
    '';
  landlord.hasAddress = !!realm.addresses?.length;

  // documentActor — the issuer in header/footer. The owner statement is issued
  // BY the landlord/manager TO the owner, so the issuer is the realm (or its
  // building manager when present), identical to the receipt's owner role.
  const firstBuilding = buildings[0] || null;
  const m = firstBuilding?.manager;
  const documentActor =
    m && (m.name || m.taxId || m.phone || m.email || m.company)
      ? {
          role: 'manager',
          name: m.name || m.company || '',
          taxId: m.taxId || '',
          phone: m.phone || '',
          email: m.email || '',
          address: null
        }
      : {
          role: 'owner',
          name: landlord.name,
          taxId: realm.companyInfo?.vatNumber || '',
          phone: realm.contacts?.[0]?.phone1 || '',
          email: realm.contacts?.[0]?.email || '',
          address: realm.addresses?.[0] || null
        };

  // ── Build one statement "section" per term, shaped like a receipt `rent` so
  // the shared invoice partials render it unchanged. eksoda + repairs become
  // buildingCharges[] (invoicebody renders them with the type→label map, incl.
  // 'repair' → Επισκευή). preTaxAmounts/discounts/debts are empty. ──
  const byTerm = new Map();
  for (const c of statement.charges) {
    const arr = byTerm.get(c.term) || [];
    arr.push(c);
    byTerm.set(c.term, arr);
  }

  const today = moment();
  const sections = [...byTerm.keys()]
    .sort((a, b) => a - b)
    .map((term) => {
      const items = byTerm.get(term);
      const buildingCharges = items.map((c) => ({
        // 'repair' type → Επισκευή; else the source expense's schema type.
        type: c.expenseType || (c.source === 'expense' ? 'other' : c.source),
        amount: c.amount,
        description: c.description || '',
        buildingName: c.buildingName || '',
        // per-owner split (name/percentage/amount, isRest for the un-named
        // remainder) so a co-owned charge prints "(Name 50% = €X, λοιποί 50%)".
        coOwners: Array.isArray(c.coOwners) ? c.coOwners : [],
        // Calc-basis equation (item 6) so the statement shows the SAME per-unit
        // breakdown as the on-screen ΧΡΕΩΣΕΙΣ panel.
        basis: c.basis || null
      }));
      const subTotal = items.reduce((s, c) => s + c.amount, 0);
      const payment = items.reduce((s, c) => s + c.paidAmount, 0);
      const grand = Math.round(subTotal * 100) / 100;
      const paid = Math.round(payment * 100) / 100;
      return {
        term,
        period: term,
        billingReference: `${moment(term, 'YYYYMMDDHH').format('MM_YY_')}${String(
          ownerKey
        ).replace(/[^A-Za-z0-9]/g, '').slice(-8)}`,
        documentDate: today.format('DD/MM/YYYY'),
        propertyAddress: '',
        preTaxAmounts: [],
        buildingCharges,
        discounts: [],
        debts: [],
        charges: [],
        vats: [],
        _omitCharges: true,
        total: {
          subTotal: grand,
          vat: 0,
          balance: 0,
          invoiceGrandTotal: grand,
          payment: paid,
          // newBalance > 0 → still payable; < 0 → credit. Owner owes (grand −
          // paid); a settled month nets to 0.
          newBalance: Math.round((grand - paid) * 100) / 100
        }
      };
    });

  // The owner statement reuses the invoice template, which iterates
  // `tenant.rents`. We shape an owner-as-recipient object with `.rents` =
  // sections and a `.contract.lease.timeRange` of 'months' so
  // _.formatTerm renders the month label.
  const owner = statement.owner;
  const sanitize = (s) =>
    String(s || 'owner')
      .replace(/[^A-Za-z0-9._\-Ͱ-Ͽἀ-῿]/g, '_')
      .slice(0, 100);

  const data = {
    fileName: `${sanitize(owner.name)}-${termParam || 'all'}`,
    // The template references `tenant.*` for the recipient block; we pass the
    // owner under both `owner` and `tenant` so the shared partials render.
    tenant: {
      name: owner.name,
      isCompany: false,
      companyInfo: { vatNumber: owner.taxId || '' },
      contacts: owner.phone || owner.email
        ? [{ phone1: owner.phone || '', email: owner.email || '' }]
        : [],
      addresses: [],
      contract: { lease: { timeRange: 'months' } },
      rents: sections
    },
    owner,
    landlord,
    documentActor,
    cssUrl: fileUrl(path.join(TEMPLATES_DIRECTORY, 'css', 'print.css')),
    logoUrl: fileUrl(path.join(TEMPLATES_DIRECTORY, 'img', 'logo.png'))
  };

  logger.debug(
    `owner_statement: ${owner.name} ${sections.length} section(s), total ${statement.totals.amount}`
  );
  return data;
}
