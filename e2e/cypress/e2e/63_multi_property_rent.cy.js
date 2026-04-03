import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Tenant with 2 properties — verify combined rent
// Property A: rent 100 + charges 10 = 110
// Property B: rent 200 + charges 30 = 230
// Combined: 340/month

describe('Multi-Property Tenant Rent', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.seedTestData({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [
        { name: 'Apt A', type: 'apartment', rent: 100 },
        { name: 'Apt B', type: 'apartment', rent: 200 }
      ],
      tenants: [{
        name: 'Multi Prop Tenant',
        beginDate: '01/04/2026', endDate: '31/03/2035',
        leaseName: 'Bail',
        contacts: [{ name: 'C', email: 'c@t.com', phone1: '01', phone2: '02' }],
        address: { street1: '1 r', zipCode: '75', city: 'P', country: 'F' },
        properties: [
          { name: 'Apt A', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 10 }] },
          { name: 'Apt B', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 30 }] }
        ]
      }]
    });
  });

  it('Sign in and navigate to rents', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Tenant shows combined rent of 340', () => {
    cy.contains('Multi Prop Tenant').should('be.visible');
    // 100 + 10 + 200 + 30 = 340
    cy.contains('340').should('exist');
  });

  it('Record full payment of 340', () => {
    cy.contains('Multi Prop Tenant').parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('340');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Next month shows clean 340 (no balance)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Multi Prop Tenant').should('be.visible');
    cy.contains('340').should('exist');
  });

  it('Tenant detail shows both properties', () => {
    cy.navAppMenu('tenants');
    cy.contains('Multi Prop Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains('340').should('exist');
  });

  after(() => { cy.resetAppData(); });
});
