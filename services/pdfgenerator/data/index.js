import { Collections, logger, ShareBasis } from '@microrealestate/common';
import moment from 'moment';

// Item 6: attach the per-unit calc-basis equation to each tenant building
// charge so the receipt prints the SAME breakdown as the on-screen ΧΡΕΩΣΕΙΣ
// panel. The stored rent.buildingCharges rows carry only {type, amount, …}; we
// match each to the building expense (by type) and compute the renter unit's
// share via the shared ShareBasis builder. Best-effort: a charge with no
// building, no matching expense, or no resolvable unit keeps basis = null (the
// EJS then renders no sub-line for it). Repair-typed charges have no
// building.expense — their basis is omitted on the tenant side (the owner
// statement carries the repair basis).
// Does a tenant-side basis equation actually evaluate to the billed share?
// Used as a correct-or-nothing gate on the receipt (Step-7): if the recomputed
// divisor disagrees with the engine's (e.g. _tenantGroups not attached to the
// PDF's building snapshot), the printed equation would be arithmetically false
// — so we drop it. Tolerance 0,02 € absorbs cent rounding across units.
function _basisReconciles(basis, billedShare) {
  if (!basis || typeof basis !== 'object') return false;
  const share = Number(billedShare) || 0;
  let computed;
  switch (basis.kind) {
    case 'equal':
      if (!(Number(basis.count) > 0)) return false;
      computed = (Number(basis.total) || 0) / Number(basis.count);
      break;
    case 'surface':
    case 'thousandths':
      if (!(Number(basis.whole) > 0)) return false;
      computed =
        ((Number(basis.part) || 0) / Number(basis.whole)) *
        (Number(basis.total) || 0);
      break;
    case 'custom_ratio':
      if (!(Number(basis.whole) > 0)) return false;
      computed =
        ((Number(basis.part) || 0) / Number(basis.whole)) *
        (Number(basis.total) || 0);
      break;
    case 'custom_percentage':
      computed = ((Number(basis.part) || 0) / 100) * (Number(basis.total) || 0);
      break;
    case 'fixed':
    case 'single_unit':
      // No divisor to contradict — the share IS the stated amount.
      return true;
    default:
      return false;
  }
  return Math.abs(computed - share) <= 0.02;
}

function _enrichTenantChargeBasis(charges, building, tenantPropertyId, term) {
  if (!Array.isArray(charges) || charges.length === 0) return charges;
  if (!building || !Array.isArray(building.units)) return charges;
  const unit = building.units.find(
    (u) => String(u.propertyId) === String(tenantPropertyId)
  );
  if (!unit) return charges;
  const expenses = building.expenses || [];
  const partyCount = ShareBasis.equalPartyCount(building, Number(term));
  return charges.map((c) => {
    if (c.basis) return c; // already resolved upstream
    // Repairs (type 'repair') have no building.expense — skip (the owner
    // statement carries repair basis).
    if (!c.type || c.type === 'repair') return c;
    // Resolve the SOURCE building expense for this charge. A live-computed
    // charge is stored with the expense's real type (e.g. 'electricity_common')
    // — match by type, preferring the expense whose name matches. But a
    // VARIABLE (κυμαινόμενο) charge is persisted with the GENERIC type
    // 'monthly_charge' (its per-term amount lives on the unit's monthlyCharge,
    // not the expense doc), so a type match finds nothing → it printed «Λοιπά»
    // with no breakdown. Fall back to a name match across ALL expenses to
    // recover BOTH the correct category label AND the calc basis. The reconcile
    // gate below still protects against a wrong match printing a false equation.
    const byType = expenses.filter((e) => e.type === c.type);
    let exp =
      byType.find(
        (e) =>
          c.description &&
          String(e.name || '').trim() === String(c.description).trim()
      ) || byType[0];
    if (!exp && c.description) {
      exp = expenses.find(
        (e) => String(e.name || '').trim() === String(c.description).trim()
      );
    }
    if (!exp) return c;
    // A VARIABLE charge mis-stored with the generic 'monthly_charge' type reads
    // «Λοιπά»; show the source expense's REAL type so the receipt reads
    // «Κοινόχρηστο Ρεύμα» — the SAME canonical label as the expense table and
    // the on-screen ΧΡΕΩΣΕΙΣ panel (one type→label map, no drift). No-op for a
    // correctly-stored charge (resolvedType === c.type).
    const resolvedType = exp.type || c.type;
    const withType = resolvedType !== c.type ? { ...c, type: resolvedType } : c;
    // CORRECT-OR-NOTHING on a legal receipt: the equation needs the EXPENSE
    // TOTAL (the pool), not the per-unit charge amount. A recurring/fixed
    // expense carries it on exp.amount; a VARIABLE expense stores 0 there —
    // its real per-term total lives on the unit's monthlyCharge.inputAmount
    // (the full statement figure the landlord typed, e.g. 30 €). Prefer
    // inputAmount so the receipt shows the SAME basis as the ΧΡΕΩΣΕΙΣ panel; if
    // neither yields a pool, keep the corrected label but render no basis line
    // (never print "0 € ÷ 11 = 9,09 €").
    let total = Number(exp.amount) || 0;
    if (!(total > 0)) {
      const mc = (unit.monthlyCharges || []).find(
        (m) =>
          Number(m.term) === Number(term) &&
          String(m.expenseId || '') === String(exp._id) &&
          m.inputAmount != null &&
          Number(m.inputAmount) > 0
      );
      if (mc) total = Number(mc.inputAmount);
    }
    if (!(total > 0)) return withType;
    const basis = ShareBasis.shareBasis(
      building,
      unit,
      exp,
      total,
      Number(c.amount) || 0,
      partyCount
    );
    // CORRECT-OR-NOTHING on a legal receipt (Step-7): only keep the basis when
    // its equation actually evaluates to the billed share. The receipt's
    // `firstBuilding` is fetched WITHOUT _tenantGroups, so equalPartyCount can
    // fall back to managed.length instead of the engine's real divisor (active
    // groups + vacant) — which would print "100 € ÷ 4 = 33,33 €" (false) for a
    // multi-unit tenant. Verifying total/count ≈ share drops exactly those
    // mismatches while keeping every consistent equation. Same guard covers
    // surface/thousandths (part/whole × total) and the custom kinds.
    if (!_basisReconciles(basis, Number(c.amount) || 0)) return withType;
    return { ...withType, basis };
  });
}

