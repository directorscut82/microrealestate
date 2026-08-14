import { apiFetcher } from '../utils/fetch';
import moment from 'moment';

export const QueryKeys = {
  ACCOUNTING: 'accounting',
  BILLS: 'bills',
  BUILDINGS: 'buildings',
  DASHBOARD: 'dashboard',
  DOCUMENTS: 'documents',
  INBOX: 'inbox',
  ORGANIZATIONS: 'organizations',
  OWNERS: 'owners',
  PROPERTIES: 'properties',
  TENANTS: 'tenants',
  TEMPLATES: 'templates',
  RENTS: 'rents',
  LEASES: 'leases'
};

// Owner-debt ledger (καταβολές ιδιοκτητών). Owners are aggregated server-side
// across buildings; their liabilities are the buildings' ownerMonthlyExpenses.
// `year` (optional): scope owner totals to that calendar year so the
// year-scoped Accounting page reconciles with its sibling tabs + statement PDF
// (round-2 audit H9). Omit on the standalone Owners page for all-time totals.
export async function fetchOwners(year) {
  const response = await apiFetcher().get(
    year ? `/owners?year=${encodeURIComponent(year)}` : '/owners'
  );
  return response.data;
}

export async function fetchOwner(ownerKey) {
  const response = await apiFetcher().get(
    `/owners/${encodeURIComponent(ownerKey)}`
  );
  return response.data;
}

// Record an owner καταβολή. payment = { date, amount, type, reference,
// description, allocation?: [{ ownerExpenseId, amount }] }. Omit allocation to
// auto-spread oldest-term-first across the owner's outstanding charges.
export async function payOwner(ownerKey, payment) {
  const response = await apiFetcher().post(
    `/owners/${encodeURIComponent(ownerKey)}/payment`,
    { payment }
  );
  return response.data;
}

export async function fetchDashboard() {
  const response = await apiFetcher().get('/dashboard');
  return response.data;
}

// Realm-wide ΕΠΙΣΚΟΠΗΣΗ page (the ">" drill-down off the dashboard Overview
// card). `year` is a 4-digit calendar year. The server reuses the SAME rollup
// fns the building/owner/dashboard surfaces use, so figures never drift.
export async function fetchOverview(year) {
  const response = await apiFetcher().get(
    `/dashboard/overview/${encodeURIComponent(year)}`
  );
  return response.data;
}

export async function fetchAccounting(year) {
  const response = await apiFetcher().get(`/accounting/${year}`);
  return response.data;
}

export async function fetchOrganizations() {
  const response = await apiFetcher().get('/realms');
  return response.data;
}

export async function createOrganization(organization) {
  const response = await apiFetcher().post('/realms', organization);
  return response.data;
}

export async function updateOrganization(organization) {
  const response = await apiFetcher().patch(
    `/realms/${organization._id}`,
    organization
  );
  return response.data;
}

export async function createAppCredentials({ organization, expiryDate }) {
  const response = await apiFetcher().post('/authenticator/landlord/appcredz', {
    expiry: expiryDate,
    organizationId: organization._id
  });
  return response.data;
}

export async function fetchProperties({ page, limit } = {}) {
  const params = new URLSearchParams();
  if (page) params.set('page', String(page));
  if (limit) params.set('limit', String(limit));
  const query = params.toString() ? `?${params.toString()}` : '';
  const response = await apiFetcher().get(`/properties${query}`);
  return response.data;
}

// NOTE: backend supports only `page` and `limit` query params for pagination.
// Search, sort, and status filters are applied client-side; the API does not
// accept them as parameters.
export async function fetchPropertiesPage({ page = 1, limit = 100 } = {}) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  const response = await apiFetcher().get(`/properties?${params.toString()}`);
  const total = Number(response.headers?.['x-total-count'] || 0);
  const items = Array.isArray(response.data) ? response.data : [];
  return { items, total, page, limit };
}

export async function fetchProperty(id) {
  const response = await apiFetcher().get(`/properties/${id}`);
  return response.data;
}

