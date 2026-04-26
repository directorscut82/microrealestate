import i18n from '../support/i18n';
import buildings from '../fixtures/buildings.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

const t = i18n.getFixedT('fr-FR');
const b1 = buildings[0];

describe('Building Unit Management', () => {
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

  it('Test 72.01: Create building via UI', () => {
    cy.navAppMenu('buildings');
    cy.contains('button', t('Add a building')).click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=name]').clear().type(b1.name);
    cy.get('input[name=atakPrefix]').clear().type(b1.atakPrefix);
    cy.intercept('POST', '**/buildings').as('createBuilding');
    cy.get('[data-cy=submitBuilding]').click();
    cy.wait('@createBuilding');
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
  });

  it('Test 72.02: Navigate to Units tab', () => {
    cy.get('[data-cy=unitsTab]').click();
  });

  it('Test 72.03: Verify empty state', () => {
    cy.contains(t('No units added yet')).should('be.visible');
  });

  it('Test 72.04: Click Add Unit button', () => {
    cy.get('[data-cy=addUnit]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=atakNumber]').should('be.visible');
  });

  it('Test 72.05: Submit empty ATAK - validation error', () => {
    cy.get('[role=dialog]').contains('button', t('Add')).click();
    cy.get('.text-destructive').should('exist');
  });

  it('Test 72.06: Fill first unit - ATAK, floor, surface, thousandths', () => {
    cy.get('input[name=atakNumber]').clear().type('01117260169');
    cy.get('input[name=floor]').clear().type('3');
    cy.get('input[name=surface]').clear().type('72');
    cy.get('input[name=generalThousandths]').clear().type('150');
  });

  it('Test 72.07: Submit unit', () => {
    cy.intercept('POST', '**/units').as('addUnit');
    cy.get('[role=dialog]').contains('button', t('Add')).click();
    cy.wait('@addUnit');
    cy.get('[role=dialog]').should('not.exist');
  });

  it('Test 72.08: Verify ATAK in table', () => {
    cy.contains('td', '01117260169').should('be.visible');
  });

  it('Test 72.09: Verify floor in table', () => {
    cy.contains('td', '01117260169')
      .parent('tr')
      .contains('td', '3')
      .should('exist');
  });

  it('Test 72.10: Verify surface in table', () => {
    cy.contains('td', '01117260169')
      .parent('tr')
      .contains('td', '72')
      .should('exist');
  });

  it('Test 72.11: Add second unit', () => {
    cy.get('[data-cy=addUnit]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=atakNumber]').clear().type('01117260177');
    cy.get('input[name=floor]').clear().type('1');
    cy.get('input[name=surface]').clear().type('37.2');
    cy.get('input[name=generalThousandths]').clear().type('85');
    cy.intercept('POST', '**/units').as('addUnit2');
    cy.get('[role=dialog]').contains('button', t('Add')).click();
    cy.wait('@addUnit2');
  });

  it('Test 72.12: Verify two units in table', () => {
    cy.contains('td', '01117260169').should('be.visible');
    cy.contains('td', '01117260177').should('be.visible');
  });

  it('Test 72.13: Edit first unit - change surface to 75', () => {
    cy.contains('td', '01117260169')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=surface]').clear().type('75');
    cy.intercept('PATCH', '**/units/**').as('updateUnit');
    cy.get('[role=dialog]').contains('button', t('Update')).click();
    cy.wait('@updateUnit');
  });

  it('Test 72.14: Verify updated surface', () => {
    cy.contains('td', '01117260169')
      .parent('tr')
      .contains('td', '75')
      .should('exist');
  });

  it('Test 72.15: Try adding duplicate ATAK - expect error', () => {
    cy.get('[data-cy=addUnit]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=atakNumber]').clear().type('01117260169');
    cy.get('input[name=surface]').clear().type('50');
    cy.get('[role=dialog]').contains('button', t('Add')).click();
    cy.get('ol.toaster > li').should('exist');
    cy.get('body').type('{esc}');
  });

  it('Test 72.16: Delete second unit', () => {
    cy.contains('td', '01117260177')
      .parent('tr')
      .find('button')
      .last()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.intercept('DELETE', '**/units/**').as('deleteUnit');
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteUnit');
  });

  it('Test 72.17: Verify only one unit remains', () => {
    cy.contains('td', '01117260169').should('be.visible');
    cy.contains('td', '01117260177').should('not.exist');
  });

  it('Test 72.18: Add unit with all thousandths', () => {
    cy.get('[data-cy=addUnit]').click();
    cy.get('input[name=atakNumber]').clear().type('01117260180');
    cy.get('input[name=floor]').clear().type('4');
    cy.get('input[name=surface]').clear().type('55');
    cy.get('input[name=generalThousandths]').clear().type('120');
    cy.get('input[name=heatingThousandths]').clear().type('200');
    cy.get('input[name=elevatorThousandths]').clear().type('130');
    cy.intercept('POST', '**/units').as('addUnit3');
    cy.get('[role=dialog]').contains('button', t('Add')).click();
    cy.wait('@addUnit3');
  });

  it('Test 72.19: Verify thousandths on edit', () => {
    cy.contains('td', '01117260180')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=generalThousandths]').should('have.value', '120');
    cy.get('input[name=heatingThousandths]').should('have.value', '200');
    cy.get('input[name=elevatorThousandths]').should('have.value', '130');
    cy.get('body').type('{esc}');
  });

  it('Test 72.20: Add unit with label', () => {
    cy.get('[data-cy=addUnit]').click();
    cy.get('input[name=atakNumber]').clear().type('01117260195');
    cy.get('input[name=unitLabel]').clear().type('Apt 3A');
    cy.get('input[name=surface]').clear().type('40');
    cy.intercept('POST', '**/units').as('addUnit4');
    cy.get('[role=dialog]').contains('button', t('Add')).click();
    cy.wait('@addUnit4');
  });

  it('Test 72.21: Toggle isManaged OFF for a unit', () => {
    cy.contains('td', '01117260195')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('#isManaged').click();
    cy.intercept('PATCH', '**/units/**').as('updateUnit2');
    cy.get('[role=dialog]').contains('button', t('Update')).click();
    cy.wait('@updateUnit2');
  });

  it('Test 72.22: Verify ATAK prefix is disabled on overview tab', () => {
    cy.get('[data-cy=overviewTab]').click();
    cy.get('input[name=atakPrefix]').should('be.disabled');
    cy.contains(t('ATAK prefix cannot be changed because this building has units')).should('be.visible');
  });

  it('Test 72.23: Return to units tab, verify all 3 units', () => {
    cy.get('[data-cy=unitsTab]').click();
    cy.contains('td', '01117260169').should('be.visible');
    cy.contains('td', '01117260180').should('be.visible');
    cy.contains('td', '01117260195').should('be.visible');
  });

  it('Test 72.24: Edit unit floor number', () => {
    cy.contains('td', '01117260169')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=floor]').clear().type('5');
    cy.intercept('PATCH', '**/units/**').as('updateUnit3');
    cy.get('[role=dialog]').contains('button', t('Update')).click();
    cy.wait('@updateUnit3');
  });

  it('Test 72.25: Verify updated floor', () => {
    cy.contains('td', '01117260169')
      .parent('tr')
      .contains('td', '5')
      .should('exist');
  });
});
