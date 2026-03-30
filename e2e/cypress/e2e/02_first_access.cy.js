import i18n from '../support/i18n';
import userWithPersonalAccount from '../fixtures/user_admin_personal_account.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('First Access & Organization Setup', () => {
  before(() => {
    cy.resetAppData();
  });

  // Test 11
  it('First access shows welcome message', () => {
    cy.signUp(userWithPersonalAccount);
    cy.signIn(userWithPersonalAccount);
    cy.checkUrl('/firstaccess');
    cy.checkPage('firstaccess');
    cy.contains(
      i18n.getFixedT('en')('Welcome {{firstName}} {{lastName}}!', {
        firstName: userWithPersonalAccount.firstName,
        lastName: userWithPersonalAccount.lastName
      })
    );
  });

  // Test 12
  it('Register personal account org redirects to dashboard', () => {
    cy.registerLandlord(userWithPersonalAccount);
    cy.checkUrl(`/dashboard`);
    cy.signOut();
  });

  // Test 13
  it('Register company account org redirects to dashboard', () => {
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.checkUrl(`/dashboard`);
    cy.signOut();
  });

  // Test 14
  it('Company toggle shows/hides company fields', () => {
    cy.signUp({ firstName: 'Test', lastName: 'Toggle', email: 'toggle@test.com', password: 'test123' });
    cy.signIn({ email: 'toggle@test.com', password: 'test123' });
    cy.checkPage('firstaccess');
    cy.get('input[name=legalRepresentative]').should('not.exist');
    cy.get('input[name=company]').should('not.exist');
    cy.get('[data-cy=companyTrue]').click();
    cy.get('input[name=legalRepresentative]').should('exist');
    cy.get('input[name=company]').should('exist');
    cy.get('input[name=ein]').should('exist');
    cy.get('input[name=capital]').should('exist');
    cy.get('[data-cy=companyFalse]').click();
    cy.get('input[name=legalRepresentative]').should('not.exist');
  });

  // Test 15
  it('Name field is required', () => {
    const t = i18n.getFixedT('en');
    cy.get('[data-cy=companyFalse]').click();
    cy.selectByLabel(t('Language'), 'English');
    cy.selectByLabel(t('Currency'), 'Euro');
    cy.get('[data-cy=submit]').click();
    cy.get('.text-destructive').should('exist');
  });
});
