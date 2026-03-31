import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Delete Flows & Referential Integrity', () => {
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

  // --- Property in use cannot be deleted ---
  it('Navigate to property in use', () => {
    cy.navAppMenu('properties');
    cy.openResource(properties[0].name);
  });

  it('Delete property in use shows error', () => {
    cy.get('button[data-cy=removeResourceButton]').click();
    cy.get('[role=dialog]')
      .find('button')
      .contains(t('Continue'))
      .click();
    // Should show error toast — property is referenced by tenant
    cy.get('ol.toaster > li').should('exist');
  });

  // --- Contract in use cannot be deleted ---
  it('Navigate to contract in use', () => {
    cy.navOrgMenu('contracts');
    cy.openResource(contract369.name);
    cy.get('[data-cy=contractPage]').should('exist');
  });

  it('Delete contract in use shows error', () => {
    cy.get('button[data-cy=removeResourceButton]').click();
    cy.get('[role=dialog]')
      .find('button')
      .contains(t('Continue'))
      .click();
    // Should show error toast — contract is used by tenants
    cy.get('ol.toaster > li').should('exist');
  });

  // --- Delete tenant first (frees property and contract) ---
  it('Delete tenant succeeds', () => {
    cy.navAppMenu('tenants');
    cy.searchResource(tenants[0].name);
    cy.openResource(tenants[0].name);
    cy.removeResource();
    cy.contains(t('No tenants found'));
  });

  // --- Now property can be deleted ---
  it('Delete property succeeds after tenant removed', () => {
    cy.navAppMenu('properties');
    cy.openResource(properties[0].name);
    cy.removeResource();
    cy.contains(t('No properties found'));
  });

  // --- Now contract can be deleted ---
  it('Delete contract succeeds after tenant removed', () => {
    cy.navOrgMenu('contracts');
    cy.openResource(contract369.name);
    cy.removeResource();
    cy.contains(contract369.name).should('not.exist');
  });

  after(() => {
    cy.signOut();
  });
});
