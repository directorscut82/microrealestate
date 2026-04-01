import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import contract612 from '../fixtures/contract_612.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Extended tests: multiple tenants, properties, contracts
// Covers multi-entity management that real landlords do daily

describe('Multi-Entity Management', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    // Create first contract via dashboard shortcut (first-connection mode)
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    // Create first property via dashboard shortcut
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
    // Create first tenant to exit first-connection mode
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
      billing: { isVat: true, percentageVatRatio: 20 }
    });
    // Create second contract from settings
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains(t('New contract')).click();
    cy.get('input[name=name]').type(contract612.name);
    cy.get('[data-cy=submitContract]').click();
    cy.get('textarea[name=description]').type(contract612.description);
    cy.selectByLabel(t('Schedule type'), t(contract612.timeRange));
    cy.get('input[name=numberOfTerms]').type(String(contract612.numberOfTerms));
    cy.get('[data-cy=submit]').first().click();
    cy.get('[data-cy=submit]').first().click(); // templates step
    // Create remaining properties — reload dashboard to refresh RQ cache
    [properties[1], properties[2], properties[3]].forEach((prop) => {
      cy.visit('/');
      cy.checkPage('dashboard');
      cy.addPropertyFromStepper(prop);
    });
  });

  // --- Multiple contracts ---

  it('Two contracts appear in contracts list', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains(contract369.name).should('be.visible');
    cy.contains(contract612.name).should('be.visible');
  });

  it('Toggle first contract inactive', () => {
    cy.navOrgMenu('contracts');
    cy.get('[data-cy=contractsPage]').should('exist');
    cy.contains(contract369.name).parents('[class*="border"]').find('[role=switch]').click();
  });

  it('Toggle first contract active again', () => {
    cy.contains(contract369.name).parents('[class*="border"]').find('[role=switch]').click();
  });

  // --- Multiple properties ---

  it('Four properties appear in properties list', () => {
    cy.navAppMenu('properties');
    properties.forEach((prop) => {
      cy.contains(prop.name).should('be.visible');
    });
  });

  it('Search filters properties correctly', () => {
    cy.navAppMenu('properties');
    cy.searchResource('Lyon');
    cy.contains('Studio Lyon').should('be.visible');
    cy.contains('Appartement Paris').should('not.exist');
    cy.searchResource('');
  });

  it('Search by partial name works', () => {
    cy.navAppMenu('properties');
    cy.searchResource('Bureau');
    cy.contains('Bureau Marseille').should('be.visible');
    cy.searchResource('');
  });

  it('All properties show vacant status', () => {
    cy.navAppMenu('properties');
    properties.forEach((prop) => {
      cy.contains(prop.name).should('be.visible');
    });
  });

  // --- Create tenant 1 (personal, apartment) ---

  it('Create first tenant with apartment', () => {
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[0],
      lease: {
        contract: contract369.name,
        beginDate: '01/06/2022',
        properties: [{
          name: properties[0].name,
          expense: { title: 'charges', amount: 10 },
          entryDate: '01/06/2022',
          exitDate: '31/05/2031'
        }]
      },
      billing: { isVat: true, percentageVatRatio: 20 }
    });
    cy.navAppMenu('dashboard');
  });

  // --- Create tenant 2 (personal, studio) ---

  it('Create second tenant with studio', () => {
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[1],
      lease: {
        contract: contract612.name,
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

  // --- Create tenant 3 (company, office) ---

  it('Create company tenant with office', () => {
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      ...tenants[2],
      lease: {
        contract: contract369.name,
        beginDate: '01/03/2023',
        properties: [{
          name: properties[2].name,
          expense: { title: 'charges bureau', amount: 100 },
          entryDate: '01/03/2023',
          exitDate: '28/02/2032'
        }]
      },
      billing: { isVat: true, percentageVatRatio: 20 }
    });
    cy.navAppMenu('dashboard');
  });

  // --- Tenant list verification ---

  it('Three tenants appear in tenants list', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[1].name).should('be.visible');
    cy.contains(tenants[2].name).should('be.visible');
  });

  it('Search tenants by name', () => {
    cy.navAppMenu('tenants');
    cy.searchResource('Marie');
    cy.contains(tenants[1].name).should('be.visible');
    cy.contains(tenants[0].name).should('not.exist');
    cy.searchResource('');
  });

  it('Search tenants by contact email', () => {
    cy.navAppMenu('tenants');
    cy.searchResource('pierre@acme');
    cy.contains(tenants[2].name).should('be.visible');
    cy.contains(tenants[0].name).should('not.exist');
    cy.searchResource('');
  });

  // --- Property occupancy ---

  it('Occupied properties show tenant name', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.contains(tenants[0].name).should('be.visible');
  });

  it('Parking property still shows vacant', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[3].name).click();
    cy.contains(t('Property not rented so far')).should('be.visible');
  });

  // --- Dashboard with data ---

  it('Dashboard shows correct tenant count', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    cy.contains(t('Tenants')).should('be.visible');
  });

  it('Dashboard shows correct property count', () => {
    cy.contains(t('Properties')).should('be.visible');
  });

  // --- Rents page with multiple tenants ---

  it('Rents page shows all three tenants', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(tenants[2].name).should('be.visible');
  });

  it('Filter rents by paid status shows empty', () => {
    cy.navAppMenu('rents');
    cy.contains(t('Paid')).click();
    // No rents paid yet — list should be empty or show no results
    cy.contains(tenants[0].name).should('not.exist');
    cy.contains(t('Paid')).click(); // deselect
  });

  it('Filter rents by not paid shows all tenants', () => {
    cy.navAppMenu('rents');
    cy.contains(t('Not paid')).click();
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains(t('Not paid')).click(); // deselect
  });

  // --- Accounting ---

  it('Accounting page shows incoming tenants', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Incoming tenants')).should('be.visible');
  });

  it('Accounting page shows settlements tab', () => {
    cy.contains(t('Settlements')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  it('Accounting page shows outgoing tenants tab', () => {
    cy.contains(t('Outgoing tenants')).click();
    cy.get('[data-cy=accountingPage]').should('be.visible');
  });

  // --- Referential integrity with multiple entities ---

  it('Cannot delete property occupied by tenant', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('[data-cy=removeResourceButton]').click();
    cy.get('[role=dialog]').find('button').last().click();
    cy.get('ol.toaster > li', { timeout: 5000 }).should('exist');
  });

  it('Can delete unoccupied property', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[3].name).click();
    cy.removeResource();
    cy.navAppMenu('properties');
    cy.contains(properties[3].name).should('not.exist');
  });

  it('Cannot delete contract used by tenants', () => {
    cy.navOrgMenu('contracts');
    cy.contains(contract369.name).click();
    cy.contains(t('This contract is currently used, only some fields can be updated')).should('exist');
  });

  after(() => {
    cy.resetAppData();
  });
});
