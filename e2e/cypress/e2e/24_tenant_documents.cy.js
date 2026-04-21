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
    cy.get('[role="tablist"]').should('exist');
    cy.get('[role="tab"]').should('have.length.at.least', 3);
  });

  it('Documents tab loads', () => {
    cy.get('[role="tab"]').eq(3).click();
    cy.get('[data-cy=addTenantTextDocument]').should('exist');
  });

  it('Tenant info tab shows name', () => {
    cy.get('[role="tab"]').first().click();
    cy.get('input[name="firstName"]').should('exist');
  });

  it('Lease tab shows property', () => {
    cy.get('[role="tab"]').eq(1).click();
    cy.contains(t('Property #{{count}}', { count: 1 })).should('be.visible');
  });

  it('Billing tab loads', () => {
    cy.get('[role="tab"]').eq(2).click();
    cy.get('input[name="vatRatio"]').should('exist');
  });

  it('Contract overview card visible', () => {
    cy.contains(t('Contract')).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
