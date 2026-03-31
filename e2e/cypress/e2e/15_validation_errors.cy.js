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
    // Submit without typing a name
    cy.get('[data-cy=submitProperty]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Close property dialog', () => {
    // Press Escape or click outside to close
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

  // --- Duplicate contract name ---
  it('Create first contract', () => {
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
  });

  it('Create duplicate contract shows error', () => {
    cy.get('[data-cy=shortcutCreateContract]').click();
    cy.get('input[name=name]').type(contract369.name);
    cy.get('[data-cy=submitContract]').click();
    // Should show error toast for duplicate name (409)
    cy.get('ol.toaster > li').should('exist');
  });

  it('Close duplicate contract dialog', () => {
    cy.get('body').type('{esc}');
  });

  // --- Duplicate property name ---
  it('Create first property', () => {
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
  });

  it('Create duplicate property shows error', () => {
    cy.get('[data-cy=shortcutAddProperty]').click();
    cy.get('input[name=name]').type(properties[0].name);
    cy.get('[data-cy=submitProperty]').click();
    // Should show error toast for duplicate name (409)
    cy.get('ol.toaster > li').should('exist');
  });

  after(() => {
    cy.signOut();
  });
});
