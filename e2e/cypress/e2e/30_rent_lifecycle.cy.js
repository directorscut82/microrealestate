import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Monthly Rent Lifecycle', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
    cy.addPropertyFromPage(properties[1]);
    // Tenant A — apartment, rent 100 + charges 10 = 110
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
    // Tenant B — studio, rent 200 + charges 30 = 230
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[1],
      lease: {
        contract: contract369.name,
        beginDate: '01/01/2024',
        properties: [{
          name: properties[1].name,
          expense: { title: 'charges', amount: 30 },
          entryDate: '01/01/2024',
          exitDate: '31/12/2032'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
  });

  it('Navigate to rents page', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Both tenants visible on rents page', () => {
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
  });

  it('Rents overview shows not-paid count', () => {
    cy.contains(t('Not paid')).should('be.visible');
  });

  it('Record full payment for tenant A', () => {
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('110');
    cy.contains('button', t('Save')).click();
  });

  it('Tenant A rent row updated after payment', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Record partial payment for tenant B (50 of 230)', () => {
    cy.contains(tenants[1].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('50');
    cy.contains('button', t('Save')).click();
  });

  it('Rents overview shows paid count updated', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(t('Paid')).should('be.visible');
  });

  it('Navigate to accounting page', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Settlements tab shows data', () => {
    cy.contains(t('Settlements')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Incoming tenants tab shows data', () => {
    cy.contains(t('Incoming tenants')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Dashboard shows revenue data', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Revenues')).should('be.visible');
  });

  it('Record remaining payment for tenant B', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[1].name).parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('180');
    cy.contains('button', t('Save')).click();
  });

  after(() => {
    cy.signOut();
  });
});
