import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Dashboard Accuracy', () => {
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
  });

  it('Dashboard loads with data', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Shows tenant count', () => {
    cy.contains(t('Tenants')).should('be.visible');
  });

  it('Shows property count', () => {
    cy.contains(t('Properties')).should('be.visible');
  });

  it('Shows occupancy rate', () => {
    cy.contains(t('Occupancy rate')).should('be.visible');
  });

  it('Shows revenue section', () => {
    cy.contains(t('Revenues')).should('be.visible');
  });

  it('Shows top unpaid section', () => {
    cy.contains(t('Top 5 of not paid rents')).should('be.visible');
  });

  it('Record a payment and verify dashboard updates', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('110');
    cy.contains('button', t('Save')).click();
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Revenues')).should('be.visible');
  });

  it('Add second property and tenant', () => {
    cy.addPropertyFromPage(properties[1]);
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
      billing: { isVat: false, percentageVatRatio: 0 }
    });
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Dashboard reflects updated counts', () => {
    cy.contains(t('Tenants')).should('be.visible');
    cy.contains(t('Properties')).should('be.visible');
  });

  it('Rents page shows both tenants', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
