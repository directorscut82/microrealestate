import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Test organization isolation between two landlords
// Landlord A creates data, Landlord B should not see it

describe('Multi-Landlord Organization Isolation', () => {
  const t = i18n.getFixedT('fr-FR');

  const landlordA = {
    firstName: 'Alice',
    lastName: 'Martin',
    email: 'alice@test.com',
    password: 'test1234'
  };

  const landlordB = {
    firstName: 'Bob',
    lastName: 'Bernard',
    email: 'bob@test.com',
    password: 'test1234'
  };

  before(() => {
    cy.resetAppData();
  });

  // --- Landlord A setup ---

  it('Landlord A signs up', () => {
    cy.signUp(landlordA);
    cy.signIn(landlordA);
  });

  it('Landlord A creates org', () => {
    cy.registerLandlord({
      orgName: 'Alice Properties',
      locale: 'fr-FR',
      currency: 'EUR'
    });
  });

  it('Landlord A creates contract and property', () => {
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
  });

  it('Landlord A sees property', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');
  });

  it('Landlord A signs out', () => {
    cy.signOut();
  });

  // --- Landlord B setup ---

  it('Landlord B signs up', () => {
    cy.signUp(landlordB);
    cy.signIn(landlordB);
  });

  it('Landlord B creates own org', () => {
    cy.registerLandlord({
      orgName: 'Bob Rentals',
      locale: 'fr-FR',
      currency: 'EUR'
    });
  });

  it('Landlord B dashboard is empty (first connection)', () => {
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    // Should show first-connection wizard
    cy.contains(t('Create a reusable contract model that includes the terms and conditions for renting your properties.')).should('be.visible');
  });

  it('Landlord B cannot see Alice properties', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('not.exist');
  });

  it('Landlord B cannot see Alice contracts', () => {
    cy.navOrgMenu('contracts');
    cy.contains(contract369.name).should('not.exist');
  });

  it('Landlord B signs out', () => {
    cy.signOut();
  });

  // --- Verify Landlord A data intact ---

  it('Landlord A signs back in', () => {
    cy.signIn(landlordA);
    cy.checkPage('dashboard');
  });

  it('Landlord A still sees own property', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');
  });

  it('Landlord A still sees own contract', () => {
    cy.navOrgMenu('contracts');
    cy.contains(contract369.name).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
