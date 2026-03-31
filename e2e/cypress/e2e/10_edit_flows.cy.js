import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Edit Flows', () => {
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

  // --- Edit Property ---
  it('Navigate to property and verify current values', () => {
    cy.navAppMenu('properties');
    cy.openResource(properties[0].name);
    cy.get('input[name=name]').should('have.value', properties[0].name);
    cy.get('input[name=rent]').should('have.value', String(properties[0].rent));
  });

  it('Edit property name and rent', () => {
    cy.get('input[name=name]').clear().type('Appartement Lyon');
    cy.get('input[name=rent]').clear().type('150');
    cy.get('[data-cy=submit]').click();
  });

  it('Verify property edits persisted after navigation', () => {
    cy.navAppMenu('properties');
    cy.contains('Appartement Lyon').should('be.visible');
    cy.openResource('Appartement Lyon');
    cy.get('input[name=name]').should('have.value', 'Appartement Lyon');
    cy.get('input[name=rent]').should('have.value', '150');
  });

  it('Restore property original name', () => {
    cy.get('input[name=name]').clear().type(properties[0].name);
    cy.get('input[name=rent]').clear().type(String(properties[0].rent));
    cy.get('[data-cy=submit]').click();
  });

  // --- Edit Tenant ---
  it('Navigate to tenant detail', () => {
    cy.navAppMenu('tenants');
    cy.openResource(tenants[0].name);
    cy.get('[data-cy=tenantPage]').should('exist');
  });

  it('Click Edit and confirm edit dialog', () => {
    cy.contains(t('Edit')).click();
    cy.get('[role=dialog]')
      .find('button')
      .contains(t('Continue'))
      .click();
  });

  it('Edit tenant address city', () => {
    cy.get('input[name="address.city"]').clear().type('Lyon');
    cy.get('[data-cy=submit]').click();
  });

  it('Verify tenant edit persisted', () => {
    cy.navAppMenu('tenants');
    cy.openResource(tenants[0].name);
    cy.contains(t('Edit')).click();
    cy.get('[role=dialog]')
      .find('button')
      .contains(t('Continue'))
      .click();
    cy.get('input[name="address.city"]').should('have.value', 'Lyon');
  });

  // --- Edit Lease Contract ---
  it('Navigate to contract detail', () => {
    cy.navOrgMenu('contracts');
    cy.openResource(contract369.name);
    cy.get('[data-cy=contractPage]').should('exist');
  });

  it('Edit contract description', () => {
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('textarea[name=description]').clear().type('Updated description');
    cy.get('[data-cy=submit]').click();
  });

  it('Verify contract edit persisted', () => {
    cy.navOrgMenu('contracts');
    cy.openResource(contract369.name);
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('textarea[name=description]').should(
      'have.value',
      'Updated description'
    );
  });

  after(() => {
    cy.signOut();
  });
});
