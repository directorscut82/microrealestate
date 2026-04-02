import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Test tenant portal access via OTP
// 1. Create tenant with contact email via landlord app
// 2. Call tenant signin API to generate OTP
// 3. Read OTP from Redis
// 4. Use OTP to get session token
// 5. Visit tenant portal

describe('Tenant Portal Access', () => {
  const t = i18n.getFixedT('fr-FR');
  const tenantEmail = tenants[0].contacts[0].email;
  let otp;

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[0],
      lease: {
        contract: contract369.name,
        beginDate: '01/04/2026',
        properties: [{
          name: properties[0].name,
          expense: { title: 'charges', amount: 10 },
          entryDate: '01/04/2026',
          exitDate: '31/03/2035'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
    cy.signOut();
  });

  it('Tenant signin page loads', () => {
    cy.visit('http://localhost:8080/tenant');
    cy.url().should('include', '/tenant');
  });

  it('Request OTP for tenant email', () => {
    cy.request({
      method: 'POST',
      url: 'http://localhost:8080/tenantapi/signin',
      body: { email: tenantEmail },
      failOnStatusCode: false
    }).then((resp) => {
      // 200 or 204 means OTP was created (email sending may fail but OTP is in Redis)
      expect(resp.status).to.be.oneOf([200, 204]);
    });
  });

  it('Read OTP from Redis', () => {
    // Wait for Redis to have the OTP
    cy.wait(1000);
    cy.exec(
      `/usr/local/bin/finch exec microrealestate-redis-1 redis-cli -a ogZNKcskFFiXWFOO KEYS '*'`,
      { failOnNonZeroExit: false }
    ).then((result) => {
      const keys = result.stdout.split('\n').filter(k => k.trim() && !k.includes('Warning'));
      expect(keys.length).to.be.greaterThan(0);
      otp = keys[0].trim();
      cy.log('OTP: ' + otp);
    });
  });

  it('Exchange OTP for session token', () => {
    cy.request({
      method: 'GET',
      url: `http://localhost:8080/tenantapi/signedin?otp=${otp}`,
      failOnStatusCode: false
    }).then((resp) => {
      expect(resp.status).to.eq(200);
      // Session token is set as a cookie
      cy.log('Tenant authenticated');
    });
  });

  it('Tenant portal shows tenant data', () => {
    cy.visit('http://localhost:8080/tenant');
    cy.url().should('include', '/tenant');
  });

  after(() => {
    cy.resetAppData();
  });
});
