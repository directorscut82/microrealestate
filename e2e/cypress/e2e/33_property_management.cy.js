import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Property Management', () => {
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

  it('Properties list shows both properties', () => {
    cy.navAppMenu('properties');
    cy.get('[data-cy=propertiesPage]').should('exist');
    cy.contains(properties[0].name).should('be.visible');
    cy.contains(properties[1].name).should('be.visible');
  });

  it('Edit property rent amount', () => {
    cy.contains(properties[1].name).click();
    cy.get('input[name=rent]').clear().type('250');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Rent change persists after navigation', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[1].name).click();
    cy.get('input[name=rent]').should('have.value', '250');
  });

  it('Edit property address', () => {
    cy.get('input[name="address.city"]').clear().type('Bordeaux');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Address change persists', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[1].name).click();
    cy.get('input[name="address.city"]').should('have.value', 'Bordeaux');
  });

  it('Property with tenant shows occupant', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Property without tenant shows not rented', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[1].name).click();
    cy.contains(t('Property not rented so far')).should('be.visible');
  });

  it('Search properties by name', () => {
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

  it('Both properties visible after clearing search', () => {
    cy.contains(properties[0].name).should('be.visible');
    cy.contains(properties[1].name).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
