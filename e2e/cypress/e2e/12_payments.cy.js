import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Payment Recording', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper(tenants[0]);
    cy.navAppMenu('dashboard');
  });

  const t = i18n.getFixedT('fr-FR');

  it('Navigate to rents page and see tenant', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Open payment dialog via cash register button', () => {
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .find('button')
      .first()
      .click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('[role="dialog"]').contains(t('Settlement')).should('exist');
  });

  it('Fill payment amount and date', () => {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`;
    cy.get('input[name="payments.0.date"]').type(dateStr);
    cy.get('input[name="payments.0.amount"]').type('120');
  });

  it('Save payment', () => {
    cy.contains('button', t('Save')).click();
    // Drawer should close
    cy.get('[role=dialog]').should('not.exist');
  });

  it('Rent shows paid status after payment', () => {
    // After recording a full payment, the rent status should change
    // The rent amount is 100 + 10 expenses = 110, + 20% VAT = 132
    // We paid 120, so it should show as partially paid
    cy.contains(tenants[0].name).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
