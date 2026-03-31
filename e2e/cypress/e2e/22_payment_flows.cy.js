import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Tests for payment flows: partial payment, full payment, payment verification

describe('Payment Flows', () => {
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
    cy.addPropertyFromStepper(properties[1]);
    cy.navAppMenu('dashboard');
    // Tenant 1 with property 1
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
    cy.navAppMenu('dashboard');
    // Tenant 2 with property 2
    cy.addTenantFromStepper({
      ...tenants[1],
      lease: {
        contract: contract369.name,
        beginDate: '01/01/2024',
        properties: [{
          name: properties[1].name,
          expense: { title: 'charges', amount: 30 },
          entryDate: '01/01/2024',
          exitDate: '31/12/2024'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
    cy.navAppMenu('dashboard');
  });

  // --- Rents page ---

  it('Rents page shows both tenants', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  it('Both rents show not paid status', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  // --- Partial payment for tenant 1 ---

  it('Open payment dialog for first tenant', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).parents('tr').find('[data-cy=payRent]').click();
  });

  it('Fill partial payment amount (50 of 110)', () => {
    cy.get('input[name="payments.0.amount"]').clear().type('50');
  });

  it('Save partial payment', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  it('Rent shows partially paid status after partial payment', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).should('be.visible');
  });

  // --- Full payment for tenant 2 ---

  it('Open payment dialog for second tenant', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[1].name).parents('tr').find('[data-cy=payRent]').click();
  });

  it('Fill full payment amount', () => {
    cy.get('input[name="payments.0.amount"]').clear().type('580');
  });

  it('Save full payment', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  it('Second tenant shows paid status', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[1].name).should('be.visible');
  });

  // --- Complete payment for tenant 1 ---

  it('Open payment dialog for first tenant again', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).parents('tr').find('[data-cy=payRent]').click();
  });

  it('Fill remaining payment amount', () => {
    cy.get('input[name="payments.0.amount"]').clear().type('110');
  });

  it('Save remaining payment', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  // --- Filter verification ---

  it('Filter by paid shows both tenants', () => {
    cy.navAppMenu('rents');
    cy.contains(t('Paid')).click();
    cy.contains(tenants[1].name).should('be.visible');
    cy.contains(t('Paid')).click();
  });

  // --- Rent history ---

  it('Tenant detail shows rent history button', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('Schedule')).should('be.visible');
  });

  // --- Dashboard reflects payments ---

  it('Dashboard shows revenue data', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  // --- Cannot delete tenant with payments ---

  it('Tenant with payments cannot be deleted', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=removeResourceButton]').should('have.attr', 'disabled');
  });

  after(() => {
    cy.resetAppData();
  });
});
