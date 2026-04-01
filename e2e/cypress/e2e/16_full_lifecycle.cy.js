import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Complex real-world flows that exercise the full MobX→RQ migration.
// Tests chain multiple operations and verify data consistency across pages.

describe('Full Landlord Lifecycle', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  // --- PHASE 1: Setup ---

  it('Create contract, property, tenant via steppers', () => {
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper(tenants[0]);
    cy.navAppMenu('dashboard');
    cy.checkPage('dashboard');
  });

  it('Dashboard reflects created entities', () => {
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Properties')).should('be.visible');
    cy.contains(t('Tenants')).should('be.visible');
  });

  // --- PHASE 2: Edit property, verify persistence ---

  it('Edit property, navigate away, come back — data persists', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=rent]').clear().type('200');
    cy.get('[data-cy=submit]').first().click();

    cy.navAppMenu('dashboard');
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=rent]').should('have.value', '200');

    // Restore
    cy.get('input[name=rent]').clear().type(String(properties[0].rent));
    cy.get('[data-cy=submit]').first().click();
  });

  // --- PHASE 3: Verify tenant detail page ---

  it('Tenant detail page loads correctly', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  // --- PHASE 4: Rents page ---

  it('Rents page shows tenant rent entry', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
  });

  // --- PHASE 5: Contract templates ---

  it('Contract detail shows templates tab with documents', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains(contract369.name).click();
    cy.get('[data-cy=contractPage]').should('be.visible');
    cy.get('[data-cy=tabContractTemplates]').click();
    cy.contains(contract369.templates[0].title).should('be.visible');
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('input[name=name]').should('have.value', contract369.name);
  });

  // --- PHASE 6: Settings pages ---

  it('Landlord settings shows org name', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Landlord')).click();
    cy.get('input[name=name]').should('have.value', userWithCompanyAccount.orgName);
  });

  it('Access settings shows current user', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Access')).click();
    cy.contains(userWithCompanyAccount.email).should('be.visible');
  });

  // --- PHASE 7: Accounting ---

  it('Accounting page loads with tabs', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Incoming tenants')).should('be.visible');
    cy.contains(t('Settlements')).should('be.visible');
  });

  // --- PHASE 8: Cross-page consistency ---

  it('Property shows tenant as occupant', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.contains(tenants[0].name).should('be.visible');
  });

  // --- PHASE 9: Sign out/in round-trip ---

  it('Sign out and back in — all data intact', () => {
    cy.signOut();
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');

    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');

    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');

    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains(contract369.name).should('be.visible');
  });

});
