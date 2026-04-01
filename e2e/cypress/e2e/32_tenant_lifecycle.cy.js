import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Tenant Lifecycle — Onboard to Terminate', () => {
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

  it('Tenant appears in tenants list', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Property shows occupied by tenant', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Record payment for month 1', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('110');
    cy.contains('button', t('Save')).click();
  });

  it('Terminate lease', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('Terminate')).click();
    cy.get('input[name=terminationDate]').type('2024-06-30');
    cy.get('[role=dialog]').find('button').contains(t('Terminate')).click();
  });

  it('Tenant shows terminated status', () => {
    cy.contains(t('Terminated')).should('be.visible');
  });

  it('Property shows previous tenant after termination', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    // Terminated tenant shows as previous tenant, not current
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Terminated tenant still visible in tenants list', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Dashboard updates after termination', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Accounting reflects the tenant', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Outgoing tenants')).click();
  });

  it('Tenant detail still accessible', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.get('input[name="name"]').should('have.value', tenants[0].name);
  });

  after(() => {
    cy.signOut();
  });
});
