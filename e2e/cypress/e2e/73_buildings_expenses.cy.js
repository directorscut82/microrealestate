import i18n from '../support/i18n';
import buildings from '../fixtures/buildings.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

const t = i18n.getFixedT('fr-FR');
const b1 = buildings[0];

describe('Building Expense Management', () => {
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

  it('Test 73.01: Create building and navigate to it', () => {
    cy.navAppMenu('buildings');
    cy.contains('button', t('Add a building')).click();
    cy.get('input[name=name]').clear().type(b1.name);
    cy.get('input[name=atakPrefix]').clear().type(b1.atakPrefix);
    cy.intercept('POST', '**/buildings').as('createBuilding');
    cy.get('[data-cy=submitBuilding]').click();
    cy.wait('@createBuilding');
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
  });

  it('Test 73.02: Navigate to Expenses tab', () => {
    cy.get('[data-cy=expensesTab]').click();
  });

  it('Test 73.03: Verify empty state', () => {
    cy.contains(t('No expenses added yet')).should('be.visible');
  });

  it('Test 73.04: Click Add Expense', () => {
    cy.get('[data-cy=addExpense]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=name]').should('be.visible');
  });

  it('Test 73.05: Submit empty - validation errors', () => {
    cy.get('[role=dialog]').find('button').contains(t('Add')).click();
    cy.get('.text-destructive').should('exist');
  });

  it('Test 73.06: Fill heating expense', () => {
    cy.get('input[name=name]').clear().type('Chauffage central');
    cy.selectByLabel(t('Type'), t('Heating'));
    cy.get('input[name=amount]').clear().type('250');
    cy.selectByLabel(t('Allocation Method'), t('General Thousandths'));
  });

  it('Test 73.07: Submit expense', () => {
    cy.intercept('POST', '**/expenses').as('addExpense');
    cy.get('[role=dialog]').find('button').contains(t('Add')).click();
    cy.wait('@addExpense');
    cy.get('[role=dialog]').should('not.exist');
  });

  it('Test 73.08: Verify name in table', () => {
    cy.contains('td', 'Chauffage central').should('be.visible');
  });

  it('Test 73.09: Verify recurring badge shows Yes', () => {
    cy.contains('td', 'Chauffage central')
      .parent('tr')
      .contains(t('Yes'))
      .should('exist');
  });

  it('Test 73.10: Add elevator expense', () => {
    cy.get('[data-cy=addExpense]').click();
    cy.get('input[name=name]').clear().type('Ascenseur');
    cy.selectByLabel(t('Type'), t('Elevator'));
    cy.get('input[name=amount]').clear().type('100');
    cy.selectByLabel(t('Allocation Method'), t('Elevator Thousandths'));
    cy.intercept('POST', '**/expenses').as('addExpense2');
    cy.get('[role=dialog]').find('button').contains(t('Add')).click();
    cy.wait('@addExpense2');
  });

  it('Test 73.11: Verify two expenses in table', () => {
    cy.contains('td', 'Chauffage central').should('be.visible');
    cy.contains('td', 'Ascenseur').should('be.visible');
  });

  it('Test 73.12: Add non-recurring expense', () => {
    cy.get('[data-cy=addExpense]').click();
    cy.get('input[name=name]').clear().type('Ravalement façade');
    cy.selectByLabel(t('Type'), t('Other'));
    cy.get('input[name=amount]').clear().type('5000');
    cy.selectByLabel(t('Allocation Method'), t('Equal'));
    cy.get('#isRecurring').click();
    cy.intercept('POST', '**/expenses').as('addExpense3');
    cy.get('[role=dialog]').find('button').contains(t('Add')).click();
    cy.wait('@addExpense3');
  });

  it('Test 73.13: Verify non-recurring shows No badge', () => {
    cy.contains('td', 'Ravalement façade')
      .parent('tr')
      .contains(t('No'))
      .should('exist');
  });

  it('Test 73.14: Edit first expense - change amount to 300', () => {
    cy.contains('td', 'Chauffage central')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=amount]').clear().type('300');
    cy.intercept('PATCH', '**/expenses/**').as('updateExpense');
    cy.get('[role=dialog]').find('button').contains(t('Update')).click();
    cy.wait('@updateExpense');
  });

  it('Test 73.15: Delete non-recurring expense', () => {
    cy.contains('td', 'Ravalement façade')
      .parent('tr')
      .find('button')
      .last()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.intercept('DELETE', '**/expenses/**').as('deleteExpense');
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteExpense');
  });

  it('Test 73.16: Verify two expenses remain', () => {
    cy.contains('td', 'Chauffage central').should('be.visible');
    cy.contains('td', 'Ascenseur').should('be.visible');
    cy.contains('td', 'Ravalement façade').should('not.exist');
  });

  it('Test 73.17: Add expense with notes', () => {
    cy.get('[data-cy=addExpense]').click();
    cy.get('input[name=name]').clear().type('Nettoyage');
    cy.selectByLabel(t('Type'), t('Cleaning'));
    cy.get('input[name=amount]').clear().type('80');
    cy.selectByLabel(t('Allocation Method'), t('Equal'));
    cy.get('textarea[name=notes]').type('Tous les mardis');
    cy.intercept('POST', '**/expenses').as('addExpense4');
    cy.get('[role=dialog]').find('button').contains(t('Add')).click();
    cy.wait('@addExpense4');
  });

  it('Test 73.18: Edit and verify notes persisted', () => {
    cy.contains('td', 'Nettoyage')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('textarea[name=notes]').should('have.value', 'Tous les mardis');
    cy.get('body').type('{esc}');
  });

  it('Test 73.19: Add insurance expense with by_surface allocation', () => {
    cy.get('[data-cy=addExpense]').click();
    cy.get('input[name=name]').clear().type('Assurance immeuble');
    cy.selectByLabel(t('Type'), t('Insurance'));
    cy.get('input[name=amount]').clear().type('1200');
    cy.selectByLabel(t('Allocation Method'), t('By Surface'));
    cy.intercept('POST', '**/expenses').as('addExpense5');
    cy.get('[role=dialog]').find('button').contains(t('Add')).click();
    cy.wait('@addExpense5');
  });

  it('Test 73.20: Verify four expenses total', () => {
    cy.get('table tbody tr').should('have.length', 4);
  });

  it('Test 73.21: Add fixed allocation expense', () => {
    cy.get('[data-cy=addExpense]').click();
    cy.get('input[name=name]').clear().type('Frais gestion');
    cy.selectByLabel(t('Type'), t('Management Fee'));
    cy.get('input[name=amount]').clear().type('50');
    cy.selectByLabel(t('Allocation Method'), t('Fixed'));
    cy.intercept('POST', '**/expenses').as('addExpense6');
    cy.get('[role=dialog]').find('button').contains(t('Add')).click();
    cy.wait('@addExpense6');
  });

  it('Test 73.22: Verify five expenses total', () => {
    cy.get('table tbody tr').should('have.length', 5);
  });
});
