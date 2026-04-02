import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Verify rent changes when property rent is edited
// Also verify termination stops future rent

describe('Rent Change & Termination Effects', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]); // rent 100
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[0],
      lease: {
        contract: contract369.name,
        beginDate: '01/04/2026',
        properties: [{
          name: properties[0].name,
          expense: { title: 'charges', amount: 10 },
          entryDate: '01/04/2026',
          exitDate: '31/03/2035'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
  });

  it('Initial rent due is 110', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains('110').should('exist');
  });

  it('Edit property rent from 100 to 150', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=rent]').clear().type('150');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Rent change persists', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=rent]').should('have.value', '150');
  });

  it('Terminate lease', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('Terminate')).click();
    cy.get('input[name=terminationDate]').type('2026-04-30');
    cy.get('[role=dialog]').find('button').contains(t('Terminate')).click();
  });

  it('Tenant shows terminated', () => {
    cy.contains(t('Terminated')).should('be.visible');
  });

  it('Terminated tenant still in tenants list', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Property shows previous tenant after termination', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Dashboard updates after termination', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Tenants')).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