export async function fetchPropertyExpenses(id, { from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set('from', String(from));
  if (to) params.set('to', String(to));
  const query = params.toString() ? `?${params.toString()}` : '';
  const response = await apiFetcher().get(`/properties/${id}/expenses${query}`);
  return response.data;
}

export async function createProperty(property) {
  const response = await apiFetcher().post('/properties', property);
  return response.data;
}

export async function updateProperty(property) {
  const response = await apiFetcher().patch(
    `/properties/${property._id}`,
    property
  );
  return response.data;
}

export async function deleteProperty(ids) {
  await apiFetcher().delete(`/properties/${ids.join(',')}`);
}

export async function fetchTenants({
  includeArchived = false,
  page,
  limit,
  expiringWithin
} = {}) {
  const params = new URLSearchParams();
  if (includeArchived) params.set('includeArchived', 'true');
  if (page) params.set('page', String(page));
  if (limit) params.set('limit', String(limit));
  if (expiringWithin !== undefined && expiringWithin !== null) {
    params.set('expiringWithin', String(expiringWithin));
  }
  const query = params.toString() ? `?${params.toString()}` : '';
  const response = await apiFetcher().get(`/tenants${query}`);
  return response.data;
}

// NOTE: backend supports only `page`, `limit`, and `includeArchived` query
// params. Search, sort, and status filters are applied client-side; the API
// does not accept them as parameters.
export async function fetchTenantsPage({
  includeArchived = false,
  page = 1,
  limit = 100
} = {}) {
  const params = new URLSearchParams();
  if (includeArchived) params.set('includeArchived', 'true');
  params.set('page', String(page));
  params.set('limit', String(limit));
  const response = await apiFetcher().get(`/tenants?${params.toString()}`);
  const total = Number(response.headers?.['x-total-count'] || 0);
  const items = Array.isArray(response.data) ? response.data : [];
  return { items, total, page, limit };
}

export async function fetchTenant(id) {
  const response = await apiFetcher().get(`/tenants/${id}`);
  return response.data;
}

export async function archiveTenant(id) {
  const response = await apiFetcher().put(`/tenants/${id}/archive`);
  return response.data;
}

export async function unarchiveTenant(id) {
  const response = await apiFetcher().put(`/tenants/${id}/unarchive`);
  return response.data;
}

export async function importTenantPdf(file) {
  const formData = new FormData();
  formData.append('pdf', file);
  const response = await apiFetcher().post('/tenants/import-pdf', formData);
  return response.data;
}

export async function extendTenantLease(tenantId, parsed) {
  const response = await apiFetcher().post(
    `/tenants/${tenantId}/extend-lease`,
    parsed
  );
  return response.data;
}

export async function createTenant(tenant) {
  const response = await apiFetcher().post('/tenants', tenant);
  return response.data;
}

export async function updateTenant(tenant) {
  const response = await apiFetcher().patch(`/tenants/${tenant._id}`, tenant);
  return response.data;
}

export async function deleteTenant(ids) {
  await apiFetcher().delete(`/tenants/${ids.join(',')}`);
}

export async function fetchRents(yearMonth) {
  let period;
  if (yearMonth) {
    period = moment(yearMonth, 'YYYY.MM', true);
  }

  if (!period || !period.isValid()) {
    period = moment();
  }

  const year = period.year();
  const month = period.month() + 1;

  const response = await apiFetcher().get(`/rents/${year}/${month}`);
  return response.data;
}

export async function fetchLeases() {
  const response = await apiFetcher().get('/leases');
  return response.data;
}

export async function fetchLease(id) {
  const response = await apiFetcher().get(`/leases/${id}`);
  return response.data;
}

export async function createLease(lease) {
  const response = await apiFetcher().post('/leases', lease);
  return response.data;
}

export async function updateLease(lease) {
  const response = await apiFetcher().patch(`/leases/${lease._id}`, lease);
  return response.data;
}

export async function deleteLease(ids) {
  await apiFetcher().delete(`/leases/${ids.join(',')}`);
}

export async function sendRentEmails(payload) {
  // Return the per-tenant status list. The api answers HTTP 207 (Multi-Status)
  // on a PARTIAL batch — some tenants delivered, others bounced — and axios does
  // NOT throw on 207, so the caller must inspect this list to surface failures
  // instead of assuming a resolved promise means every email was delivered.
  const response = await apiFetcher().post('/emails', payload);
  return response.data;
}

export async function sendRentSms(payload) {
  const response = await apiFetcher().post('/emails/sms', payload);
  return response.data;
}

export async function sendOwnerStatements(payload) {
  const response = await apiFetcher().post('/emails/owners', payload);
  return response.data;
}

export async function sendOwnerSms(payload) {
  const response = await apiFetcher().post('/emails/owners/sms', payload);
  return response.data;
}

export async function updateOwnerContact({ ownerKey, ...contact }) {
  const response = await apiFetcher().patch(
    `/owners/${encodeURIComponent(ownerKey)}/contact`,
    contact
  );
  return response.data;
}

export async function payRent({ term, payment }) {
  const response = await apiFetcher().patch(
    `/rents/payment/${payment._id}/${term}`,
    payment
  );
  return response.data;
}

export async function fetchTenantRents(tenantId) {
  const response = await apiFetcher().get(`/rents/tenant/${tenantId}`);
  return response.data;
}

export async function fetchTemplates() {
  const response = await apiFetcher().get('/templates');
  return response.data;
}

export async function createTemplate(template) {
  const response = await apiFetcher().post('/templates', template);
  return response.data;
}

export async function updateTemplate(template) {
  const response = await apiFetcher().patch('/templates', template);
  return response.data;
}

export async function deleteTemplate(ids) {
  await apiFetcher().delete(`/templates/${ids.join(',')}`);
}

export async function deleteDocumentByKey(key) {
  if (!key) return;
  await apiFetcher().delete(`/documents/by-key?key=${encodeURIComponent(key)}`);
}

export async function fetchDocuments(entityFilter) {
  // entityFilter (optional): { tenantId } | { buildingId } | { propertyId } |
  // { ownerKey } — scopes the list to one entity's documents server-side.
  //
  // THIS IS AN ALLOW-LIST, AND AN UNKNOWN KEY FAILS OPEN. `propertyId` was added
  // to the schema, the create guard, the list route and the panel, but not here —
  // so the query string came out EMPTY and the request fell back to "every
  // document in the realm". The apartment tab then listed every file the landlord
  // owns, under one flat. Nothing errored; the list simply looked populated.
  // Adding a filter key means adding it HERE too, or the scoping silently stops
  // existing.
  const params = new URLSearchParams();
  if (entityFilter?.tenantId) params.set('tenantId', entityFilter.tenantId);
  if (entityFilter?.buildingId)
    params.set('buildingId', entityFilter.buildingId);
  if (entityFilter?.propertyId)
    params.set('propertyId', entityFilter.propertyId);
  if (entityFilter?.ownerKey) params.set('ownerKey', entityFilter.ownerKey);
  const qs = params.toString();
  const response = await apiFetcher().get(`/documents${qs ? `?${qs}` : ''}`);
  return response.data;
}

/**
 * The file-browser SHAPE: per-building counts and nothing else. No document bodies,
 * no urls — a few hundred bytes however many files the realm holds.
 *
 * Settings → Αρχεία previously called `fetchDocuments()` unfiltered and pulled every
 * row in the realm on page open. This is the endpoint that lets the page render the
 * folders first and fetch a folder's files only when it is opened.
 */
export async function fetchDocumentTree() {
  const response = await apiFetcher().get('/documents/tree');
  return response.data;
}

/**
 * One page of a folder's files.
 *
 * `propertyIds` / `tenantIds` are SETS so «every apartment of this building» is one
 * request rather than one per apartment. `limit`/`skip` keep an opened folder to one
 * page — the landlord's realm accumulates bills for years.
 */
export async function fetchDocumentPage({
  buildingId,
  propertyIds,
  tenantIds,
  ownerKey,
  bucket,
  limit = 50,
  skip = 0
} = {}) {
  const params = new URLSearchParams();
  if (buildingId) params.set('buildingId', buildingId);
  if (propertyIds?.length) params.set('propertyIds', propertyIds.join(','));
  if (tenantIds?.length) params.set('tenantIds', tenantIds.join(','));
  if (ownerKey) params.set('ownerKey', ownerKey);
  // `bucket` ('owners' | 'unattached') is a server-side predicate for the realm-level
  // folders. It exists so those folders never have to send an EMPTY filter: an empty
  // filter means "every document in the realm", and that fail-open is what made the
  // apartment tab list the whole realm.
  if (bucket) params.set('bucket', bucket);
  // Only files. The tree counts files only, so without this the two disagree and a
  // folder can show fewer rows than its badge.
  params.set('type', 'file');
  params.set('limit', String(limit));
  params.set('skip', String(skip));
  const response = await apiFetcher().get(`/documents?${params.toString()}`);
  return response.data;
}

export async function createDocument(document) {
  const response = await apiFetcher().post('/documents', document);
  return response.data;
}

export async function updateDocument(document) {
  const response = await apiFetcher().patch('/documents', document);
  return response.data;
}

export async function deleteDocuments(ids) {
  if (!ids?.length) return;
  await apiFetcher().delete(`/documents/${ids.join(',')}`);
}

export async function fetchBuildings() {
  const response = await apiFetcher().get('/buildings');
  return response.data;
}

export async function fetchBuilding(id) {
  const response = await apiFetcher().get(`/buildings/${id}`);
  return response.data;
}

export async function createBuilding(building) {
  const response = await apiFetcher().post('/buildings', building);
  return response.data;
}

export async function updateBuilding(building) {
  const response = await apiFetcher().patch(
    `/buildings/${building._id}`,
    building
  );
  return response.data;
}

export async function deleteBuilding(ids) {
  await apiFetcher().delete(`/buildings/${ids.join(',')}`);
}

export async function importBuildingPdf(file, confirmed = false, options = {}) {
  const formData = new FormData();
  formData.append('pdf', file);
  // T2.P1.20: caller may pass `force=true` to opt into destructive overwrite
  // of existing Property fields (electricitySupplyNumber, name, surface).
  // Default is non-destructive — server only fills empty fields.
  const params = [];
  if (confirmed) params.push('confirmed=true');
  if (options.force) params.push('force=true');
  const url =
    '/buildings/import-pdf' + (params.length ? `?${params.join('&')}` : '');
  // T2.P1.21: forward AbortSignal so the dialog can cancel an in-flight
  // upload when the user clicks Cancel during parsing/confirming.
  const response = await apiFetcher().post(url, formData, {
    signal: options.signal
  });
  return response.data;
}

export async function addBuildingUnit(buildingId, unit) {
  const response = await apiFetcher().post(
    `/buildings/${buildingId}/units`,
    unit
  );
  return response.data;
}

export async function updateBuildingUnit(buildingId, unit) {
  const response = await apiFetcher().patch(
    `/buildings/${buildingId}/units/${unit._id}`,
    unit
  );
  return response.data;
}

export async function removeBuildingUnit(buildingId, unitId) {
  await apiFetcher().delete(`/buildings/${buildingId}/units/${unitId}`);
}

export async function addBuildingExpense(buildingId, expense) {
  const response = await apiFetcher().post(
    `/buildings/${buildingId}/expenses`,
    expense
  );
  return response.data;
}

export async function updateBuildingExpense(buildingId, expense) {
  const response = await apiFetcher().patch(
    `/buildings/${buildingId}/expenses/${expense._id}`,
    expense
  );
  return response.data;
}

export async function removeBuildingExpense(
  buildingId,
  expenseId,
  mode = 'hard'
) {
  await apiFetcher().delete(
    `/buildings/${buildingId}/expenses/${expenseId}?mode=${mode}`
  );
}

export async function addBuildingContractor(buildingId, contractor) {
  const response = await apiFetcher().post(
    `/buildings/${buildingId}/contractors`,
    contractor
  );
  return response.data;
}

export async function updateBuildingContractor(buildingId, contractor) {
  const response = await apiFetcher().patch(
    `/buildings/${buildingId}/contractors/${contractor._id}`,
    contractor
  );
  return response.data;
}

export async function removeBuildingContractor(buildingId, contractorId) {
  await apiFetcher().delete(
    `/buildings/${buildingId}/contractors/${contractorId}`
  );
}

export async function addBuildingRepair(buildingId, repair) {
  const response = await apiFetcher().post(
    `/buildings/${buildingId}/repairs`,
    repair
  );
  return response.data;
}

export async function updateBuildingRepair(buildingId, repair) {
  const response = await apiFetcher().patch(
    `/buildings/${buildingId}/repairs/${repair._id}`,
    repair
  );
  return response.data;
}

export async function removeBuildingRepair(buildingId, repairId) {
  await apiFetcher().delete(`/buildings/${buildingId}/repairs/${repairId}`);
}

export async function addMonthlyCharge(buildingId, unitId, charge) {
  const response = await apiFetcher().post(
    `/buildings/${buildingId}/units/${unitId}/charges`,
    charge
  );
  return response.data;
}

export async function updateMonthlyCharge(buildingId, unitId, charge) {
  const response = await apiFetcher().patch(
    `/buildings/${buildingId}/units/${unitId}/charges/${charge._id}`,
    charge
  );
  return response.data;
}

export async function removeMonthlyCharge(buildingId, unitId, chargeId) {
  await apiFetcher().delete(
    `/buildings/${buildingId}/units/${unitId}/charges/${chargeId}`
  );
}

export async function saveMonthlyStatement(buildingId, data) {
  const response = await apiFetcher().post(
    `/buildings/${buildingId}/monthly-statement`,
    data
  );
  return response.data;
}

export async function fetchExpenseBreakdown(buildingId, term) {
  const response = await apiFetcher().get(
    `/buildings/${buildingId}/expense-breakdown?term=${encodeURIComponent(term)}`
  );
  return response.data;
}

// Toggle an owner-side monthly-expense row's paid flag. Returns the updated
// building so React Query can refresh the Overview paid/unpaid tile.
export async function setOwnerExpensePaid(buildingId, ownerExpenseId, paid) {
  const response = await apiFetcher().patch(
    `/buildings/${buildingId}/owner-expense/${ownerExpenseId}/paid`,
    { paid }
  );
  return response.data;
}

// §5: record a VOLUNTARY contribution toward a building's Αχρέωτα. Returns the
// updated building so React Query can refresh the Overview Αχρέωτα tile + the
// ΧΡΕΩΣΕΙΣ panel. payload = { term, amount, paidByType:'renter'|'owner',
// payerId, date?, reference? }.
export async function addUncollectedPayment(buildingId, payload) {
  const response = await apiFetcher().post(
    `/buildings/${buildingId}/uncollected-payment`,
    payload
  );
  return response.data;
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

export async function parseBillPdfs(files) {
  const formData = new FormData();
  files.forEach((file) => formData.append('bills', file));
  const response = await apiFetcher().post('/bills/parse', formData);
  return response.data;
}

export async function confirmBills(bills) {
  const response = await apiFetcher().post('/bills/confirm', { bills });
  return response.data;
}

// Slice 5: archive a confirmed bill's source file to B2 (upload-dialog path).
// Sent AFTER confirm returns the bill _id, as multipart (the source can't ride
// the JSON confirm body). Best-effort — the caller ignores failures.
export async function attachBillSource(billId, file) {
  const formData = new FormData();
  formData.append('source', file);
  const response = await apiFetcher().post(
    `/bills/${billId}/attach-source`,
    formData
  );
  return response.data;
}

export async function parsePaymentReceipts(files) {
  const formData = new FormData();
  files.forEach((file) => formData.append('bills', file));
  const response = await apiFetcher().post('/bills/payment-receipt', formData);
  return response.data;
}

export async function confirmBillPayment(billIds, paymentProofUrl) {
  const response = await apiFetcher().post('/bills/confirm-payment', {
    billIds,
    paymentProofUrl
  });
  return response.data;
}

// Slice 6 — record receipt installments against a bill OR a repair. `payments`
// is [{kind:'bill'|'repair', billId|repairId, buildingId?, amount, date,
// matchedOn}]. Server appends each to the target's receipts[] and recomputes
// paid/partial. Returns { updated: [...] }.
export async function confirmReceiptPayments(payments) {
  const response = await apiFetcher().post('/bills/confirm-payment', {
    payments
  });
  return response.data;
}

// Slice 6 Tier-2 — open a Telegram re-capture session for a checksum-failed
// RF/IBAN. target is 'rf'|'iban'. billingId (optional) binds the session to the
// bill being corrected so the poller refuses a re-shot of a DIFFERENT bill.
// Returns { id, target, expiresAt }.
export async function startRecapture(target, billingId) {
  const response = await apiFetcher().post('/bills/recapture/start', {
    target,
    ...(billingId ? { billingId } : {})
  });
  return response.data;
}

// Poll a re-capture session → { status:'waiting'|'recovered'|'timeout', value?, target }.
export async function pollRecapture(id) {
  const response = await apiFetcher().get(
    `/bills/recapture/${encodeURIComponent(id)}`
  );
  return response.data;
}

/**
 * Bills, optionally scoped to a building or a status.
 *
 * The expense panel matches a bill to a δαπάνη row on `(expenseId, term)` — which
 * is already the Bill collection's unique index, so the mapping is exact rather
 * than heuristic. Fetched ONCE per building, never per row: the panel renders up
 * to 12 months x N expenses and a per-row fetch would be a request storm.
 */
export async function fetchBills({ buildingId, status } = {}) {
  const params = new URLSearchParams();
  if (buildingId) params.set('buildingId', buildingId);
  if (status) params.set('status', status);
  const response = await apiFetcher().get(`/bills?${params.toString()}`);
  return response.data;
}

// Inbox — bills that arrived via the Telegram bot, pending confirm/dismiss
// from the notification bell (Slice 4).
export async function fetchInbox() {
  const response = await apiFetcher().get('/inbox');
  return response.data;
}

export async function confirmInboxItem(id, payload) {
  const response = await apiFetcher().post(`/inbox/${id}/confirm`, payload);
  return response.data;
}

export async function dismissInboxItem(id) {
  const response = await apiFetcher().post(`/inbox/${id}/dismiss`);
  return response.data;
}

export async function downloadDatabaseBackup() {
  const response = await apiFetcher().get('/database/backup');
  return response;
}

export async function restoreDatabase(backupData) {
  const response = await apiFetcher().post('/database/restore', backupData, {
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  return response.data;
}
