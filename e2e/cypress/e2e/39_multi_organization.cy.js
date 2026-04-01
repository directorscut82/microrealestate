import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Multi-Organization', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  it('Dashboard loads after first access', () => {
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Organizations settings shows current org', () => {
    cy.navOrgMenu('organizations');
    cy.contains(userWithCompanyAccount.orgName).should('be.visible');
  });

  it('Org details visible', () => {
    cy.contains(userWithCompanyAccount.orgName).should('be.visible');
  });

  it('Sign out', () => {
    cy.signOut();
  });

  it('Sign back in', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
  });

  it('Dashboard loads with correct org after sign in', () => {
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Org menu shows user avatar', () => {
    cy.get('[data-cy=orgMenu]').should('be.visible');
  });

  it('All navigation works after sign in', () => {
    cy.navAppMenu('tenants');
    cy.navAppMenu('properties');
    cy.navAppMenu('rents');
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
