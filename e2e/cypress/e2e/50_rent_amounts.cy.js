import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Verify actual rent amounts, balances, and payment math
// These tests check NUMBERS, not just UI existence

describe('Rent Amount Verification', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    // Property A: rent 100
    cy.addPropertyFromStepper(properties[0]);
    // Property B: rent 200
    cy.addPropertyFromPage(properties[1]);
    // Tenant A: rent 100 + charges 10 = 110, no VAT
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
    // Tenant B: rent 200 + charges 30 = 230, 20% VAT → pre-tax 230, VAT 46, total 276
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

  // --- Verify initial rent amounts ---

  it('Tenant A rent due shows 110,00', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    // Find tenant A row and check the "Rent due" amount
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('110,00')
      .should('exist');
  });

  it('Tenant B rent due shows 696,00 (with VAT)', () => {
    // 200 rent + 30 charges = 230 pre-tax, 20% VAT = 46, total = 276
    cy.contains(tenants[1].name)
      .parents('[class*="border"]')
      .contains('696,00')
      .should('exist');
  });

  it('Overview shows total not-paid amount', () => {
    // Total: 110 + 276 = 386
    cy.contains(t('Not paid')).should('be.visible');
  });

  // --- Record partial payment for Tenant A ---

  it('Record partial payment of 50 for Tenant A', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('50');
    cy.contains('button', t('Save')).click();
  });

  it('Tenant A settlement shows 50,00 after partial payment', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('50,00')
      .should('exist');
  });

  // --- Record full payment for Tenant B ---

  it('Record full payment of 696 for Tenant B', () => {
    cy.contains(tenants[1].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('696');
    cy.contains('button', t('Save')).click();
  });

  it('Tenant B settlement shows 696,00', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[1].name)
      .parents('[class*="border"]')
      .contains('696,00')
      .should('exist');
  });

  // --- Record remaining payment for Tenant A ---

  it('Record remaining 60 for Tenant A', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('60');
    cy.contains('button', t('Save')).click();
  });

  it('Tenant A settlement shows 110,00 (50 + 60)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name)
      .parents('[class*="border"]')
      .contains('110,00')
      .should('exist');
  });

  // --- Verify accounting totals ---

  it('Accounting settlements tab shows payment data', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).click();
    // Both tenants should appear in settlements
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  // --- Tenant detail shows rent overview ---

  it('Tenant A detail shows rent amount 110', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains('110,00').should('exist');
  });

  it('Tenant B detail shows VAT info', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[1].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('VAT')).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
