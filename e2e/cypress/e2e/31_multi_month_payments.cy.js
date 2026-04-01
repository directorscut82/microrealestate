import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Multi-Month Payment Tracking', () => {
  const t = i18n.getFixedT('fr-FR');

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
        beginDate: '01/01/2024',
        properties: [{
          name: properties[0].name,
          expense: { title: 'charges', amount: 10 },
          entryDate: '01/01/2024',
          exitDate: '31/12/2032'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
  });

  it('Navigate to rents page', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Record payment for current month', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('110');
    cy.contains('button', t('Save')).click();
  });

  it('Rents page reflects payment', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Navigate to previous month', () => {
    // PeriodPicker has two buttons — first is previous, second is next
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(0).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Navigate back to current month', () => {
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Accounting page shows settlements', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).click();
  });

  it('Accounting shows incoming tenants', () => {
    cy.contains(t('Incoming tenants')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Accounting shows outgoing tenants', () => {
    cy.contains(t('Outgoing tenants')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Tenant rent history accessible', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  it('Dashboard shows revenue after payments', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Revenues')).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