export async function getRentsData(params, documentId) {
  const { id: tenantId, term, realmId } = params;
  // Wave-26 round-3v: rent.charges (Δαπάνη επί του ενοικίου) is excluded
  // from RECEIPTS (απόδειξη είσπραξης) — paid by the tenant to a third
  // party, not received by the landlord — but MUST be included in
  // rent-calls so the rendered subTotal sums to the headline grandTotal
  // already shown in the limit line and the on-screen Πρόγραμμα tile.
  // Default to invoice/receipt behavior (omit charges) when the caller
  // does not pass a documentId, preserving the historical contract.
  const omitCharges = documentId === 'invoice' || !documentId;

  // Realm-scope the query: callers MUST supply the realmId of the requester
  // so a session in one organization can never read a tenant from another.
  // We accept calls without realmId only for backward compat with callers
  // that have not been updated yet, but log loudly so missing call sites
  // surface in production logs.
  const filter = { _id: tenantId };
  if (realmId) {
    filter.realmId = realmId;
  } else {
    logger.warn(
      `getRentsData called without realmId for tenant ${tenantId} — cross-tenant access not enforced`
    );
  }

  let dbTenant;
  try {
    dbTenant = await Collections.Tenant.findOne(filter)
      .populate('realmId')
      .populate('leaseId')
      .populate('properties.propertyId');
  } catch (error) {
    logger.error(error);
  }
  if (!dbTenant) {
    throw new Error(`tenant ${tenantId} not found`);
  }

  // Wave-26 round-3u: pull the building doc(s) for the tenant's properties
  // so the receipt header can prefer the building.manager (διαχειριστής)
  // over the realm (ιδιοκτήτης) when present. The Property schema carries
  // buildingId, but populate() didn't reach into Building. Fetch separately.
  const propertyBuildingIds = (dbTenant.properties || [])
    .map((p) => p?.propertyId?.buildingId)
    .filter(Boolean)
    .map((id) => String(id));
  let firstBuilding = null;
  if (propertyBuildingIds.length) {
    try {
      // Defense-in-depth: scope the building lookup by realmId so a
      // tampered tenant.properties.buildingId pointing at another realm's
      // building cannot leak that building's manager block onto the PDF.
      const buildingFilter = { _id: propertyBuildingIds[0] };
      if (realmId) {
        buildingFilter.realmId = realmId;
      }
      firstBuilding = await Collections.Building.findOne(buildingFilter).lean();
    } catch (error) {
      logger.error(error);
    }
  }

  const landlord = dbTenant.realmId;
  // Wave-26 round-3v: capture the realm slug name BEFORE clobbering it.
  // When a realm is configured without companyInfo.name AND without any
  // contact name, the previous code left landlord.name as '' and the PDF
  // header rendered an empty <h1>. The realm document itself always has
  // a name (the org slug — e.g. "landlord"), so fall back to that.
  const realmSlugName = String(landlord?.name || '');
  landlord.name =
    (landlord.isCompany
      ? landlord.companyInfo?.name
      : landlord.contacts?.[0]?.name) ||
    realmSlugName ||
    '';
  landlord.hasCompanyInfo = !!landlord.companyInfo;
  landlord.hasBankInfo = !!landlord.bankInfo;
  landlord.hasAddress = !!landlord.addresses?.length;
  landlord.hasContact = !!landlord.contacts?.length;

  // Q4 multi-month batch: callers may pass either a single term/prefix
  // ("2026", "2026040100") or a comma-separated list of up to 12 such
  // terms ("2026010100,2026020100,2026030100"). The route validates
  // shape and count; we just OR across sub-terms here so the data
  // picker stays agnostic to single vs. batch callers.
  // The tenant's unit propertyId — used to compute the renter-side calc-basis
  // (item 6). First property (the receipt renders a single property row).
  const tenantPropertyId = String(
    dbTenant.properties?.[0]?.propertyId?._id ||
      dbTenant.properties?.[0]?.propertyId ||
      ''
  );

  const terms = String(term).split(',');
  let rents = [];
  if (dbTenant.rents.length) {
    rents = dbTenant.rents
      .filter((rent) =>
        terms.some((t) => String(rent.term).startsWith(t))
      )
      .map((rent) => ({
        ...rent,
        period: rent.term,
        billingReference: `${moment(rent.term, 'YYYYMMDDHH').format('MM_YY_')}${
          dbTenant.reference
        }`,
        // Item 6: enrich each building charge with its calc-basis equation (the
        // SAME per-unit breakdown the on-screen ΧΡΕΩΣΕΙΣ panel shows) so the
        // receipt prints "100 € ÷ 11 μονάδες = 9,09 €" under the line. Matches
        // the charge to the building expense by type and computes the renter's
        // unit share via the shared ShareBasis builder. Best-effort — a charge
        // we can't resolve (no building / no matching expense) keeps basis null.
        buildingCharges: _enrichTenantChargeBasis(
          rent.buildingCharges || [],
          firstBuilding,
          tenantPropertyId,
          rent.term
        ),
        // Wave-26 round-3v: tell the shared invoicebody.ejs whether to
        // render the rent.charges (property-surcharge) loop. Receipts
        // omit it; rent-calls keep it so the line items sum to the
        // headline grandTotal. The flag is consumed by invoicebody.ejs
        // and also drives the empty-row filler math.
        _omitCharges: omitCharges,
        total: (() => {
          // Wave-26 round-3v: subTotal MUST include rent.charges for
          // rent-call documents so the rendered table sums to the
          // headline rent.total.grandTotal already used in the limit
          // line. For receipts, we keep the prior behavior and exclude
          // rent.charges (third-party surcharge — not landlord income).
          const buildingChargesSum = (rent.buildingCharges || []).reduce(
            (s, c) => s + (Number(c.amount) || 0),
            0
          );
          const propertyChargesSum = (rent.charges || []).reduce(
            (s, c) => s + (Number(c.amount) || 0),
            0
          );
          const subTotal =
            (rent.total.preTaxAmount || 0) +
            buildingChargesSum +
            (omitCharges ? 0 : propertyChargesSum) -
            (rent.total.discount || 0) +
            (rent.total.debts || 0);
          // Receipt headline = subTotal (pre-VAT) + VAT + previous balance.
          // The template prints "Total before VAT" (subTotal), then a "VAT"
          // line, then "Previous balance", then "Total with VAT"
          // (invoiceGrandTotal) — so the headline MUST include the VAT or the
          // legal Greek receipt does not foot (its printed line-items sum to
          // more than the headline) and a fully-paid VAT tenant shows phantom
          // remaining debt (round-2 audit H2). subTotal stays pre-VAT (it is
          // labeled "Total before VAT"); VAT is added into the headline only.
          // Rent-call headline = the pipeline grandTotal (already VAT-inclusive)
          // so the PDF matches the rest of the app exactly.
          const invoiceGrandTotal = omitCharges
            ? Math.round(
                (subTotal + (rent.total.vat || 0) + (rent.total.balance || 0)) *
                  100
              ) / 100
            : Math.round((rent.total.grandTotal || 0) * 100) / 100;
          return {
            ...rent.total,
            payment: rent.total.payment || 0,
            subTotal: Math.round(subTotal * 100) / 100,
            invoiceGrandTotal,
            newBalance: invoiceGrandTotal - (rent.total.payment || 0)
          };
        })(),
        // Property address line for the customer-reference table
        // (Διεύθυνση μισθίου). First property only — multi-property
        // tenants get the first one rendered; the table is a single row.
        propertyAddress: (() => {
          const addr = dbTenant.properties?.[0]?.propertyId?.address;
          if (!addr) return '';
          return [addr.street1, addr.zipCode, addr.city]
            .filter(Boolean)
            .join(', ');
        })()
      }));
  }

  const tenant = {
    name: dbTenant.isCompany ? dbTenant.company : dbTenant.name,
    isCompany: dbTenant.isCompany,
    companyInfo: {
      name: dbTenant.company,
      capital: dbTenant.capital,
      ein: dbTenant.siret,
      dos: dbTenant.rcs,
      // Tenant schema stores the VAT/tax id as `taxId`. Reading
      // `vatNumber` here always returned undefined and the PDF rendered
      // a blank where the company's ΑΦΜ should appear.
      vatNumber: dbTenant.taxId,
      legalRepresentative: dbTenant.manager
    },
    // Wave-26 round-3u: expose tenant.contacts so the receipt's tenant
     // block can render phone1/phone2/email under the ΑΦΜ line.
    contacts: dbTenant.contacts || [],
    addresses: [
      {
        street1: dbTenant.street1,
        street2: dbTenant.street2,
        city: dbTenant.city,
        state: dbTenant.state,
        country: dbTenant.country,
        zipCode: dbTenant.zipCode || ''
      }
    ],
    contract: {
      name: dbTenant.contract,
      lease: dbTenant.leaseId,
      beginDate: dbTenant.beginDate,
      endDate: dbTenant.endDate,
      properties: dbTenant.properties.reduce((acc, { propertyId }) => {
        acc.push(propertyId);
        return acc;
      }, [])
    },
    rents
  };
  if (dbTenant.terminationDate) {
    tenant.contract.terminationDate = dbTenant.terminationDate;
  }

  // Sanitize fileName before it becomes a filesystem path. dbTenant.name
  // is user-controlled and previously flowed straight into file IO,
  // which crashed on names containing `/`, `..`, or quotes — and worse,
  // could escape the output directory. Allow ASCII alphanum, dot,
  // dash, underscore plus the Greek code blocks to keep Greek tenant
  // names intact. Same shape as the emailer attachments sanitize().
  const sanitize = (s) =>
    String(s || 'tenant')
      .replace(/[^A-Za-z0-9._\-Ͱ-Ͽἀ-῿]/g, '_')
      .slice(0, 100);
  const fileName = `${sanitize(dbTenant.name)}-${term}`;

  // Wave-26 round-3u: documentActor — the issuer rendered in the receipt's
  // header + footer. Priority: building.manager (διαχειριστής) when ANY of
  // its fields is present; else the realm (ιδιοκτήτης). Empty fields stay
  // empty — there is no implicit fallback to admin user info.
  const buildDocumentActor = () => {
    const m = firstBuilding?.manager;
    if (m && (m.name || m.taxId || m.phone || m.email || m.company)) {
      return {
        role: 'manager',
        name: m.name || m.company || '',
        taxId: m.taxId || '',
        phone: m.phone || '',
        email: m.email || '',
        address: null
      };
    }
    return {
      role: 'owner',
      name: landlord.name,
      taxId: landlord.companyInfo?.vatNumber || '',
      phone: landlord.contacts?.[0]?.phone1 || '',
      email: landlord.contacts?.[0]?.email || '',
      address: landlord.addresses?.[0] || null
    };
  };

  return {
    fileName,
    tenant,
    landlord,
    documentActor: buildDocumentActor()
  };
}

export function avoidWeekend(aMoment) {
  const day = aMoment.isoWeekday();
  if (day === 6) {
    // if saturday shift the due date to friday
    aMoment.subtract(1, 'days');
  } else if (day === 7) {
    // if sunday shift the due date to friday
    aMoment.subtract(2, 'days');
  }
  return aMoment;
}
