import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Edge cases: overpayment credit, zero rent, multiple expenses

describe('Payment Edge Cases', () => {
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
    // Tenant: rent 100 + charges 10 = 110/month
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

  it('Rent due is 110', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('110,00')
      .should('exist');
  });

  it('Record overpayment of 150 (40 extra)', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('[role="dialog"]').find('input[name="payments.0.amount"]').should('exist');
    cy.get('[role="dialog"]').find('input[name="payments.0.amount"]').clear().type('150');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
  });

  it('Settlement shows 150,00', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('150,00')
      .should('exist');
  });

  it('Navigate to next month — credit balance reduces rent due', () => {
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    // Overpayment of 40 should reduce next month: 110 - 40 = 70
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('70,00')
      .should('exist');
  });

  it('Record exact payment of 70 for next month', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('[role="dialog"]').find('input[name="payments.0.amount"]').should('exist');
    cy.get('[role="dialog"]').find('input[name="payments.0.amount"]').clear().type('70');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
  });

  it('Month after shows clean 110 (no carryover)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('110,00')
      .should('exist');
  });

  it('Accounting reflects all payments', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).click();
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Dashboard revenue updated', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Revenues')).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
