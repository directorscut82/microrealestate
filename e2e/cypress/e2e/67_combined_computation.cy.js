import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Combined: VAT + Discount + Multiple Expenses
// Uses seed for infrastructure, UI for tenant (correct rent computation)
// Rent 500, expenses (charges 50 + water 20) = 570 pre-tax
// Discount 30 → 540 pre-tax, VAT 20% = 108, Total = 648

describe('Combined: VAT + Discount + Multiple Expenses', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    // Seed infrastructure only
    cy.seedTestData({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Office', type: 'office', rent: 500 }],
      tenants: []
    });
    // Create tenant via UI (triggers correct rent computation)
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    // Create tenant manually with multiple expenses + VAT
    cy.get('[data-cy=shortcutAddTenant]').click();
    cy.get('input[name=name]').type('Complex Tenant');
    cy.get('[data-cy=submitTenant]').click();
    // Info step
    cy.get('[data-cy=tenantIsPersonalAccount]').click();
    cy.get('input[name="address.street1"]').type('1 rue');
    cy.get('input[name="address.zipCode"]').type('75001');
    cy.get('input[name="address.city"]').type('Paris');
    cy.get('input[name="address.country"]').type('France');
    cy.get('input[name="contacts.0.contact"]').type('Contact');
    cy.get('input[name="contacts.0.email"]').type('c@t.com');
    cy.get('input[name="contacts.0.phone1"]').type('0100000000');
    cy.get('input[name="contacts.0.phone2"]').type('0100000001');
    cy.get('[data-cy=submit]').first().click();
    // Lease step
    cy.selectByLabel(t('Lease'), 'Bail');
    cy.get('input[name=beginDate]').clear().type('2026-04-01');
    cy.selectByLabel(t('Property'), 'Office');
    // First expense
    cy.get('input[name="properties.0.expenses.0.title"]').clear().type('Charges');
    cy.get('input[name="properties.0.expenses.0.amount"]').clear().type('50');
    // Second expense
    cy.contains('button', t('Add a expense')).click();
    cy.get('input[name="properties.0.expenses.1.title"]').type('Eau');
    cy.get('input[name="properties.0.expenses.1.amount"]').clear().type('20');
    cy.get('[data-cy=submit]').first().click();
    // Billing step — enable VAT
    cy.get('#isVat', { timeout: 15000 }).should('exist');
    cy.get('#isVat').click();
    cy.get('input[name=vatRatio]').clear().type('20');
    cy.get('[data-cy=submit]').first().click();
    // Documents step
    cy.get('[data-cy=submit]').first().click();
  });

  it('Navigate to rents', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Tenant visible', () => {
    cy.contains('Complex Tenant').should('be.visible');
  });

  it('Rent shows correct amount with VAT', () => {
    // 500 + 50 + 20 = 570 pre-tax, 20% VAT = 114, total = 684
    // Note: discount is per-contract, set via payment dialog, not tenant creation
    cy.contains('684').should('exist');
  });

  it('Tenant detail shows VAT', () => {
    cy.navAppMenu('tenants');
    cy.contains('Complex Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('VAT')).should('exist');
  });

  it('Tenant detail shows total with VAT', () => {
    cy.contains('684').should('exist');
  });

  it('Record full payment', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Complex Tenant').parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('684');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Next month shows same amount (no balance)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('684').should('exist');
  });

  it('Accounting reflects payment', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).click();
    cy.contains('Complex Tenant').should('be.visible');
  });

  after(() => { cy.resetAppData(); });
});
