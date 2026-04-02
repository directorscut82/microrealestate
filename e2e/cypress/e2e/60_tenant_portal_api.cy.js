import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Test tenant portal using API seeding and OTP bypass

describe('Tenant Portal via API', () => {
  const tenantEmail = 'camel@test.com';

  before(() => {
    cy.resetAppData();
    cy.seedTestData({
      user: {
        firstName: userWithCompanyAccount.firstName,
        lastName: userWithCompanyAccount.lastName,
        email: userWithCompanyAccount.email,
        password: userWithCompanyAccount.password
      },
      org: { name: userWithCompanyAccount.orgName, locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: '369', description: 'Bail', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Appartement Paris', type: 'apartment', rent: 100 }],
      tenants: [{
        name: 'Camel Aissani',
        beginDate: '01/04/2026', endDate: '31/03/2035',
        leaseName: '369',
        contacts: [{ name: 'Camel', email: tenantEmail, phone1: '0123456789', phone2: '0123456789' }],
        address: { street1: '123 rue Test', zipCode: '75005', city: 'Paris', country: 'France' },
        properties: [{ name: 'Appartement Paris', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 10 }] }]
      }]
    });
  });

  it('Landlord sees tenant', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('tenants');
    cy.contains('Camel Aissani').should('be.visible');
    cy.signOut();
  });

  it('Get OTP and authenticate tenant', () => {
    // Get OTP via API
    cy.request({
      method: 'POST',
      url: 'http://localhost:8080/api/reset/otp',
      body: { email: tenantEmail }
    }).then((otpResp) => {
      const otp = otpResp.body.otp;
      // Exchange OTP for session
      cy.request({
        method: 'GET',
        url: `http://localhost:8080/tenantapi/signedin?otp=${otp}`,
        failOnStatusCode: false
      }).then((authResp) => {
        expect(authResp.status).to.eq(200);
      });
    });
  });

  it('Tenant portal loads', () => {
    cy.visit('http://localhost:8080/tenant');
    cy.url().should('include', '/tenant');
  });

  after(() => {
    cy.resetAppData();
  });
});
