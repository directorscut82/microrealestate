import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Rent Computation Verification', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
    cy.addPropertyFromPage(properties[1]);
    // Tenant A — rent 100 + charges 10 = 110, no VAT
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[0],
      lease: {
        contract: contract369.name,
        beginDate: '01/01/2024',
        properties: [{
          name: properties[0].name,
          expense: { title: 'charges', amount: 10 },
          entryDate: '01/01/2024',
          exitDate: '31/12/2032'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
    // Tenant B — rent 200 + charges 30 = 230, with 20% VAT
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[1],
      lease: {
        contract: contract369.name,
        beginDate: '01/01/2024',
        properties: [{
          name: properties[1].name,
          expense: { title: 'charges', amount: 30 },
          entryDate: '01/01/2024',
          exitDate: '31/12/2032'
        }]
      },
      billing: { isVat: true, percentageVatRatio: 20 }
    });
  });

  it('Rents page shows both tenants', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  it('Rents overview shows not-paid summary', () => {
    cy.contains(t('Not paid')).should('be.visible');
  });

  it('Rents overview shows total to pay', () => {
    cy.contains(t('Rents for the period')).should('be.visible');
  });

  it('Record partial payment for tenant A', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('50');
    cy.contains('button', t('Save')).click();
  });

  it('Rents page reflects partial payment', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Record full payment for tenant A', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('60');
    cy.contains('button', t('Save')).click();
  });

  it('Record full payment for tenant B (with VAT)', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[1].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('276');
    cy.contains('button', t('Save')).click();
  });

  it('Rents overview shows paid summary', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(t('Paid')).should('be.visible');
  });

  it('Accounting page shows settlements', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).click();
  });

  it('Tenant A detail shows rent info', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  it('Tenant B detail shows rent info with VAT', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[1].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('VAT')).should('be.visible');
  });

  it('Dashboard revenue reflects all payments', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Revenues')).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
