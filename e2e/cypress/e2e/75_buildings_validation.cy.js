import i18n from '../support/i18n';
import buildings from '../fixtures/buildings.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

const t = i18n.getFixedT('fr-FR');
const b1 = buildings[0];

describe('Building Validation & Edge Cases', () => {
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

  // --- Validation Edge Cases ---

  it('Test 75.01: Navigate to buildings page', () => {
    cy.navAppMenu('buildings');
    cy.get('[data-cy=buildingsPage]').should('exist');
  });

  it('Test 75.02: Create building with minimum fields', () => {
    cy.contains('button', t('Add a building')).click();
    cy.get('input[name=name]').clear().type('Minimal');
    cy.get('input[name=atakPrefix]').clear().type('100001');
    cy.intercept('POST', '**/buildings').as('create');
    cy.get('[data-cy=submitBuilding]').click();
    cy.wait('@create');
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
  });

  it('Test 75.03: Verify empty optional fields', () => {
    cy.get('input[name=description]').should('have.value', '');
    cy.get('input[name=yearBuilt]').should('have.value', '');
    cy.get('input[name=totalFloors]').should('have.value', '');
    cy.get('input[name="address.street1"]').should('have.value', '');
    cy.get('input[name="manager.name"]').should('have.value', '');
  });

  it('Test 75.04: Fill year built with 0 floors', () => {
    cy.get('input[name=totalFloors]').clear().type('0');
    cy.intercept('PATCH', '**/buildings/**').as('update');
    cy.get('[data-cy=submit]').click();
    cy.wait('@update');
    cy.contains(t('Building updated')).should('be.visible');
  });

  it('Test 75.05: Toggle elevator ON then OFF', () => {
    cy.get('#hasElevator').click();
    cy.get('#hasElevator').click();
    cy.intercept('PATCH', '**/buildings/**').as('update');
    cy.get('[data-cy=submit]').click();
    cy.wait('@update');
  });

  it('Test 75.06: Toggle heating ON, select type, toggle OFF', () => {
    cy.get('#hasCentralHeating').click();
    cy.contains('label', t('Heating Type')).should('be.visible');
    cy.contains('label', t('Heating Type'))
      .parent()
      .find('button[role="combobox"]')
      .first()
      .click();
    cy.contains('[role="option"]', t('Central Gas')).click();
    cy.get('#hasCentralHeating').click();
    cy.contains('label', t('Heating Type')).should('not.exist');
    cy.intercept('PATCH', '**/buildings/**').as('update');
    cy.get('[data-cy=submit]').click();
    cy.wait('@update');
  });

  it('Test 75.07: Building with special characters', () => {
    cy.get('input[name=name]').clear().type('Κτίριο Αθηνών — ℃ test & «résumé»');
    cy.intercept('PATCH', '**/buildings/**').as('update');
    cy.get('[data-cy=submit]').click();
    cy.wait('@update');
    cy.get('input[name=name]').should('have.value', 'Κτίριο Αθηνών — ℃ test & «résumé»');
  });

  // --- Duplicate Prevention ---

  it('Test 75.08: Navigate back, try duplicate ATAK', () => {
    cy.navAppMenu('buildings');
    cy.contains('button', t('Add a building')).click();
    cy.get('input[name=name]').clear().type('Duplicate');
    cy.get('input[name=atakPrefix]').clear().type('100001');
    cy.get('[data-cy=submitBuilding]').click();
    cy.get('ol.toaster > li').should('exist');
    cy.get('body').type('{esc}');
  });

  it('Test 75.09: Create second building for deletion test', () => {
    cy.contains('button', t('Add a building')).click();
    cy.get('input[name=name]').clear().type('À supprimer');
    cy.get('input[name=atakPrefix]').clear().type('200002');
    cy.intercept('POST', '**/buildings').as('create2');
    cy.get('[data-cy=submitBuilding]').click();
    cy.wait('@create2');
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
  });

  // --- Unit & Deletion Integrity ---

  it('Test 75.10: Add unit to building', () => {
    cy.get('[data-cy=unitsTab]').click();
    cy.get('[data-cy=addUnit]').click();
    cy.get('input[name=atakNumber]').clear().type('20000260001');
    cy.get('input[name=surface]').clear().type('50');
    cy.intercept('POST', '**/units').as('addUnit');
    cy.get('[role=dialog]').contains('button', t('Add')).click();
    cy.wait('@addUnit');
  });

  it('Test 75.11: Delete unit', () => {
    cy.contains('td', '20000260001')
      .parent('tr')
      .find('button')
      .last()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.intercept('DELETE', '**/units/**').as('deleteUnit');
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteUnit');
  });

  it('Test 75.12: Delete building without tenants - should succeed', () => {
    cy.intercept('DELETE', '**/buildings/**').as('deleteBuilding');
    cy.get('[data-cy=removeResourceButton]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteBuilding');
    cy.get('[data-cy=buildingsPage]').should('exist');
  });

  it('Test 75.13: Create building with multiple units for bulk test', () => {
    cy.contains('button', t('Add a building')).click();
    cy.get('input[name=name]').clear().type('Multi-unité');
    cy.get('input[name=atakPrefix]').clear().type('300003');
    cy.intercept('POST', '**/buildings').as('create3');
    cy.get('[data-cy=submitBuilding]').click();
    cy.wait('@create3');
    cy.get('[data-cy=unitsTab]').click();

    const units = ['30000360001', '30000360002', '30000360003'];
    units.forEach((atak) => {
      cy.get('[data-cy=addUnit]').click();
      cy.get('input[name=atakNumber]').clear().type(atak);
      cy.get('input[name=surface]').clear().type('45');
      cy.intercept('POST', '**/units').as(`addUnit${atak}`);
      cy.get('[role=dialog]').contains('button', t('Add')).click();
      cy.wait(`@addUnit${atak}`);
    });
  });

  it('Test 75.14: Verify 3 units in table', () => {
    cy.get('table tbody tr').should('have.length', 3);
  });

  it('Test 75.15: Delete multi-unit building', () => {
    cy.intercept('DELETE', '**/buildings/**').as('deleteBuilding');
    cy.get('[data-cy=removeResourceButton]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteBuilding');
    cy.get('[data-cy=buildingsPage]').should('exist');
  });

  // --- Search & Filter ---

  it('Test 75.16: Create 3 buildings for search test', () => {
    const testBuildings = [
      { name: 'Résidence Alpha', atak: '400004' },
      { name: 'Tour Beta', atak: '500005' },
      { name: 'Immeuble Gamma', atak: '600006' }
    ];

    testBuildings.forEach(({ name, atak }) => {
      cy.contains('button', t('Add a building')).click();
      cy.get('input[name=name]').clear().type(name);
      cy.get('input[name=atakPrefix]').clear().type(atak);
      cy.intercept('POST', '**/buildings').as(`create${atak}`);
      cy.get('[data-cy=submitBuilding]').click();
      cy.wait(`@create${atak}`);
      cy.navAppMenu('buildings');
    });
  });

  it('Test 75.17: Search by building name', () => {
    cy.get('[data-cy=globalSearchField]').click();
    cy.get('[data-cy=globalSearchField]').clear().type('Alpha');
    cy.wait(500);
    cy.get('[data-cy=buildingsPage]').within(() => {
      cy.get('[data-cy=openResourceButton]')
        .should('have.length', 1);
    });
  });

  it('Test 75.18: Clear search shows all', () => {
    cy.get('[data-cy=globalSearchField]').clear();
    cy.contains('Résidence Alpha').should('be.visible');
    cy.contains('Tour Beta').should('be.visible');
    cy.contains('Immeuble Gamma').should('be.visible');
  });

  // --- Tab Navigation ---

  it('Test 75.19: Open building and navigate all 4 tabs', () => {
    cy.contains('[data-cy=openResourceButton]', 'Résidence Alpha').click();
    cy.url({ timeout: 10000 }).should('include', '/buildings/');

    cy.get('[data-cy=overviewTab]').click();
    cy.get('input[name=name]').should('be.visible');

    cy.get('[data-cy=unitsTab]').click();
    cy.get('[data-cy=addUnit]').should('be.visible');

    cy.get('[data-cy=expensesTab]').click();
    cy.get('[data-cy=addExpense]').should('be.visible');

    cy.get('[data-cy=repairsTab]').click();
    cy.get('[data-cy=addRepair]').should('be.visible');
    cy.get('[data-cy=addContractor]').should('be.visible');
  });

  it('Test 75.20: Switch tabs rapidly', () => {
    cy.get('[data-cy=overviewTab]').click();
    cy.get('[data-cy=unitsTab]').click();
    cy.get('[data-cy=expensesTab]').click();
    cy.get('[data-cy=repairsTab]').click();
    cy.get('[data-cy=overviewTab]').click();
    cy.get('input[name=name]').should('have.value', 'Résidence Alpha');
  });

  it('Test 75.21: Add data in each tab', () => {
    cy.get('[data-cy=unitsTab]').click();
    cy.get('[data-cy=addUnit]').click();
    cy.get('input[name=atakNumber]').clear().type('40000460001');
    cy.get('input[name=surface]').clear().type('60');
    cy.intercept('POST', '**/units').as('addUnit');
    cy.get('[role=dialog]').contains('button', t('Add')).click();
    cy.wait('@addUnit');

    cy.get('[data-cy=expensesTab]').click();
    cy.get('[data-cy=addExpense]').click();
    cy.get('input[name=name]').clear().type('Test Expense');
    cy.selectByLabel(t('Type'), t('Other'));
    cy.get('input[name=amount]').clear().type('100');
    cy.selectByLabel(t('Allocation Method'), t('Equal'));
    cy.intercept('POST', '**/expenses').as('addExpense');
    cy.get('[role=dialog]').find('button').contains(t('Add')).click();
    cy.wait('@addExpense');

    cy.get('[data-cy=repairsTab]').click();
    cy.get('[data-cy=addContractor]').click();
    cy.get('input[name=name]').clear().type('Test Contractor');
    cy.selectByLabel(t('Specialty'), t('general'));
    cy.intercept('POST', '**/contractors').as('addContractor');
    cy.get('[data-cy=submitContractor]').click();
    cy.wait('@addContractor');
  });

  it('Test 75.22: Verify data persists across tab switches', () => {
    cy.get('[data-cy=unitsTab]').click();
    cy.contains('td', '40000460001').should('be.visible');

    cy.get('[data-cy=expensesTab]').click();
    cy.contains('td', 'Test Expense').should('be.visible');

    cy.get('[data-cy=repairsTab]').click();
    cy.contains('td', 'Test Contractor').should('be.visible');
  });

  it('Test 75.23: Navigate back to list', () => {
    cy.navAppMenu('buildings');
    cy.get('[data-cy=buildingsPage]').should('exist');
    cy.contains('Résidence Alpha').should('be.visible');
  });
});
