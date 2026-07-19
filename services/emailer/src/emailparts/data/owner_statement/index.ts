// OwnerStatement is the shared statement builder — the SAME data source the
// PDF uses (services/common/src/utils/ownerstatement.ts), so the email and
// its attached PDF can never disagree.
import { Collections, OwnerStatement } from '@microrealestate/common';
import moment from 'moment';

/**
 * Email data builder for the owner expense statement. `recordId` is the
 * canonical ownerKey (m:<memberId> | n:<name>|<taxId>), NOT a tenantId.
 * params: { term, realmId }.
 */
export async function get(ownerKey: string, params: Record<string, any>) {
  const realmId = String(params?.realmId || '');
  if (!ownerKey || !realmId) {
    throw new Error('owner_statement requires ownerKey + realmId');
  }
  if (OwnerStatement.isLoipoiKey(ownerKey)) {
    throw new Error(
      'owner_statement cannot be sent to the «Λοιποί ιδιοκτήτες» placeholder'
    );
  }

  const realm: any = await Collections.Realm.findById(realmId).lean();
  if (!realm) throw new Error(`realm ${realmId} not found`);
  const buildings: any[] = await Collections.Building.find({ realmId }).lean();

  const termParam = String(params?.term || '').trim();
  const subTerms = termParam ? termParam.split(',').filter(Boolean) : [];
  const all = OwnerStatement.buildOwnerStatement(buildings, ownerKey, []);
  let terms: number[] = [];
  if (subTerms.length === 0) {
    terms = [...new Set(all.charges.map((c: any) => c.term))] as number[];
  } else {
    const allTerms = [...new Set(all.charges.map((c: any) => c.term))];
    terms = allTerms.filter((t: any) =>
      subTerms.some((st: string) => String(t).startsWith(st))
    ) as number[];
  }

  // Same occupancy staleness-guard as the PDF (one algorithm, common).
  const unitPropIds: string[] = [];
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

  // O1: when a specific term was requested but filtered to zero charges,
  // emptyTermsMeans:'none' keeps the statement empty (not all-history). When
  // no term was requested at all, terms == every term, so this never triggers.
  const statement = OwnerStatement.buildOwnerStatement(
    buildings,
    ownerKey,
    terms,
    occupiedKeys,
    subTerms.length ? 'none' : 'all'
  );
  if (!statement.owner) {
    throw new Error(`owner ${ownerKey} not found in realm ${realmId}`);
  }
  // O1: a specific-month request with no charges is now a legitimately empty
  // statement (not all-history). Refuse to send an empty notice rather than
  // email an owner a €0 / blank statement for a month they owe nothing.
  if (subTerms.length && statement.charges.length === 0) {
    throw new Error(
      `no owner charges for ${ownerKey} in the requested period`
    );
  }

  const landlord: any = { ...realm };
  landlord.name =
    (realm.isCompany ? realm.companyInfo?.name : realm.contacts?.[0]?.name) ||
    realm.name ||
    '';
  landlord.hasCompanyInfo = !!realm.companyInfo;
  landlord.hasBankInfo = !!realm.bankInfo;
  landlord.hasAddress = !!realm.addresses?.length;
  landlord.hasContact = !!realm.contacts?.length;

  return {
    landlord,
    owner: statement.owner,
    ownerKey,
    charges: statement.charges,
    totals: statement.totals,
    period: termParam,
    today: moment().format('DD/MM/YYYY')
  };
}
