import i18n from '../support/i18n';
import userWithPersonalAccount from '../fixtures/user_admin_personal_account.json';

describe('Authentication', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithPersonalAccount);
  });

  // Test 1
  it('Sign in with valid credentials', () => {
    cy.signIn(userWithPersonalAccount);
    cy.checkUrl('/firstaccess');
  });

  // Test 2
  it('Sign in with wrong password shows error', () => {
    cy.visit('/signin');
    cy.get('input[name=email]').type('demo@demo.com');
    cy.get('input[name=password]').type('wrongpassword');
    cy.get('[data-cy=submit]').click();
    cy.get('ol.toaster > li').should(
      'have.text',
      i18n.getFixedT('en')('Incorrect email or password')
    );
  });

  // Test 3
  it('Sign in with empty fields shows validation', () => {
    cy.visit('/signin');
    cy.get('[data-cy=submit]').click();
    cy.get('.text-destructive').should('exist');
  });

  // Test 4
  it('Sign up page loads when SIGNUP enabled', () => {
    cy.visit('/signup');
    cy.get('[data-cy=signin]').click();
    cy.get('[data-cy=signup]').click();
    cy.contains(i18n.getFixedT('en')('Sign up and manage your properties online'));
  });

  // Test 5
  it('Sign up with existing email shows error toast', () => {
    cy.visit('/signup');
    cy.signUp(userWithPersonalAccount);
    cy.url().should('include', '/signin');
  });

  // Test 6
  it('Sign up with empty fields shows validation', () => {
    cy.visit('/signup');
    cy.get('[data-cy=signin]').click();
    cy.get('[data-cy=signup]').click();
    cy.get('[data-cy=submit]').click();
    cy.get('.text-destructive').should('exist');
  });

  // Test 7
  it('Forgot password page loads', () => {
    cy.visit('/signin');
    cy.get('[data-cy=forgotpassword]').click();
    cy.contains(i18n.getFixedT('en')('Reset your password'));
  });

  // Test 8
  it('Forgot password with empty email shows validation', () => {
    cy.visit('/forgotpassword');
    cy.get('[data-cy=submit]').click();
    cy.get('.text-destructive').should('exist');
  });

  // Test 9
  it('Sign out redirects to signin', () => {
    cy.signIn(userWithPersonalAccount);
    cy.registerLandlord(userWithPersonalAccount);
    cy.signOut();
    cy.checkUrl('/signin');
  });

  // Test 10
  it('Signin link from signup works', () => {
    cy.visit('/signup');
    cy.get('[data-cy=signin]').click();
    cy.checkUrl('/signin');
  });
});
