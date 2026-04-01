import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Test balance carryover between months
// Partial payment in month 1 → balance appears in month 2

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
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('110,00')
      .should('exist');
  });

  it('Record partial payment of 40', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('40');
    cy.contains('button', t('Save')).click();
  });

  it('Settlement shows 40,00', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('40,00')
      .should('exist');
  });

  it('Navigate to next month', () => {
    // Click right chevron
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Next month shows balance of 70 (110 - 40 unpaid)', () => {
    // Previous month: 110 due, 40 paid, 70 unpaid → carried as balance
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('70,00')
      .should('exist');
  });

  it('Next month total due includes balance + new rent', () => {
    // Balance 70 + new rent 110 = 180 total due
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('180,00')
      .should('exist');
  });

  it('Record full payment of 180 for next month', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('180');
    cy.contains('button', t('Save')).click();
  });

  it('Navigate to month after — no balance carryover', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    // Should show clean 110 (no balance from previous months)
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('110,00')
      .should('exist');
  });

  it('Navigate back to first month — payment still recorded', () => {
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(0).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(0).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('40,00')
      .should('exist');
  });

  after(() => {
    cy.signOut();
  });
});
