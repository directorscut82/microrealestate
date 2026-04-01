import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Landlord Settings', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  it('Navigate to landlord settings', () => {
    cy.navOrgMenu('landlord');
    cy.get('input[name=name]').should('exist');
  });

  it('Org name is displayed', () => {
    cy.get('input[name=name]').should('have.value', userWithCompanyAccount.orgName);
  });

  it('Change org name', () => {
    cy.get('input[name=name]').clear().type('Test Org Name');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Restore original org name', () => {
    cy.get('input[name=name]').clear().type(userWithCompanyAccount.orgName);
    cy.get('[data-cy=submit]').first().click();
  });

  it('Company info fields visible', () => {
    cy.get('input[name=company]').should('exist');
    cy.get('input[name=legalStructure]').should('exist');
    cy.get('input[name=ein]').should('exist');
    cy.get('input[name=capital]').should('exist');
  });

  it('Company name has correct value', () => {
    cy.get('input[name=company]').should('have.value', userWithCompanyAccount.company.name);
  });

  it('Edit legal representative', () => {
    cy.get('input[name=legalRepresentative]').clear().type('Updated Representative');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Legal representative edit persists', () => {
    cy.navAppMenu('dashboard');
    cy.navOrgMenu('landlord');
    cy.get('input[name=legalRepresentative]').should('have.value', 'Updated Representative');
  });

  it('Account settings shows user info', () => {
    cy.navOrgMenu('account');
    cy.get('input[id=first-name]').should('have.value', userWithCompanyAccount.firstName);
    cy.get('input[id=last-name]').should('have.value', userWithCompanyAccount.lastName);
    cy.get('input[id=email]').should('have.value', userWithCompanyAccount.email);
  });

  it('Organizations settings shows current org', () => {
    cy.navOrgMenu('organizations');
    cy.contains(userWithCompanyAccount.orgName).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
