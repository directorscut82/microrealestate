import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Verify referential integrity: API blocks deletion of occupied properties
// and contracts in use. UI shows error toast.

describe('Referential Integrity', () => {
  const t = i18n.getFixedT('fr-FR');
  let realmId, propId, leaseId;

  before(() => {
    cy.resetAppData();
    cy.seedAndComputeRents({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Occupied Apt', type: 'apartment', rent: 100 }],
      tenants: [{
        name: 'Blocking Tenant',
        beginDate: '01/04/2026', endDate: '31/03/2035',
        leaseName: 'Bail',
        contacts: [{ name: 'C', email: 'c@t.com', phone1: '01', phone2: '02' }],
        address: { street1: '1 r', zipCode: '75', city: 'P', country: 'F' },
        properties: [{ name: 'Occupied Apt', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 10 }] }]
      }]
    }).then((data) => {
      realmId = data.realmId;
      propId = data.properties['Occupied Apt'];
      leaseId = data.leases['Bail'];
    });
  });

  // --- Property deletion blocked ---

  it('API rejects deleting occupied property with 422', () => {
    cy.request({
      method: 'POST',
      url: 'http://localhost:8080/api/v2/authenticator/landlord/signin',
      body: { email: userWithCompanyAccount.email, password: userWithCompanyAccount.password }
    }).then((auth) => {
      cy.request({
        method: 'DELETE',
        url: `http://localhost:8080/api/v2/properties/${propId}`,
        headers: { 'Authorization': `Bearer ${auth.body.accessToken}`, 'organizationId': realmId },
        failOnStatusCode: false
      }).then((resp) => {
        expect(resp.status).to.eq(422);
      });
    });
  });

  it('UI shows error toast when trying to delete occupied property', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('properties');
    cy.contains('Occupied Apt').click();
    cy.intercept('DELETE', '**/properties/**').as('deleteProperty');
    cy.get('[data-cy=removeResourceButton]').click();
    // Confirm dialog — click Continue
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteProperty').its('response.statusCode').should('eq', 422);
    // Toast should appear
    cy.get('ol.toaster > li', { timeout: 5000 }).should('exist');
  });

  // --- Contract deletion blocked ---

  it('API rejects deleting contract in use with 422', () => {
    cy.request({
      method: 'POST',
      url: 'http://localhost:8080/api/v2/authenticator/landlord/signin',
      body: { email: userWithCompanyAccount.email, password: userWithCompanyAccount.password }
    }).then((auth) => {
      cy.request({
        method: 'DELETE',
        url: `http://localhost:8080/api/v2/leases/${leaseId}`,
        headers: { 'Authorization': `Bearer ${auth.body.accessToken}`, 'organizationId': realmId },
        failOnStatusCode: false
      }).then((resp) => {
        expect(resp.status).to.eq(422);
      });
    });
  });

  it('Contract detail page loads for in-use contract', () => {
    cy.navOrgMenu('contracts');
    cy.contains('Bail').click();
    cy.get('[data-cy=contractPage]').should('exist');
  });

  after(() => { cy.resetAppData(); });
});
