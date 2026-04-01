import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Rapid navigation tests that catch stale-data bugs from MobX→RQ migration.

describe('Rapid Navigation & Data Freshness', () => {
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
    cy.addTenantFromStepper(tenants[0]);
    cy.navAppMenu('dashboard');
  });

  it('Rapid page cycle: tenants→properties→rents→dashboard', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).should('be.visible');
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).should('be.visible');
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
  });

  it('Tenant detail: open, back, reopen — no stale data', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.get('input[name="name"]').should('have.value', tenants[0].name);
    cy.go('back');
    cy.get('[data-cy=tenantsPage]').should('be.visible');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.get('input[name="name"]').should('have.value', tenants[0].name);
  });

  it('Property detail: open, back, reopen — no stale data', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=name]').should('have.value', properties[0].name);
    cy.go('back');
    cy.get('[data-cy=propertiesPage]').should('be.visible');
    cy.contains(properties[0].name).click();
    cy.get('input[name=name]').should('have.value', properties[0].name);
  });

  it('Edit property, navigate to tenants, come back — edit persisted', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=description]').clear().type('Updated description');
    cy.get('[data-cy=submit]').first().click();

    cy.navAppMenu('tenants');
    cy.get('[data-cy=tenantsPage]').should('be.visible');

    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.get('input[name=description]').should('have.value', 'Updated description');
  });

  it('Contract tabs: rapid switching between info and templates', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains(contract369.name).click();
    cy.get('[data-cy=contractPage]').should('be.visible');

    cy.get('[data-cy=tabContractTemplates]').click();
    cy.contains(contract369.templates[0].title).should('be.visible');
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('input[name=name]').should('have.value', contract369.name);
    cy.get('[data-cy=tabContractTemplates]').click();
    cy.get('[data-cy=tabContractInfo]').click();
    cy.get('[data-cy=tabContractTemplates]').click();
    cy.contains(contract369.templates[0].title).should('be.visible');
  });

  it('Accounting page loads for current year', () => {
    cy.navAppMenu('accounting');
    cy.get('[data-cy=accountingPage]').should('be.visible');
    cy.contains(t('Settlements')).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
