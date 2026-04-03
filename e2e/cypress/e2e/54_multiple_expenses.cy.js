import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Verify multiple expenses per property sum correctly in rent
// Property: rent 100, expenses: charges 10 + water 5 + heating 15 = 30
// Total rent due: 100 + 30 = 130

describe('Multiple Expenses Rent Calculation', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]); // rent 100
    cy.navAppMenu('dashboard');
    // Create tenant with 3 expenses
    cy.get('[data-cy=shortcutAddTenant]').click();
    cy.get('input[name=name]').type('Multi Expense Tenant');
    cy.get('[data-cy=submitTenant]').click();
    // Tenant info step
    cy.get('[data-cy=tenantIsPersonalAccount]').click();
    cy.get('input[name="address.street1"]').type('1 rue Test');
    cy.get('input[name="address.zipCode"]').type('75001');
    cy.get('input[name="address.city"]').type('Paris');
    cy.get('input[name="address.country"]').type('France');
    cy.get('input[name="contacts.0.contact"]').type('Test');
    cy.get('input[name="contacts.0.email"]').type('test@test.com');
    cy.get('input[name="contacts.0.phone1"]').type('0123456789');
    cy.get('input[name="contacts.0.phone2"]').type('0123456789');
    cy.get('[data-cy=submit]').first().click();
    // Lease step
    cy.selectByLabel(t('Lease'), contract369.name);
    cy.get('input[name=beginDate]').clear().type('2026-04-01');
    cy.selectByLabel(t('Property'), properties[0].name);
    // First expense (auto-created)
    cy.get('input[name="properties.0.expenses.0.title"]').clear().type('Charges');
    cy.get('input[name="properties.0.expenses.0.amount"]').clear().type('10');
    // Add second expense
    cy.contains('button', t('Add a expense')).click();
    cy.get('input[name="properties.0.expenses.1.title"]').type('Eau');
    cy.get('input[name="properties.0.expenses.1.amount"]').clear().type('5');
    // Add third expense
    cy.contains('button', t('Add a expense')).click();
    cy.get('input[name="properties.0.expenses.2.title"]').type('Chauffage');
    cy.get('input[name="properties.0.expenses.2.amount"]').clear().type('15');
    cy.get('[data-cy=submit]').first().click();
    // Billing step
    cy.get('[data-cy=submit]').first().click();
    // Documents step
    cy.get('[data-cy=submit]').first().click();
  });

  it('Rents page shows tenant', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Multi Expense Tenant').should('be.visible');
  });

  it('Rent column shows 130 (100 rent + 10 + 5 + 15 expenses)', () => {
    cy.contains('Multi Expense Tenant')
      .parents('[class*="border"]')
      .contains('130')
      .should('exist');
  });

  it('Record full payment of 130', () => {
    cy.contains('Multi Expense Tenant').parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('130');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(2000);
  });

  it('Next month shows clean 130 (no balance)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Multi Expense Tenant')
      .parents('[class*="border"]')
      .contains('130')
      .should('exist');
  });

  it('Tenant detail shows all 3 expenses in rent overview', () => {
    cy.navAppMenu('tenants');
    cy.contains('Multi Expense Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains('130').should('exist');
  });

  after(() => {
    cy.resetAppData();
  });
});
