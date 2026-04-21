import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Navigation & State Persistence', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[0],
      lease: {
        contract: contract369.name,
        beginDate: '01/01/2024',
        properties: [{
          name: properties[0].name,
          expense: { title: 'charges', amount: 10 },
          entryDate: '01/01/2024',
          exitDate: '31/12/2032'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
  });

  it('Rapid navigation cycle without errors', () => {
    cy.navAppMenu('tenants');
    cy.get('[data-cy=tenantsPage]').should('be.visible');
    cy.navAppMenu('properties');
    cy.get('[data-cy=propertiesPage]').should('be.visible');
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Edit property, navigate away, come back — persisted', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=description]').clear().type('Updated description');
    cy.get('[data-cy=submit]').first().click();
    cy.navAppMenu('tenants');
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=description]').should('have.value', 'Updated description');
  });

  it('Page reload on tenant detail — data intact', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.reload();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.get('input[name="firstName"]').should('exist');
  });

  it('Page reload on property detail — data intact', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=name]').should('have.value', properties[0].name);
    cy.reload();
    cy.get('input[name=name]').should('have.value', properties[0].name);
  });

  it('Page reload on rents page — data intact', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.reload();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Page reload on settings page — data intact', () => {
    cy.navOrgMenu('landlord');
    cy.get('input[name=name]').should('have.value', userWithCompanyAccount.orgName);
    cy.reload();
    cy.get('input[name=name]').should('have.value', userWithCompanyAccount.orgName);
  });

  it('Page reload on dashboard — data intact', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.reload();
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Org menu visible after every reload', () => {
    cy.get('[data-cy=orgMenu]').should('be.visible');
  });

  it('Sign out and back in — all data intact', () => {
    cy.signOut();
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');
  });

  it('Accounting page loads after sign in', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
