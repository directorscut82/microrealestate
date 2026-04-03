import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Payment Edge Cases', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.seedAndComputeRents({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Apt', type: 'apartment', rent: 100 }],
      tenants: [{
        name: tenants[0].name,
        beginDate: '01/04/2026', endDate: '31/03/2035',
        leaseName: 'Bail',
        contacts: tenants[0].contacts,
        address: tenants[0].address,
        properties: [{ name: 'Apt', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 10 }] }]
      }]
    });
  });

  it('Rent due is 110', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains('110').should('exist');
  });

  it('Record overpayment of 150', () => {
    cy.recordPayment(tenants[0].name, 150);
  });

  it('Next month shows reduced rent due (credit applied)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
    // Overpayment of 40 credit → 110 - 40 = 70 due
    cy.contains('70').should('exist');
  });

  it('Accounting page loads', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Dashboard shows revenue', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Revenues')).should('be.visible');
  });

  after(() => { cy.resetAppData(); });
});
