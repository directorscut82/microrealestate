import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Guaranty deposit tracking
// Create tenant with guaranty, verify it shows in tenant detail

describe('Guaranty Deposit', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.seedTestData({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Apt', type: 'apartment', rent: 500 }],
      tenants: [{
        name: 'Guaranty Tenant',
        beginDate: '01/04/2026', endDate: '31/03/2035',
        leaseName: 'Bail',
        guaranty: 1000,
        contacts: [{ name: 'C', email: 'c@t.com', phone1: '01', phone2: '02' }],
        address: { street1: '1 r', zipCode: '75', city: 'P', country: 'F' },
        properties: [{ name: 'Apt', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 50 }] }]
      }]
    });
  });

  it('Sign in and navigate to tenant', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('tenants');
    cy.contains('Guaranty Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  it('Tenant detail shows deposit amount', () => {
    // The contract overview card should show the guaranty
    cy.contains(t('Deposit')).should('exist');
    cy.contains('1 000').should('exist');
  });

  it('Rents page shows tenant with correct rent', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Guaranty Tenant').should('be.visible');
    // Rent 500 + charges 50 = 550
    cy.contains('550').should('exist');
  });

  it('Terminate lease and set guaranty payback', () => {
    cy.navAppMenu('tenants');
    cy.contains('Guaranty Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('Terminate')).click();
    cy.get('input[name=terminationDate]').type('2026-06-30');
    cy.get('input[name=guarantyPayback]').clear().type('900');
    cy.get('[role=dialog]').find('button').contains(t('Terminate')).click();
  });

  it('Tenant shows terminated with deposit refund', () => {
    cy.contains(t('Terminated')).should('be.visible');
    // Deposit refund of 900 should be visible
    cy.contains('900').should('exist');
  });

  after(() => { cy.resetAppData(); });
});
