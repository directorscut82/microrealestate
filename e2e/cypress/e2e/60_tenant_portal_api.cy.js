import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Test tenant portal using API seeding and OTP bypass
// No flaky UI-based setup — all data created via API

describe('Tenant Portal via API', () => {
  const tenantEmail = 'camel@test.com';
  let otp;

  before(() => {
    cy.resetAppData();
    // Seed all data via API — fast and reliable
    cy.seedTestData({
      user: {
        firstName: userWithCompanyAccount.firstName,
        lastName: userWithCompanyAccount.lastName,
        email: userWithCompanyAccount.email,
        password: userWithCompanyAccount.password
      },
      org: {
        name: userWithCompanyAccount.orgName,
        locale: 'fr-FR',
        currency: 'EUR'
      },
      leases: [
        { name: '369', description: 'Bail commercial', numberOfTerms: 108, timeRange: 'months' }
      ],
      properties: [
        { name: 'Appartement Paris', type: 'apartment', rent: 100 }
      ],
      tenants: [
        {
          name: 'Camel Aissani',
          beginDate: '01/04/2026',
          endDate: '31/03/2035',
          leaseName: '369',
          contacts: [
            { name: 'Camel Aissani', email: tenantEmail, phone1: '0123456789', phone2: '0123456789' }
          ],
          address: { street1: '123 rue Saint-Jacques', zipCode: '75005', city: 'Paris', country: 'France' },
          properties: [
            { name: 'Appartement Paris', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 10 }] }
          ]
        }
      ]
    });
  });

  // --- Verify landlord sees the data ---

  it('Landlord can sign in and see tenant', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('tenants');
    cy.contains('Camel Aissani').should('be.visible');
  });

  it('Landlord signs out', () => {
    cy.signOut();
  });

  // --- Tenant portal ---

  it('Tenant signin page loads', () => {
    cy.visit('http://localhost:8080/tenant');
    cy.url().should('include', '/tenant');
  });

  it('Get OTP for tenant email', () => {
    cy.getTenantOTP(tenantEmail).then((result) => {
      otp = result;
      cy.log('OTP: ' + otp);
      expect(otp).to.be.a('string');
    });
  });

  it('Exchange OTP for session via authenticator', () => {
    cy.request({
      method: 'GET',
      url: `http://localhost:8080/tenantapi/signedin?otp=${otp}`,
      failOnStatusCode: false
    }).then((resp) => {
      expect(resp.status).to.eq(200);
    });
  });

  it('Tenant portal loads after authentication', () => {
    cy.visit('http://localhost:8080/tenant');
    cy.url().should('include', '/tenant');
  });

  after(() => {
    cy.resetAppData();
  });
});
