import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Test balance carryover between months using actual number verification

describe('Balance Carryover Between Months', () => {
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
    // Tenant: rent 100 + charges 10 = 110/month, no VAT
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
  });

  it('Current month shows rent due 110', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    // Verify the rent amount label shows 110
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .find('div')
      .contains(/110/)
      .should('exist');
  });

  it('Record partial payment of 40', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('40');
    cy.contains('button', t('Save')).click();
  });

  it('Payment recorded — page shows tenant', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Navigate to next month', () => {
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Next month shows balance (unpaid from previous month)', () => {
    // 110 - 40 = 70 unpaid → shows as balance
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains('70').should('exist');
  });

  it('Next month rent due includes balance + new rent', () => {
    // Balance 70 + rent 110 = 180
    cy.contains('180').should('exist');
  });

  it('Record full payment of 180 for next month', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('180');
    cy.contains('button', t('Save')).click();
  });

  it('Navigate forward two months — clean rent due', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    // No balance — just 110 rent due
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .find('div')
      .contains(/110/)
      .should('exist');
  });

  it('Navigate back to first month — payment still there', () => {
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(0).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(0).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains('40').should('exist');
  });

  after(() => {
    cy.signOut();
  });
});
