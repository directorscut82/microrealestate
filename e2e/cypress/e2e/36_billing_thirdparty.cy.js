import i18n from '../support/i18n';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Billing & Third-Party Settings', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  it('Navigate to billing settings', () => {
    cy.navOrgMenu('billing');
    cy.get('input[name="contact"]').should('exist');
  });

  it('Fill all required billing fields', () => {
    cy.get('input[name="contact"]').clear().type('Jane Doe');
    cy.get('input[name="email"]').clear().type('billing@test.com');
    cy.get('input[name="phone1"]').clear().type('0123456789');
    cy.get('input[name="vatNumber"]').clear().type('FR12345678901');
    cy.get('input[name="address.street1"]').clear().type('1 rue de la Paix');
    cy.get('input[name="address.zipCode"]').clear().type('75001');
    cy.get('input[name="address.city"]').clear().type('Paris');
    cy.get('input[name="address.country"]').clear().type('France');
  });

  it('Fill bank details', () => {
    cy.get('input[name="bankName"]').clear().type('BNP Paribas');
    cy.get('input[name="iban"]').clear().type('FR7630004000031234567890143');
  });

  it('Save billing form', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  it('All fields persist after navigation', () => {
    cy.navAppMenu('dashboard');
    cy.navOrgMenu('billing');
    cy.get('input[name="contact"]').should('have.value', 'Jane Doe');
    cy.get('input[name="email"]').should('have.value', 'billing@test.com');
    cy.get('input[name="bankName"]').should('have.value', 'BNP Paribas');
    cy.get('input[name="iban"]').should('have.value', 'FR7630004000031234567890143');
  });

  it('Third-parties settings page loads', () => {
    cy.navOrgMenu('thirdparties');
    cy.contains(t('Email delivery service')).should('be.visible');
  });

  it('Cloud storage section exists', () => {
    cy.contains(t('Configuration required to store documents in the cloud')).should('be.visible');
  });

  it('Email delivery section exists', () => {
    cy.contains(t('Configuration required for sending invoices, notices and all kind of communication to the tenants')).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
