import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Multiple payment types in same month
// Record cash 50 + transfer 60 = 110 total

describe('Multiple Payment Types', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.seedAndComputeRents({
      user: userWithCompanyAccount,
      org: { name: 'Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 108, timeRange: 'months' }],
      properties: [{ name: 'Apt', type: 'apartment', rent: 100 }],
      tenants: [{
        name: 'Payment Types Tenant',
        beginDate: '01/04/2026', endDate: '31/03/2035',
        leaseName: 'Bail',
        contacts: [{ name: 'C', email: 'c@t.com', phone1: '01', phone2: '02' }],
        address: { street1: '1 r', zipCode: '75', city: 'P', country: 'F' },
        properties: [{ name: 'Apt', entryDate: '01/04/2026', exitDate: '31/03/2035', expenses: [{ title: 'charges', amount: 10 }] }]
      }]
    });
  });

  it('Navigate to rents', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Payment Types Tenant').should('be.visible');
  });

  it('Open payment dialog', () => {
    cy.contains('Payment Types Tenant').parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
  });

  it('First payment: cash 50', () => {
    cy.get('input[name="payments.0.amount"]').clear().type('50');
    // Select cash type
    cy.get('[role="dialog"]').find('button[role="combobox"]').first().click({ force: true });
    cy.get('[role="option"]').contains(t('Cash')).click({ force: true });
  });

  it('Add second payment: transfer 60', () => {
    // Click "Add a settlement" button
    cy.get('[role="dialog"]').contains('button', t('Add a settlement')).click();
    cy.get('input[name="payments.1.amount"]').clear().type('60');
  });

  it('Save both payments', () => {
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Total settlement shows 110', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Payment Types Tenant').should('be.visible');
    cy.contains('110').should('exist');
  });

  it('Next month shows clean rent (no balance)', () => {
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('Payment Types Tenant').should('be.visible');
    cy.contains('110,00').should('exist');
  });

  after(() => { cy.resetAppData(); });
});
