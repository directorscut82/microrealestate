import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Access Control — Members', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  it('Navigate to access settings', () => {
    cy.navOrgMenu('access');
    cy.contains(userWithCompanyAccount.email).should('be.visible');
  });

  it('Current user shows as administrator', () => {
    cy.contains(t('administrator')).should('be.visible');
  });

  it('New collaborator button exists', () => {
    cy.contains(t('New collaborator')).should('be.visible');
  });

  it('Add collaborator dialog opens', () => {
    cy.contains(t('New collaborator')).click();
    cy.get('[role=dialog]').should('exist');
    cy.get('input[name=email]').should('exist');
  });

  it('Fill collaborator email and role', () => {
    cy.get('input[name=email]').type('collaborator@test.com');
    cy.selectByLabel(t('Role'), t('renter'));
  });

  it('Submit collaborator', () => {
    cy.contains('button', t('Add')).click();
  });

  it('Collaborator appears in list', () => {
    cy.contains('collaborator@test.com').should('be.visible');
  });

  it('New application button exists', () => {
    cy.contains(t('New application')).should('be.visible');
  });

  it('Application dialog opens', () => {
    cy.contains(t('New application')).click();
    cy.get('[role=dialog]').should('exist');
  });

  it('Close application dialog', () => {
    cy.get('body').type('{esc}');
  });

  after(() => {
    cy.signOut();
  });
});
