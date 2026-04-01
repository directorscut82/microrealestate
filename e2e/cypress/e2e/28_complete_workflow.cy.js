import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import contract612 from '../fixtures/contract_612.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Full landlord lifecycle: setup → manage → payments → termination → cleanup
// Simulates a real landlord's complete workflow over time

describe('Complete Landlord Workflow', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  // === PHASE 1: Initial Setup ===

  it('Create residential contract', () => {
    cy.createContractFromStepper(contract612);
    cy.navAppMenu('dashboard');
  });

  it('Create commercial contract', () => {
    cy.navOrgMenu('contracts');
    cy.get('[data-cy=contractsPage]').should('exist');
    cy.contains('button', t('New contract')).click();
    cy.get('input[name=name]').type(contract369.name);
    cy.get('[data-cy=submitContract]').click();
    cy.get('textarea[name=description]').type(contract369.description);
    cy.selectByLabel(t('Schedule type'), t(contract369.timeRange));
    cy.get('input[name=numberOfTerms]').type(String(contract369.numberOfTerms));
    cy.contains('button', t('Save')).click();
    cy.contains('button', t('Save')).click();
    cy.navAppMenu('dashboard');
  });

  it('Create apartment property', () => {
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
  });

  it('Create studio property', () => {
    cy.addPropertyFromPage(properties[1]);
    cy.navAppMenu('dashboard');
  });

  it('Create office property', () => {
    cy.addPropertyFromPage(properties[2]);
    cy.navAppMenu('dashboard');
  });

  it('Dashboard shows 3 properties', () => {
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Properties')).should('be.visible');
  });

  // === PHASE 2: Onboard Tenants ===

  it('Onboard personal tenant for apartment', () => {
    cy.addTenantFromStepper({
      ...tenants[0],
      lease: {
        contract: contract612.name,
        beginDate: '01/01/2024',
        properties: [{
          name: properties[0].name,
          expense: { title: 'charges', amount: 10 },
          entryDate: '01/01/2024',
          exitDate: '31/12/2024'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
    cy.navAppMenu('dashboard');
  });

  it('Onboard personal tenant for studio', () => {
    cy.addTenantFromStepper({
      ...tenants[1],
      lease: {
        contract: contract612.name,
        beginDate: '01/03/2024',
        properties: [{
          name: properties[1].name,
          expense: { title: 'charges', amount: 30 },
          entryDate: '01/03/2024',
          exitDate: '28/02/2025'
        }]
      },
      billing: { isVat: false, percentageVatRatio: 0 }
    });
    cy.navAppMenu('dashboard');
  });

  it('Onboard company tenant for office', () => {
    cy.addTenantFromStepper({
      ...tenants[2],
      lease: {
        contract: contract369.name,
        beginDate: '01/01/2024',
        properties: [{
          name: properties[2].name,
          expense: { title: 'charges bureau', amount: 100 },
          entryDate: '01/01/2024',
          exitDate: '31/12/2032'
        }]
      },
      billing: { isVat: true, percentageVatRatio: 20 }
    });
    cy.navAppMenu('dashboard');
  });

  it('Dashboard shows 3 tenants', () => {
    cy.contains(t('Tenants')).should('be.visible');
  });

  // === PHASE 3: Verify Setup ===

  it('All tenants visible in list', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
    cy.contains(tenants[2].name).should('be.visible');
  });

  it('All properties show occupied', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');
    cy.contains(properties[1].name).should('be.visible');
    cy.contains(properties[2].name).should('be.visible');
  });

  it('Rents page shows all 3 tenants', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
    cy.contains(tenants[2].name).should('be.visible');
  });

  // === PHASE 4: Record Payments ===

  it('Record full payment for apartment tenant', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).parents('[class*="border"]').find('button').first().click();
    cy.get('input[name="payments.0.amount"]').clear().type('110');
    cy.contains('button', t('Save')).click();
  });

  it('Record partial payment for studio tenant', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[1].name).parents('[class*="border"]').find('button').first().click();
    cy.get('input[name="payments.0.amount"]').clear().type('300');
    cy.contains('button', t('Save')).click();
  });

  it('Office tenant has no payment yet', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[2].name).should('be.visible');
  });

  // === PHASE 5: Terminate Studio Lease ===

  it('Navigate to studio tenant', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[1].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  it('Terminate studio lease', () => {
    cy.contains(t('Terminate')).click();
    cy.get('input[name=terminationDate]').type('2024-09-30');
    cy.get('[role=dialog]').find('button').contains(t('Terminate')).click();
  });

  it('Studio tenant shows terminated', () => {
    cy.contains(t('Terminated')).should('be.visible');
  });

  // === PHASE 6: Edit Property ===

  it('Edit apartment rent', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=rent]').clear().type('120');
    cy.contains('button', t('Save')).click();
  });

  it('Rent change persists', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=rent]').should('have.value', '120');
  });

  // === PHASE 7: Edit Contract ===

  it('Edit commercial contract description', () => {
    cy.navOrgMenu('contracts');
    cy.contains(contract369.name).click();
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('textarea[name=description]').clear().type('Updated commercial lease');
    cy.contains('button', t('Save')).click();
  });

  it('Contract edit persists', () => {
    cy.navOrgMenu('contracts');
    cy.contains(contract369.name).click();
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('textarea[name=description]').should('have.value', 'Updated commercial lease');
  });

  // === PHASE 8: Accounting Verification ===

  it('Accounting shows settlements', () => {
    cy.navAppMenu('accounting');
    cy.contains(t('Settlements')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Accounting shows incoming tenants', () => {
    cy.contains(t('Incoming tenants')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Accounting shows outgoing tenants', () => {
    cy.contains(t('Outgoing tenants')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  // === PHASE 10: Sign Out/In Round Trip ===

  it('Sign out', () => {
    cy.signOut();
  });

  it('Sign back in', () => {
    cy.signIn(userWithCompanyAccount);
    cy.checkPage('dashboard');
  });

  it('All data intact after round trip', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
    cy.contains(tenants[2].name).should('be.visible');
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');
    cy.contains(properties[1].name).should('be.visible');
    cy.contains(properties[2].name).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
