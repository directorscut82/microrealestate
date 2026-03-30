import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Contract/Lease Management', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  const t = i18n.getFixedT('fr-FR');

  // Test 29
  it('Create contract from stepper - name field', () => {
    cy.get('[data-cy=shortcutCreateContract]').click();
    cy.get('input[name=name]').type(contract369.name);
    cy.get('[data-cy=submitContract]').click();
    cy.contains(contract369.name);
  });

  // Test 30
  it('Set contract description, timeRange, numberOfTerms', () => {
    cy.get('textarea[name=description]').type(contract369.description);
    cy.selectByLabel('timeRange', t(contract369.timeRange));
    cy.get('input[name=numberOfTerms]').type(contract369.numberOfTerms);
    cy.get('[data-cy=submit]').click();
  });

  // Test 31
  it('Add text template document to contract', () => {
    const textTemplate = contract369.templates.find(t => t.type === 'text');
    if (textTemplate) {
      cy.get('[data-cy=addTextDocument]').click();
      cy.get('input[name=title]').clear().type(textTemplate.title);
      cy.get('.ProseMirror').type(textTemplate.content);
      cy.get('[data-cy=close]').click();
    }
  });

  // Test 32
  it('Add file descriptor template to contract', () => {
    const fileTemplate = contract369.templates.find(t => t.type === 'fileDescriptor');
    if (fileTemplate) {
      cy.get('[data-cy=addFileDescriptor]').click();
      cy.get('input[name=name]').type(fileTemplate.title);
      cy.get('input[name=description]').type(fileTemplate.description);
      if (fileTemplate.hasExpiryDate) {
        cy.get('div:has(>input[name=hasExpiryDate]) > button, #hasExpiryDate').first().click();
      }
      if (fileTemplate.required) {
        cy.get('[data-cy=fileRequired]').click();
      }
      cy.get('[data-cy=submitFileDescriptor]').click();
    }
  });

  // Test 33
  it('Complete contract stepper', () => {
    cy.get('[data-cy=submit]').click();
  });

  // Test 34
  it('View contract templates tab', () => {
    cy.get('[data-cy=tabContractTemplates]').click();
    contract369.templates.forEach((template) => {
      cy.get('[data-cy=contractPage]').contains(template.title).should('be.visible');
    });
  });

  // Test 35
  it('View contract info tab', () => {
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('input[name=name]').should('have.value', contract369.name);
  });

  // Test 36
  it('Contract info shows correct values', () => {
    cy.get('textarea[name=description]').should('have.text', contract369.description);
    cy.get('input[name=numberOfTerms]').should('have.value', contract369.numberOfTerms);
  });

  // Test 37
  it('Navigate to dashboard after contract creation', () => {
    cy.navAppMenu('dashboard');
    cy.checkPage('dashboard');
  });

  // Test 38
  it('Delete contract', () => {
    cy.navOrgMenu('contracts');
    cy.openResource(contract369.name);
    cy.removeResource();
    cy.contains(contract369.name).should('not.exist');
  });

  after(() => {
    cy.signOut();
  });
});
