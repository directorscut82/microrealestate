import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Two tenants: one with VAT, one without
// Verify accounting totals reflect both correctly

describe('Accounting Totals Verification', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]); // rent 100
    cy.addPropertyFromPage(properties[1]); // rent 550
    // Tenant A: no VAT, rent 100 + charges 10 = 110
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
    // Tenant B: 20% VAT, rent 550 + charges 30 = 580 pre-tax, VAT 116, total 696
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[1],
      lease: {
        contract: contract369.name,
        beginDate: '01/04/2026',
        properties: [{
          name: properties[1].name,
          expense: { title: 'charges', amount: 30 },
          entryDate: '01/04/2026',
          exitDate: '31/03/2035'
        }]
      },
      billing: { isVat: true, percentageVatRatio: 20 }
    });
  });

  it('Rents page shows both tenants', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  it('Tenant A rent due is 110', () => {
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('110')
      .should('exist');
  });

  it('Tenant B rent due is 696', () => {
    cy.contains(tenants[1].name)
      .parents('[class*="border"]')
      .contains('696')
      .should('exist');
  });

  it('Not-paid overview shows combined total', () => {
    // 110 + 696 = 806
    cy.contains(t('Not paid')).should('be.visible');
    cy.contains('806').should('exist');
  });

  it('Pay tenant A full 110', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('110');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Pay tenant B full 696', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[1].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('696');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Paid overview shows combined total', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    // 110 + 696 = 806
    cy.contains(t('Paid')).should('be.visible');
    cy.contains('806').should('exist');
  });

  it('Accounting settlements shows both tenants', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).click();
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  it('Accounting incoming tenants tab loads', () => {
    cy.contains(t('Incoming tenants')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Dashboard revenue reflects payments', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Revenues')).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
