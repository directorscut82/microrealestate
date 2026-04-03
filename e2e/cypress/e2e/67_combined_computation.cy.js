import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Combined scenario: VAT + discount + multiple expenses + payment
// Rent 500, expenses (charges 50 + water 20) = 570 pre-tax
// Discount 30 → 540 pre-tax
// VAT 20% on 540 = 108
// Total: 648

describe('Combined: VAT + Discount + Multiple Expenses', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.seedAndComputeRents({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Office', type: 'office', rent: 500 }],
      tenants: [{
        name: 'Complex Tenant',
        beginDate: '01/04/2026', endDate: '31/03/2035',
        leaseName: 'Bail',
        isVat: true, vatRatio: 20,
        discount: 30,
        contacts: [{ name: 'C', email: 'c@t.com', phone1: '01', phone2: '02' }],
        address: { street1: '1 r', zipCode: '75', city: 'P', country: 'F' },
        properties: [{
          name: 'Office',
          entryDate: '01/04/2026', exitDate: '31/03/2035',
          expenses: [
            { title: 'Charges communes', amount: 50 },
            { title: 'Eau', amount: 20 }
          ]
        }]
      }]
    });
  });

  it('Navigate to rents', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Tenant visible on rents page', () => {
    cy.contains('Complex Tenant').should('be.visible');
  });

  it('Rent due shows 648 (500+50+20-30=540 pre-tax, +20% VAT=108, total=648)', () => {
    cy.contains('648').should('exist');
  });

  it('Tenant detail shows VAT', () => {
    cy.navAppMenu('tenants');
    cy.contains('Complex Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('VAT')).should('exist');
  });

  it('Tenant detail shows discount', () => {
    cy.contains(t('Discount')).should('exist');
  });

  it('Tenant detail shows total 648', () => {
    cy.contains('648').should('exist');
  });

  it('Record full payment of 648', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Complex Tenant').parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('648');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Next month shows same 648 (no balance)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Complex Tenant').should('be.visible');
    cy.contains('648').should('exist');
  });

  it('Accounting reflects payment', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).click();
    cy.contains('Complex Tenant').should('be.visible');
  });

  after(() => { cy.resetAppData(); });
});
