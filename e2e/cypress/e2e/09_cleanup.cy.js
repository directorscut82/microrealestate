import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Resource Cleanup & Empty States', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper(tenants[0]);
  });

  const t = i18n.getFixedT('fr-FR');

  // Test 91
  it('Delete tenant', () => {
    cy.navAppMenu('tenants');
    cy.searchResource(tenants[0].name);
    cy.openResource(tenants[0].name);
    cy.removeResource();
    cy.contains(t('No tenants found'));
  });

  // Test 92
  it('Tenants page shows empty state', () => {
    cy.contains(t('No tenants found'));
  });

  // Test 93
  it('Delete property', () => {
    cy.navAppMenu('properties');
    cy.searchResource(properties[0].name);
    cy.openResource(properties[0].name);
    cy.removeResource();
    cy.contains(t('No properties found'));
  });

  // Test 94
  it('Properties page shows empty state', () => {
    cy.contains(t('No properties found'));
  });

  // Test 95
  it('Delete contract', () => {
    cy.navOrgMenu('contracts');
    cy.openResource(contract369.name);
    cy.removeResource();
    cy.contains(contract369.name).should('not.exist');
  });

  // Test 96
  it('Dashboard shows setup steps after cleanup', () => {
    cy.navAppMenu('dashboard');
    cy.contains(t('Follow these steps to start managing your properties'));
  });

  // Test 97
  it('Dashboard shows create contract shortcut', () => {
    cy.get('[data-cy=shortcutCreateContract]').should('be.visible');
  });

  // Test 98
  it('Dashboard shows add property shortcut', () => {
    cy.get('[data-cy=shortcutAddProperty]').should('be.visible');
  });

  // Test 99
  it('Dashboard shows add tenant shortcut', () => {
    cy.get('[data-cy=shortcutAddTenant]').should('be.visible');
  });

  // Test 100
  it('Add tenant button visible on tenants page', () => {
    cy.navAppMenu('tenants');
    cy.contains(t('Add a tenant'));
  });

  after(() => {
    cy.signOut();
  });
});
