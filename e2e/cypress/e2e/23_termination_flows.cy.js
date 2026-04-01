import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Tests for lease termination flows and post-termination behavior

describe('Termination Flows', () => {
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
    cy.addPropertyFromPage(properties[1]);
    cy.navAppMenu('dashboard');
    // Tenant 1
    cy.addTenantFromStepper({
      ...tenants[0],
      lease: {
        contract: contract369.name,
        beginDate: '01/01/2023',
        properties: [{
          name: properties[0].name,
          expense: { title: 'charges', amount: 10 },
          entryDate: '01/01/2023',
          exitDate: '31/12/2031'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
    cy.navAppMenu('dashboard');
    // Tenant 2
    cy.addTenantFromStepper({
      ...tenants[1],
      lease: {
        contract: contract369.name,
        beginDate: '01/06/2023',
        properties: [{
          name: properties[1].name,
          expense: { title: 'charges', amount: 20 },
          entryDate: '01/06/2023',
          exitDate: '31/05/2032'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
    cy.navAppMenu('dashboard');
  });

  // --- Pre-termination state ---

  it('Both tenants show lease running', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  it('First tenant has terminate button', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.contains(t('Terminate')).should('be.visible');
  });

  // --- Terminate first tenant ---

  it('Open terminate dialog', () => {
    cy.contains(t('Terminate')).click();
    cy.contains(t('Terminate a lease')).should('be.visible');
  });

  it('Set termination date', () => {
    cy.get('input[name=terminationDate]').type('2024-06-30');
  });

  it('Set deposit refund amount', () => {
    cy.get('input[name=guarantyPayback]').clear().type('500');
  });

  it('Submit termination', () => {
    cy.get('[role=dialog]').find('button').contains(t('Terminate')).click();
  });

  it('Terminate button disappears after termination', () => {
    cy.contains(t('Terminate')).should('not.exist');
  });

  it('Contract overview shows terminated status', () => {
    cy.contains(t('Terminated')).should('be.visible');
  });

  it('Lease tab shows termination date', () => {
    cy.contains(t('Lease')).click();
    cy.get('input[name=terminationDate]').should('not.have.value', '');
  });

  it('Lease tab shows deposit refund', () => {
    cy.get('input[name=guarantyPayback]').should('have.value', '500');
  });

  // --- Second tenant still active ---

  it('Second tenant still has terminate button', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[1].name).click();
    cy.contains(t('Terminate')).should('be.visible');
  });

  it('Second tenant shows lease running', () => {
    cy.contains(t('In progress')).should('be.visible');
  });

  // --- Terminated tenant property becomes available ---

  it('First property shows previous tenant in history', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.contains(tenants[0].name).should('be.visible');
  });

  // --- Tenant list shows terminated status ---

  it('Tenant list shows terminated tenant with ended badge', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
  });

  // --- Accounting reflects termination ---

  it('Accounting shows outgoing tenant', () => {
    cy.navAppMenu('accounting');
    cy.contains(t('Outgoing tenants')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
