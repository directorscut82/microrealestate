import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Settings', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  const t = i18n.getFixedT('fr-FR');

  // Test 79
  it('Landlord settings page loads', () => {
    cy.navOrgMenu('landlord');
    cy.get('input[name=name]').should('have.value', userWithCompanyAccount.orgName);
  });

  // Test 80
  it('Landlord settings shows company fields for company org', () => {
    cy.get('input[name=company]').should('exist');
    cy.get('input[name=ein]').should('exist');
  });

  // Test 81
  it('Billing settings page loads', () => {
    cy.navOrgMenu('billing');
    cy.contains(t('Contact'));
    cy.contains(t('Address'));
  });

  // Test 82
  it('Billing - bank name field exists', () => {
    cy.get('input#bankName').should('exist');
  });

  // Test 83
  it('Billing - IBAN field exists', () => {
    cy.get('input#iban').should('exist');
  });

  // Test 84
  it('Billing - contact fields exist', () => {
    cy.get('input#contact').should('exist');
    cy.get('input#email').should('exist');
    cy.get('input#phone1').should('exist');
  });

  // Test 85
  it('Billing - address fields exist', () => {
    cy.get('input#address\\.street1').should('exist');
    cy.get('input#address\\.city').should('exist');
    cy.get('input#address\\.country').should('exist');
  });

  // Test 86
  it('Third-parties settings page loads', () => {
    cy.navOrgMenu('thirdparties');
    cy.contains(t('Email delivery service'));
    cy.contains('Backblaze B2 Cloud Storage');
  });

  // Test 87
  it('Third-parties - email service toggle exists', () => {
    cy.contains(t('Email delivery service')).parent().find('button[role=switch]').should('exist');
  });

  // Test 88
  it('Third-parties - B2 toggle exists', () => {
    cy.contains('Backblaze B2 Cloud Storage').parent().find('button[role=switch]').should('exist');
  });

  // Test 89
  it('Contracts settings page loads', () => {
    cy.navOrgMenu('contracts');
    cy.contains(t('Contracts'));
  });

  // Test 90
  it('Access settings page loads', () => {
    cy.navOrgMenu('access');
    cy.contains(t('Access'));
  });

  after(() => {
    cy.signOut();
  });
});
