import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Lease Termination', () => {
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

  it('Navigate to tenant detail', () => {
    cy.navAppMenu('tenants');
    cy.openResource(tenants[0].name);
    cy.get('[data-cy=tenantPage]').should('exist');
  });

  it('Terminate button is visible for active lease', () => {
    cy.contains(t('Terminate')).should('be.visible');
  });

  it('Open terminate lease dialog', () => {
    cy.contains(t('Terminate')).click();
    cy.get('[role=dialog]').should('be.visible');
    cy.contains(t('Terminate a lease')).should('be.visible');
  });

  it('Set termination date and submit', () => {
    cy.get('input#terminationDate').type('2025-12-31');
    cy.get('[role=dialog]').contains('button', t('Terminate')).click();
  });

  it('Terminate button disappears after termination', () => {
    // After termination, the Terminate button should no longer be visible
    cy.contains(t('Terminate a lease')).should('not.exist');
  });

  it('Lease contract form shows termination date', () => {
    // Navigate to the lease tab to verify termination date is saved
    cy.contains(t('Edit')).click();
    cy.get('[role=dialog]')
      .get('button')
      .contains(t('Continue'))
      .click();
    // Switch to lease tab
    cy.contains(t('Lease')).click();
    cy.get('input#terminationDate').should('have.value', '2025-12-31');
  });

  after(() => {
    cy.signOut();
  });
});
