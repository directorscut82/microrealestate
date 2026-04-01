import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Tests for tenant document tab visibility and navigation

describe('Tenant Document Management', () => {
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

  it('Navigate to tenant detail', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  it('Tenant tabs are visible', () => {
    cy.contains(t('Tenant')).should('be.visible');
    cy.contains(t('Lease')).should('be.visible');
    cy.contains(t('Billing')).should('be.visible');
    cy.contains(t('Documents')).should('be.visible');
  });

  it('Documents tab loads', () => {
    cy.contains(t('Documents')).click();
    cy.get('[data-cy=addTenantTextDocument]').should('exist');
  });

  it('Tenant info tab shows name', () => {
    cy.contains(t('Tenant')).click();
    cy.get('input[name="name"]').should('have.value', tenants[0].name);
  });

  it('Lease tab shows property', () => {
    cy.contains(t('Lease')).click();
    cy.contains(t('Property #{{count}}', { count: 1 })).should('be.visible');
  });

  it('Billing tab loads', () => {
    cy.contains(t('Billing')).click();
    cy.get('input[name="vatRatio"]').should('exist');
  });

  it('Contract overview card visible', () => {
    cy.contains(t('Contract')).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
