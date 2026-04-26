import { apiFetcher } from '../utils/fetch';
import moment from 'moment';

export const QueryKeys = {
  ACCOUNTING: 'accounting',
  BUILDINGS: 'buildings',
  DASHBOARD: 'dashboard',
  DOCUMENTS: 'documents',
  ORGANIZATIONS: 'organizations',
  PROPERTIES: 'properties',
  TENANTS: 'tenants',
  TEMPLATES: 'templates',
  RENTS: 'rents',
  LEASES: 'leases'
};

export async function fetchDashboard() {
  const response = await apiFetcher().get('/dashboard');
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

export async function fetchProperties() {
  const response = await apiFetcher().get('/properties');
  return response.data;
}

export async function fetchProperty(id) {
  const response = await apiFetcher().get(`/properties/${id}`);
  return response.data;
}

export async function createProperty(property) {
  const response = await apiFetcher().post('/properties', property);
  return response.data;
}

export async function updateProperty(property) {
  const response = await apiFetcher().patch(`/properties/${property._id}`, property);
  return response.data;
}

export async function deleteProperty(ids) {
  await apiFetcher().delete(`/properties/${ids.join(',')}`);
}

export async function fetchTenants(includeArchived = false) {
  const params = includeArchived ? '?includeArchived=true' : '';
  const response = await apiFetcher().get(`/tenants${params}`);
  return response.data;
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
  await apiFetcher().post('/emails', payload);
}

export async function sendRentSms(payload) {
  const response = await apiFetcher().post('/emails/sms', payload);
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

export async function fetchDocuments() {
  const response = await apiFetcher().get('/documents');
  return response.data;
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

export async function importBuildingPdf(file, confirmed = false) {
  const formData = new FormData();
  formData.append('pdf', file);
  const url = confirmed
    ? '/buildings/import-pdf?confirmed=true'
    : '/buildings/import-pdf';
  const response = await apiFetcher().post(url, formData);
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

export async function removeBuildingExpense(buildingId, expenseId) {
  await apiFetcher().delete(`/buildings/${buildingId}/expenses/${expenseId}`);
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
