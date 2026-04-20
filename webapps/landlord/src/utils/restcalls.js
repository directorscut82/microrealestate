import { apiFetcher } from '../utils/fetch';
import moment from 'moment';

export const QueryKeys = {
  ACCOUNTING: 'accounting',
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
