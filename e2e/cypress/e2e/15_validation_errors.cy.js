import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Validation & Error States', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  const t = i18n.getFixedT('fr-FR');

  // --- Empty property form ---
  it('Create property with empty name shows validation error', () => {
    cy.get('[data-cy=shortcutAddProperty]').click();
    cy.get('[data-cy=submitProperty]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Close property dialog', () => {
    cy.get('body').type('{esc}');
  });

  // --- Empty contract form ---
  it('Create contract with empty name shows validation error', () => {
    cy.get('[data-cy=shortcutCreateContract]').click();
    cy.get('[data-cy=submitContract]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Close contract dialog', () => {
    cy.get('body').type('{esc}');
  });

  // --- Empty tenant form ---
  it('Create tenant with empty name shows validation error', () => {
    cy.get('[data-cy=shortcutAddTenant]').click();
    cy.get('[data-cy=submitTenant]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Close tenant dialog', () => {
    cy.get('body').type('{esc}');
  });

  // --- Contract with missing schedule type ---
  it('Create contract with name but missing schedule shows validation', () => {
    cy.get('[data-cy=shortcutCreateContract]').click();
    cy.get('input[name=name]').type('Test Contract');
    cy.get('[data-cy=submitContract]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Close incomplete contract dialog', () => {
    cy.get('body').type('{esc}');
  });

  after(() => {
    cy.signOut();
  });
});
