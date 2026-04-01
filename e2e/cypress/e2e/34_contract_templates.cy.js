import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Contract/Lease Templates', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
  });

  it('Navigate to contract detail', () => {
    cy.navOrgMenu('contracts');
    cy.get('[data-cy=contractsPage]').should('exist');
    cy.contains(contract369.name).click();
  });

  it('Contract info tab shows name and description', () => {
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('input[name=name]').should('have.value', contract369.name);
    cy.get('textarea[name=description]').should('have.value', contract369.description);
  });

  it('Templates tab shows created templates', () => {
    cy.get('[data-cy=tabContractTemplates]').click();
    cy.contains('Bail').should('be.visible');
  });

  it('Add text template button exists', () => {
    cy.get('[data-cy=addTextDocument]').should('be.visible');
  });

  it('Add file descriptor button exists', () => {
    cy.get('[data-cy=addFileDescriptor]').should('be.visible');
  });

  it('Click text template opens rich text editor', () => {
    cy.contains('Bail').click();
    cy.get('.ProseMirror').should('be.visible');
  });

  it('Close rich text editor', () => {
    cy.get('[data-cy=close]').click();
  });

  it('Edit contract description', () => {
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('textarea[name=description]').clear().type('Updated description');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Description edit persists', () => {
    cy.navOrgMenu('contracts');
    cy.contains(contract369.name).click();
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('textarea[name=description]').should('have.value', 'Updated description');
  });

  it('Contract switch is active', () => {
    cy.navOrgMenu('contracts');
    cy.get('button[role=switch]').should('have.attr', 'data-state', 'checked');
  });

  it('Toggle contract inactive', () => {
    cy.get('button[role=switch]').click();
    cy.get('button[role=switch]').should('have.attr', 'data-state', 'unchecked');
  });

  it('Toggle contract active again', () => {
    cy.get('button[role=switch]').click();
    cy.get('button[role=switch]').should('have.attr', 'data-state', 'checked');
  });

  after(() => {
    cy.signOut();
  });
});
