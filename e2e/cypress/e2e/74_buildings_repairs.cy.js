import i18n from '../support/i18n';
import buildings from '../fixtures/buildings.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

const t = i18n.getFixedT('fr-FR');
const b1 = buildings[0];

describe('Building Repairs & Contractors', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  after(() => {
    cy.signOut();
  });

  it('Test 74.01: Create building and navigate to Repairs tab', () => {
    cy.navAppMenu('buildings');
    cy.contains('button', t('Add a building')).click();
    cy.get('input[name=name]').clear().type(b1.name);
    cy.get('input[name=atakPrefix]').clear().type(b1.atakPrefix);
    cy.intercept('POST', '**/buildings').as('createBuilding');
    cy.get('[data-cy=submitBuilding]').click();
    cy.wait('@createBuilding');
    cy.url({ timeout: 10000 }).should('include', '/buildings/');
    cy.get('[data-cy=repairsTab]').click();
  });

  // --- Contractors ---

  it('Test 74.02: Verify empty contractors', () => {
    cy.contains(t('No contractors found')).should('be.visible');
  });

  it('Test 74.03: Click Add Contractor', () => {
    cy.get('[data-cy=addContractor]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=name]').should('be.visible');
  });

  it('Test 74.04: Submit empty - validation error', () => {
    cy.get('[data-cy=submitContractor]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Test 74.05: Fill and submit contractor', () => {
    cy.get('input[name=name]').clear().type('Jean Plombier');
    cy.get('input[name=company]').clear().type('PlombPro');
    cy.selectByLabel(t('Specialty'), t('plumber'));
    cy.get('input[name=phone]').clear().type('0612345678');
    cy.get('input[name=email]').clear().type('jean@plomb.fr');
    cy.intercept('POST', '**/contractors').as('addContractor');
    cy.get('[data-cy=submitContractor]').click();
    cy.wait('@addContractor');
  });

  it('Test 74.06: Verify contractor in table', () => {
    cy.contains('td', 'Jean Plombier').should('be.visible');
    cy.contains('td', 'PlombPro').should('be.visible');
    cy.contains('td', '0612345678').should('be.visible');
  });

  it('Test 74.07: Add second contractor', () => {
    cy.get('[data-cy=addContractor]').click();
    cy.get('input[name=name]').clear().type('Marie Électrique');
    cy.selectByLabel(t('Specialty'), t('electrician'));
    cy.get('input[name=phone]').clear().type('0698765432');
    cy.intercept('POST', '**/contractors').as('addContractor2');
    cy.get('[data-cy=submitContractor]').click();
    cy.wait('@addContractor2');
  });

  it('Test 74.08: Verify two contractors', () => {
    cy.contains('td', 'Jean Plombier').should('be.visible');
    cy.contains('td', 'Marie Électrique').should('be.visible');
  });

  it('Test 74.09: Edit first contractor - change phone', () => {
    cy.contains('td', 'Jean Plombier')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=phone]').clear().type('0611111111');
    cy.intercept('PATCH', '**/contractors/**').as('updateContractor');
    cy.get('[data-cy=submitContractor]').click();
    cy.wait('@updateContractor');
  });

  it('Test 74.10: Verify updated phone', () => {
    cy.contains('td', '0611111111').should('be.visible');
  });

  it('Test 74.11: Delete second contractor', () => {
    cy.contains('td', 'Marie Électrique')
      .parent('tr')
      .find('button')
      .last()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.intercept('DELETE', '**/contractors/**').as('deleteContractor');
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteContractor');
  });

  it('Test 74.12: Verify one contractor left', () => {
    cy.contains('td', 'Jean Plombier').should('be.visible');
    cy.contains('td', 'Marie Électrique').should('not.exist');
  });

  // --- Repairs ---

  it('Test 74.13: Verify empty repairs', () => {
    cy.contains(t('No repairs found')).should('be.visible');
  });

  it('Test 74.14: Click Add Repair', () => {
    cy.get('[data-cy=addRepair]').click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=title]').should('be.visible');
  });

  it('Test 74.15: Submit empty - validation error', () => {
    cy.get('[data-cy=submitRepair]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Test 74.16: Fill and submit repair', () => {
    cy.get('input[name=title]').clear().type('Fuite tuyau 3ème');
    cy.get('textarea[name=description]').type('Fuite dans salle de bain');
    cy.selectByLabel(t('Category'), t('plumbing'));
    cy.selectByLabel(t('Status'), t('scheduled'));
    cy.selectByLabel(t('Urgency'), t('emergency'));
    cy.get('input[name=estimatedCost]').clear().type('500');
    cy.intercept('POST', '**/repairs').as('addRepair');
    cy.get('[data-cy=submitRepair]').click();
    cy.wait('@addRepair');
  });

  it('Test 74.17: Verify repair in table', () => {
    cy.contains('td', 'Fuite tuyau 3ème').should('be.visible');
  });

  it('Test 74.18: Add second repair', () => {
    cy.get('[data-cy=addRepair]').click();
    cy.get('input[name=title]').clear().type('Panne ascenseur');
    cy.selectByLabel(t('Category'), t('elevator'));
    cy.selectByLabel(t('Status'), t('in_progress'));
    cy.selectByLabel(t('Urgency'), t('normal'));
    cy.get('input[name=estimatedCost]').clear().type('2000');
    cy.intercept('POST', '**/repairs').as('addRepair2');
    cy.get('[data-cy=submitRepair]').click();
    cy.wait('@addRepair2');
  });

  it('Test 74.19: Verify two repairs', () => {
    cy.contains('td', 'Fuite tuyau 3ème').should('be.visible');
    cy.contains('td', 'Panne ascenseur').should('be.visible');
  });

  it('Test 74.20: Edit first repair - change status to completed', () => {
    cy.contains('td', 'Fuite tuyau 3ème')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.selectByLabel(t('Status'), t('completed'));
    cy.get('input[name=actualCost]').clear().type('450');
    cy.intercept('PATCH', '**/repairs/**').as('updateRepair');
    cy.get('[data-cy=submitRepair]').click();
    cy.wait('@updateRepair');
  });

  it('Test 74.21: Delete second repair', () => {
    cy.contains('td', 'Panne ascenseur')
      .parent('tr')
      .find('button')
      .last()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.intercept('DELETE', '**/repairs/**').as('deleteRepair');
    cy.get('[role=dialog]').contains('button', t('Continue')).click();
    cy.wait('@deleteRepair');
  });

  it('Test 74.22: Verify one repair remains', () => {
    cy.contains('td', 'Fuite tuyau 3ème').should('be.visible');
    cy.contains('td', 'Panne ascenseur').should('not.exist');
  });

  it('Test 74.23: Verify repair fields persist on edit', () => {
    cy.contains('td', 'Fuite tuyau 3ème')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=title]').should('have.value', 'Fuite tuyau 3ème');
    cy.get('textarea[name=description]').should('have.value', 'Fuite dans salle de bain');
    cy.get('input[name=estimatedCost]').should('have.value', '500');
    cy.get('input[name=actualCost]').should('have.value', '450');
    cy.get('body').type('{esc}');
  });

  it('Test 74.24: Add repair with low urgency', () => {
    cy.get('[data-cy=addRepair]').click();
    cy.get('input[name=title]').clear().type('Peinture couloir');
    cy.selectByLabel(t('Category'), t('painting'));
    cy.selectByLabel(t('Status'), t('scheduled'));
    cy.selectByLabel(t('Urgency'), t('low'));
    cy.get('input[name=estimatedCost]').clear().type('300');
    cy.get('textarea[name=notes]').type('Couloir 2ème étage');
    cy.intercept('POST', '**/repairs').as('addRepair3');
    cy.get('[data-cy=submitRepair]').click();
    cy.wait('@addRepair3');
  });

  it('Test 74.25: Verify two repairs total', () => {
    cy.contains('td', 'Fuite tuyau 3ème').should('be.visible');
    cy.contains('td', 'Peinture couloir').should('be.visible');
  });

  it('Test 74.26: Add heating category repair', () => {
    cy.get('[data-cy=addRepair]').click();
    cy.get('input[name=title]').clear().type('Entretien chaudière');
    cy.selectByLabel(t('Category'), t('heating'));
    cy.selectByLabel(t('Status'), t('scheduled'));
    cy.selectByLabel(t('Urgency'), t('normal'));
    cy.get('input[name=estimatedCost]').clear().type('150');
    cy.intercept('POST', '**/repairs').as('addRepair4');
    cy.get('[data-cy=submitRepair]').click();
    cy.wait('@addRepair4');
  });

  it('Test 74.27: Verify three repairs total', () => {
    cy.get('table').first().find('tbody tr').should('have.length.at.least', 3);
  });

  it('Test 74.28: Add contractor with taxId and notes', () => {
    cy.get('[data-cy=addContractor]').click();
    cy.get('input[name=name]').clear().type('Pierre Peintre');
    cy.selectByLabel(t('Specialty'), t('painter'));
    cy.get('input[name=taxId]').clear().type('999888777');
    cy.get('textarea[name=notes]').type('Disponible weekends');
    cy.intercept('POST', '**/contractors').as('addContractor3');
    cy.get('[data-cy=submitContractor]').click();
    cy.wait('@addContractor3');
  });

  it('Test 74.29: Verify contractor notes persist', () => {
    cy.contains('td', 'Pierre Peintre')
      .parent('tr')
      .find('button')
      .first()
      .click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=taxId]').should('have.value', '999888777');
    cy.get('textarea[name=notes]').should('have.value', 'Disponible weekends');
    cy.get('body').type('{esc}');
  });
});
