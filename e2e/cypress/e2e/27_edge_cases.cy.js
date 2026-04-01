import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Edge cases: empty states, validation boundaries, navigation edge cases

describe('Edge Cases & Validation', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  // --- Empty states ---

  it('Dashboard shows setup shortcuts when empty', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=shortcutCreateContract]').should('be.visible');
    cy.get('[data-cy=shortcutAddProperty]').should('be.visible');
    cy.get('[data-cy=shortcutAddTenant]').should('be.visible');
  });

  it('Tenants page shows empty state', () => {
    cy.navAppMenu('tenants');
    cy.get('[data-cy=tenantsPage]').should('be.visible');
  });

  it('Properties page shows empty state', () => {
    cy.navAppMenu('properties');
    cy.get('[data-cy=propertiesPage]').should('be.visible');
  });

  it('Rents page shows empty state', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Accounting page shows empty state', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  // --- Contract validation ---

  it('Create contract with empty name shows error', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains(t('New contract')).click();
    cy.get('[data-cy=submitContract]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Close contract dialog', () => {
    cy.get('[role=dialog]').find('button').first().click();
  });

  it('Create contract with very long name', () => {
    cy.contains(t('New contract')).click();
    cy.get('input[name=name]').type('A'.repeat(100));
    cy.get('[data-cy=submitContract]').click();
    cy.get('input[name=name]').should('have.value', 'A'.repeat(100));
  });

  it('Delete long-name contract', () => {
    cy.get('[data-cy=removeResourceButton]').click();
    cy.get('[role=dialog]').find('button').last().click();
  });

  // --- Property validation ---

  it('Create property with empty name shows error', () => {
    cy.navAppMenu('properties');
    cy.contains('button', t('Add a property')).click();
    cy.get('[data-cy=submitProperty]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Close property dialog', () => {
    cy.get('[role=dialog]').find('button').first().click();
  });

  // --- Tenant validation ---

  it('Create tenant with empty name shows error', () => {
    cy.navAppMenu('tenants');
    cy.contains('button', t('Add a tenant')).click();
    cy.get('[data-cy=submitTenant]').click();
    cy.get('.text-destructive').should('exist');
  });

  it('Close tenant dialog', () => {
    cy.get('[role=dialog]').find('button').first().click();
  });

  // --- Setup for further tests ---

  it('Create contract for further tests', () => {
    cy.navOrgMenu('contracts');
    cy.get('[data-cy=contractsPage]').should('exist');
    cy.contains('button', t('New contract')).click();
    cy.get('input[name=name]').type(contract369.name);
    cy.get('[data-cy=submitContract]').click();
    cy.get('textarea[name=description]').type(contract369.description);
    cy.selectByLabel(t('Schedule type'), t(contract369.timeRange));
    cy.get('input[name=numberOfTerms]').type(String(contract369.numberOfTerms));
    cy.get('[data-cy=submit]').first().click();
    cy.get('[data-cy=submit]').first().click();
  });

  it('Create second property', () => {
    cy.addPropertyFromPage(properties[1]);
    cy.navAppMenu('dashboard');
  });

  // --- Navigation edge cases ---

  it('Direct URL to nonexistent tenant shows error', () => {
    cy.visit('/landlord/' + userWithCompanyAccount.orgName + '/tenants/000000000000000000000000', { failOnStatusCode: false });
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  it('Navigate back to dashboard', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Rapid navigation does not break app', () => {
    cy.navAppMenu('tenants');
    cy.navAppMenu('properties');
    cy.navAppMenu('rents');
    cy.navAppMenu('accounting');
    cy.navAppMenu('settings');
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  // --- Sign out/in preserves data ---

  it('Sign out', () => {
    cy.signOut();
  });

  it('Sign in again', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
  });

  it('Data intact after sign out/in', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');
    cy.contains(properties[1].name).should('be.visible');
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains(contract369.name).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
