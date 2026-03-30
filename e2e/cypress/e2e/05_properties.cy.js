import i18n from '../support/i18n';
import properties from '../fixtures/properties.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Property Management', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  const t = i18n.getFixedT('fr-FR');

  // Test 39
  it('Add property from stepper - name field', () => {
    cy.get('[data-cy=shortcutAddProperty]').click();
    cy.get('input[name=name]').type(properties[0].name);
    cy.get('[data-cy=submitProperty]').click();
    cy.contains(t('Property information'));
  });

  // Test 40
  it('Set property type via select', () => {
    cy.selectByLabel('type', t(properties[0].type.replace(/^./, properties[0].type[0].toUpperCase())));
  });

  // Test 41
  it('Set property rent', () => {
    cy.get('input[name=rent]').type(properties[0].rent);
  });

  // Test 42
  it('Set property description', () => {
    cy.get('input[name=description]').type(properties[0].description);
  });

  // Test 43
  it('Set property surface, phone, digicode', () => {
    cy.get('input[name=surface]').type(properties[0].surface);
    cy.get('input[name=phone]').type(properties[0].phone);
    cy.get('input[name=digicode]').type(properties[0].digiCode);
  });

  // Test 44
  it('Set property address', () => {
    const { street1, zipCode, city, state, country } = properties[0].address;
    cy.get('input[name="address.street1"]').type(street1);
    cy.get('input[name="address.zipCode"]').type(zipCode);
    cy.get('input[name="address.city"]').type(city);
    cy.get('input[name="address.state"]').type(state);
    cy.get('input[name="address.country"]').type(country);
  });

  // Test 45
  it('Save property', () => {
    cy.get('[data-cy=submit]').click();
  });

  // Test 46
  it('Property detail shows map', () => {
    cy.get('.pigeon-tiles-box').should('be.visible');
  });

  // Test 47
  it('Property appears in list', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');
    cy.contains(properties[0].description).should('be.visible');
  });

  // Test 48
  it('Property shows vacant status', () => {
    cy.contains(t('Vacant')).should('be.visible');
  });

  // Test 49
  it('Search property by name', () => {
    cy.searchResource(properties[0].name);
    cy.contains(properties[0].name).should('be.visible');
  });

  // Test 50
  it('Delete property', () => {
    cy.openResource(properties[0].name);
    cy.removeResource();
    cy.contains(t('No properties found'));
  });

  after(() => {
    cy.signOut();
  });
});
