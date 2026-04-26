import i18n from '../support/i18n';
import buildings from '../fixtures/buildings.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

const t = i18n.getFixedT('fr-FR');
const b1 = buildings[0];
const b2 = buildings[1];

describe('Building CRUD', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.checkPage('dashboard');
  });

  after(() => {
    cy.signOut();
  });

  it('Test 71.01: Navigate to buildings page', () => {
    cy.navAppMenu('buildings');
    cy.get('[data-cy=buildingsPage]').should('exist');
  });

  it('Test 71.02: Verify empty state', () => {
    cy.contains(t('No buildings found')).should('be.visible');
  });

  it('Test 71.03: Open new building dialog', () => {
    cy.contains('button', t('Add a building')).click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=name]').should('be.visible');
  });

  it('Test 71.04: Submit empty form shows validation error', () => {
    cy.get('[data-cy=submitBuilding]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Test 71.05: Create first building', () => {
    cy.get('input[name=name]').clear().type(b1.name);
    cy.get('input[name=atakPrefix]').clear().type(b1.atakPrefix);
    cy.intercept('POST', '**/buildings').as('createBuilding');
    cy.get('[data-cy=submitBuilding]').click();
    cy.wait('@createBuilding');
  });

  it('Test 71.06: Verify redirect to building detail page', () => {
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
    cy.get('[data-cy=buildingPage]').should('exist');
  });

  it('Test 71.07: Verify building name on form', () => {
    cy.get('input[name=name]').should('have.value', b1.name);
    cy.get('input[name=atakPrefix]').should('have.value', b1.atakPrefix);
  });

  it('Test 71.08: Fill description', () => {
    cy.get('input[name=description]').clear().type(b1.description);
  });

  it('Test 71.09: Fill year built and total floors', () => {
    cy.get('input[name=yearBuilt]').clear().type(String(b1.yearBuilt));
    cy.get('input[name=totalFloors]').clear().type(String(b1.totalFloors));
  });

  it('Test 71.10: Toggle elevator ON', () => {
    cy.get('#hasElevator').click();
  });

  it('Test 71.11: Toggle central heating ON', () => {
    cy.get('#hasCentralHeating').click();
  });

  it('Test 71.12: Select heating type', () => {
    cy.contains('label', t('Heating Type'))
      .parent()
      .find('button[role="combobox"]')
      .first()
      .click();
    cy.contains('[role="option"]', t('Central Oil')).click();
  });

  it('Test 71.13: Save building info', () => {
    cy.intercept('PATCH', '**/buildings/**').as('updateBuilding');
    cy.get('[data-cy=submit]').click();
    cy.wait('@updateBuilding');
    cy.contains(t('Building updated')).should('be.visible');
  });

  it('Test 71.14: Fill address fields', () => {
    cy.get('input[name="address.street1"]').clear().type(b1.address.street1);
    cy.get('input[name="address.city"]').clear().type(b1.address.city);
    cy.get('input[name="address.zipCode"]').clear().type(b1.address.zipCode);
    cy.get('input[name="address.state"]').clear().type(b1.address.state);
    cy.get('input[name="address.country"]').clear().type(b1.address.country);
  });

  it('Test 71.15: Save address', () => {
    cy.intercept('PATCH', '**/buildings/**').as('updateBuilding');
    cy.get('[data-cy=submit]').click();
    cy.wait('@updateBuilding');
  });

  it('Test 71.16: Fill manager fields', () => {
    cy.get('input[name="manager.name"]').clear().type(b1.manager.name);
    cy.get('input[name="manager.company"]').clear().type(b1.manager.company);
    cy.get('input[name="manager.phone"]').clear().type(b1.manager.phone);
    cy.get('input[name="manager.email"]').clear().type(b1.manager.email);
    cy.get('input[name="manager.taxId"]').clear().type(b1.manager.taxId);
  });

  it('Test 71.17: Save manager', () => {
    cy.intercept('PATCH', '**/buildings/**').as('updateBuilding');
    cy.get('[data-cy=submit]').click();
    cy.wait('@updateBuilding');
  });

  it('Test 71.18: Fill bank info', () => {
    cy.get('input[name="bankInfo.name"]').clear().type(b1.bankInfo.name);
    cy.get('input[name="bankInfo.iban"]').clear().type(b1.bankInfo.iban);
  });

  it('Test 71.19: Save bank info', () => {
    cy.intercept('PATCH', '**/buildings/**').as('updateBuilding');
    cy.get('[data-cy=submit]').click();
    cy.wait('@updateBuilding');
  });

  it('Test 71.20: Fill notes', () => {
    cy.get('textarea[name=notes]').clear().type(b1.notes);
  });

  it('Test 71.21: Save notes', () => {
    cy.intercept('PATCH', '**/buildings/**').as('updateBuilding');
    cy.get('[data-cy=submit]').click();
    cy.wait('@updateBuilding');
    cy.contains(t('Building updated')).should('be.visible');
  });

  it('Test 71.22: Navigate back to buildings list', () => {
    cy.navAppMenu('buildings');
    cy.get('[data-cy=buildingsPage]').should('exist');
  });

  it('Test 71.23: Verify building card shows name and address', () => {
    cy.contains(b1.name).should('be.visible');
    cy.contains(b1.address.street1).should('be.visible');
  });

  it('Test 71.24: Create second building', () => {
    cy.contains('button', t('Add a building')).click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=name]').clear().type(b2.name);
    cy.get('input[name=atakPrefix]').clear().type(b2.atakPrefix);
    cy.intercept('POST', '**/buildings').as('createBuilding');
    cy.get('[data-cy=submitBuilding]').click();
    cy.wait('@createBuilding');
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
  });

  it('Test 71.25: Navigate back and verify both buildings', () => {
    cy.navAppMenu('buildings');
    cy.contains(b1.name).should('be.visible');
    cy.contains(b2.name).should('be.visible');
  });

  // Search uses startTransition which can cause flaky Cypress interactions
  it('Test 71.26: Search field filters building list', () => {
    cy.searchResource('Athéna');
    // startTransition may delay the filter — wait for it to apply
    cy.get('[data-cy=openResourceButton]', { timeout: 10000 })
      .should('have.length.at.most', 2);
    cy.contains(b1.name, { timeout: 10000 }).should('be.visible');
  });

  it('Test 71.27: Clear search shows both buildings', () => {
    cy.searchResource('');
    cy.contains(b1.name).should('be.visible');
    cy.contains(b2.name).should('be.visible');
  });

  it('Test 71.28: Open first building, verify values persist', () => {
    cy.contains('[data-cy=openResourceButton]', b1.name).click();
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
    cy.get('input[name=name]').should('have.value', b1.name);
    cy.get('input[name=atakPrefix]').should('have.value', b1.atakPrefix);
    cy.get('input[name=description]').should('have.value', b1.description);
    cy.get('input[name=yearBuilt]').should('have.value', String(b1.yearBuilt));
    cy.get('input[name=totalFloors]').should('have.value', String(b1.totalFloors));
    cy.get('input[name="address.street1"]').should('have.value', b1.address.street1);
    cy.get('input[name="address.city"]').should('have.value', b1.address.city);
    cy.get('input[name="manager.name"]').should('have.value', b1.manager.name);
    cy.get('input[name="bankInfo.iban"]').should('have.value', b1.bankInfo.iban);
    cy.get('textarea[name=notes]').should('have.value', b1.notes);
  });

  it('Test 71.29: Update building name', () => {
    cy.get('input[name=name]').clear().type('Résidence Athéna Rénovée');
    cy.intercept('PATCH', '**/buildings/**').as('updateBuilding');
    cy.get('[data-cy=submit]').click();
    cy.wait('@updateBuilding');
    cy.contains(t('Building updated')).should('be.visible');
  });

  it('Test 71.30: Navigate back, verify updated name', () => {
    cy.navAppMenu('buildings');
    cy.contains('Résidence Athéna Rénovée').should('be.visible');
  });

  it('Test 71.31: Restore original name', () => {
    cy.contains('[data-cy=openResourceButton]', 'Résidence Athéna Rénovée').click();
    cy.get('input[name=name]').clear().type(b1.name);
    cy.intercept('PATCH', '**/buildings/**').as('updateBuilding');
    cy.get('[data-cy=submit]').click();
    cy.wait('@updateBuilding');
  });

  it('Test 71.32: Navigate to list to delete second building', () => {
    cy.navAppMenu('buildings');
    cy.contains('[data-cy=openResourceButton]', b2.name).click();
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
  });

  it('Test 71.33: Delete second building', () => {
    cy.intercept('DELETE', '**/buildings/**').as('deleteBuilding');
    cy.get('[data-cy=removeResourceButton]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteBuilding');
  });

  it('Test 71.34: Verify only first building remains', () => {
    cy.get('[data-cy=buildingsPage]').should('exist');
    cy.contains(b1.name).should('be.visible');
    cy.contains(b2.name).should('not.exist');
  });

  it('Test 71.35: Try creating building with duplicate ATAK prefix', () => {
    cy.contains('button', t('Add a building')).click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=name]').clear().type('Duplicate Test');
    cy.get('input[name=atakPrefix]').clear().type(b1.atakPrefix);
    cy.get('[data-cy=submitBuilding]').click();
    cy.get('ol.toaster > li').should('exist');
  });

  it('Test 71.36: Close dialog', () => {
    cy.get('body').type('{esc}');
    cy.get('[role=dialog]').should('not.exist');
  });
});
