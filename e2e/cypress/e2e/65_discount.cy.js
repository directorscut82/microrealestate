import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Discount applied to rent via payment dialog
// Rent: 100 + charges 10 = 110
// Apply discount of 20 → rent due becomes 90

describe('Discount Application', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.seedTestData({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Apt', type: 'apartment', rent: 100 }],
      tenants: [{
        name: 'Discount Tenant',
        beginDate: '01/04/2026', endDate: '31/03/2035',
        leaseName: 'Bail',
        discount: 20,
        contacts: [{ name: 'C', email: 'c@t.com', phone1: '01', phone2: '02' }],
        address: { street1: '1 r', zipCode: '75', city: 'P', country: 'F' },
        properties: [{ name: 'Apt', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 10 }] }]
      }]
    });
  });

  it('Navigate to rents', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Rent due shows 90 (110 - 20 discount)', () => {
    cy.contains('Discount Tenant').should('be.visible');
    // 100 rent + 10 charges - 20 discount = 90
    cy.contains('90').should('exist');
  });

  it('Record full payment of 90', () => {
    cy.contains('Discount Tenant').parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('90');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Next month shows clean 90 (discount persists)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Discount Tenant').should('be.visible');
    cy.contains('90').should('exist');
  });

  it('Tenant detail shows discount info', () => {
    cy.navAppMenu('tenants');
    cy.contains('Discount Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    // Discount should be visible in rent overview
    cy.contains(t('Discount')).should('exist');
  });

  after(() => { cy.resetAppData(); });
});
