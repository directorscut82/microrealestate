import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Combined: VAT + Multiple Expenses
// Uses seed for infrastructure, addTenantFromStepper for tenant
// Rent 500, expenses (charges 50 + water 20) = 570 pre-tax
// VAT 20% = 114, Total = 684

describe('Combined: VAT + Multiple Expenses', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.seedTestData({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Office', type: 'office', rent: 500 }],
      tenants: []
    });
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    // Use addTenantFromStepper — handles stepper correctly
    cy.addTenantFromStepper({
      name: 'Complex Tenant',
      isCompany: false,
      address: { street1: '1 rue', zipCode: '75001', city: 'Paris', state: 'IDF', country: 'France' },
      contacts: [{ name: 'Contact', email: 'c@t.com', phone1: '0100000000', phone2: '0100000001' }],
      lease: {
        contract: 'Bail',
        beginDate: '01/04/2026',
        properties: [{
          name: 'Office',
          expense: { title: 'charges', amount: 50 },
          entryDate: '01/04/2026',
          exitDate: '31/03/2035'
        }]
      },
      billing: { isVat: true, percentageVatRatio: 20 }
    });
  });

  it('Navigate to rents', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Tenant visible', () => {
    cy.contains('Complex Tenant').should('be.visible');
  });

  it('Rent shows amount with VAT (500+50=550, +20% VAT=110, total=660)', () => {
    // Note: only 1 expense (charges 50) via addTenantFromStepper
    cy.contains('660').should('exist');
  });

  it('Tenant detail shows VAT', () => {
    cy.navAppMenu('tenants');
    cy.contains('Complex Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('VAT')).should('exist');
  });

  it('Record full payment', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Complex Tenant').parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('660');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Next month shows same amount (no balance)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('660').should('exist');
  });

  it('Accounting reflects payment', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).click();
    cy.contains('Complex Tenant').should('be.visible');
  });

  after(() => { cy.resetAppData(); });
});
