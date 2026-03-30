import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Dashboard & Rents', () => {
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
    cy.navAppMenu('dashboard');
  });

  const t = i18n.getFixedT('fr-FR');

  // Test 71
  it('Dashboard shows occupancy rate', () => {
    cy.contains(t('Occupancy rate')).should('be.visible');
  });

  // Test 72
  it('Dashboard shows revenues', () => {
    cy.contains(t('Revenues')).should('be.visible');
  });

  // Test 73
  it('Dashboard shows settlements', () => {
    cy.contains(t('Settlements')).should('be.visible');
  });

  // Test 74
  it('Dashboard shows top unpaid rents', () => {
    cy.contains(t('Top 5 of not paid rents')).should('be.visible');
  });

  // Test 75
  it('Dashboard shows radial chart', () => {
    cy.get('.recharts-radial-bar-sector').should('be.visible');
  });

  // Test 76
  it('Dashboard shows bar chart', () => {
    cy.get('.recharts-bar').should('be.visible');
  });

  // Test 77
  it('Rents page shows current month', () => {
    cy.navAppMenu('rents');
    cy.contains(t('Rents'));
  });

  // Test 78
  it('Rents page shows tenant name', () => {
    cy.contains(tenants[0].name).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
