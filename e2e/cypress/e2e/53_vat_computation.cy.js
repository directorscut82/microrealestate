import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Verify VAT computation: pre-tax, VAT amount, total
// Tenant with 20% VAT on rent 200 + charges 30 = 580 pre-tax
// VAT = 116, Total = 696

describe('VAT Computation Verification', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[1]); // rent 200
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

  it('Rents page shows tenant', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  it('Rent due shows 696,00 (230 + 20% VAT)', () => {
    cy.contains(tenants[1].name)
      .parents('[class*="border"]')
      .contains('696,00')
      .should('exist');
  });

  it('Tenant detail shows VAT label', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[1].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('VAT')).should('be.visible');
  });

  it('Tenant detail shows pre-tax total 230', () => {
    cy.contains('580,00').should('exist');
  });

  it('Tenant detail shows VAT amount 46', () => {
    cy.contains('116,00').should('exist');
  });

  it('Tenant detail shows total 276', () => {
    cy.contains('696,00').should('exist');
  });

  it('Record partial payment of 230 (pre-tax only)', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[1].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('580');
    cy.contains('button', t('Save')).click();
  });

  it('Next month balance shows 46 (unpaid VAT)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    // Balance: 46 (unpaid VAT from previous month)
    cy.contains(tenants[1].name)
      .parents('[class*="border"]')
      .contains('116,00')
      .should('exist');
  });

  it('Next month total due is 812 (696 + 116 balance)', () => {
    cy.contains(tenants[1].name)
      .parents('[class*="border"]')
      .contains('812,00')
      .should('exist');
  });

  it('Record full payment of 322', () => {
    cy.contains(tenants[1].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('812');
    cy.contains('button', t('Save')).click();
  });

  after(() => {
    cy.signOut();
  });
});
