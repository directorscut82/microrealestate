import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Search & Filter', () => {
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
    cy.addPropertyFromPage(properties[2]);
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
  });

  it('Search tenants by full name', () => {
    cy.navAppMenu('tenants');
    cy.searchResource(tenants[0].name);
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('not.exist');
    cy.searchResource('');
  });

  it('Search tenants by partial name', () => {
    cy.searchResource('Marie');
    cy.contains(tenants[1].name).should('be.visible');
    cy.contains(tenants[0].name).should('not.exist');
    cy.searchResource('');
  });

  it('Clear search shows all tenants', () => {
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  it('Search properties by full name', () => {
    cy.navAppMenu('properties');
    cy.searchResource(properties[0].name);
    cy.contains(properties[0].name).should('be.visible');
    cy.contains(properties[1].name).should('not.exist');
    cy.searchResource('');
  });

  it('Search properties by partial name', () => {
    cy.searchResource('Lyon');
    cy.contains(properties[1].name).should('be.visible');
    cy.contains(properties[0].name).should('not.exist');
    cy.searchResource('');
  });

  it('Clear search shows all properties', () => {
    cy.contains(properties[0].name).should('be.visible');
    cy.contains(properties[1].name).should('be.visible');
    cy.contains(properties[2].name).should('be.visible');
  });

  it('Search with no results shows empty', () => {
    cy.searchResource('zzzznonexistent');
    cy.contains(tenants[0].name).should('not.exist');
    cy.contains(tenants[1].name).should('not.exist');
    cy.searchResource('');
  });

  after(() => {
    cy.signOut();
  });
});
