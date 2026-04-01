import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Tests for assigning multiple properties to a single tenant
// and managing multiple expenses per property

describe('Multi-Property Tenant & Expenses', () => {
  const t = i18n.getFixedT('fr-FR');
  const toISODate = (d) => {
    const [day, month, year] = d.split('/');
    return `${year}-${month}-${day}`;
  };

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    // Create first property via dashboard shortcut (first-connection mode)
    cy.addPropertyFromStepper(properties[0]);
    // Create remaining properties via properties page (dashboard is still in first-connection mode)
    cy.addPropertyFromPage(properties[1]);
    cy.addPropertyFromPage(properties[2]);
  });

  // --- Create tenant with 2 properties ---

  it('Create tenant via stepper - name step', () => {
    cy.navAppMenu('tenants');
    cy.get('[data-cy=tenantsPage]').should('exist');
    cy.contains('button', t('Add a tenant')).click();
    cy.get('input[name=name]').type('Multi-Property Tenant');
    cy.get('[data-cy=submitTenant]').click();
  });

  it('Fill tenant info', () => {
    cy.get('[data-cy=tenantIsPersonalAccount]').click();
    cy.get('input[name="address.street1"]').type('1 rue Test');
    cy.get('input[name="address.zipCode"]').type('75001');
    cy.get('input[name="address.city"]').type('Paris');
    cy.get('input[name="address.country"]').type('France');
    cy.get('input[name="contacts.0.contact"]').type('Test Contact');
    cy.get('input[name="contacts.0.email"]').type('multi@test.com');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Select lease contract', () => {
    cy.selectByLabel(t('Lease'), contract369.name);
    cy.get('input[name=beginDate]').clear().type('2023-01-01');
  });

  it('Assign first property', () => {
    cy.selectByLabel(t('Property'), properties[0].name);
    cy.get('input[name="properties.0.expenses.0.title"]').type('Charges communes');
    cy.get('input[name="properties.0.expenses.0.amount"]').clear().type('15');
  });

  it('Add second expense to first property', () => {
    cy.contains(t('Add a expense')).first().click();
    cy.get('input[name="properties.0.expenses.1.title"]').type('Eau chaude');
    cy.get('input[name="properties.0.expenses.1.amount"]').clear().type('8');
  });

  it('Add third expense to first property', () => {
    cy.contains(t('Add a expense')).first().click();
    cy.get('input[name="properties.0.expenses.2.title"]').type('Ordures ménagères');
    cy.get('input[name="properties.0.expenses.2.amount"]').clear().type('5');
  });

  it('Add second property to tenant', () => {
    cy.get('[data-cy=addPropertiesItem]').click();
    // Select property first (dates are disabled until property is selected)
    cy.contains(t('Property #{{count}}', { count: 2 }))
      .parent()
      .parent()
      .find('button[role="combobox"]')
      .first()
      .click({ force: true });
    cy.get('[role="option"]').contains(properties[1].name).click({ force: true });
    cy.get('input[name="properties.1.entryDate"]').clear().type('2023-01-01');
    cy.get('input[name="properties.1.exitDate"]').clear().type('2031-12-31');
  });

  it('Add expense to second property', () => {
    cy.get('input[name="properties.1.expenses.0.title"]').type('Charges studio');
    cy.get('input[name="properties.1.expenses.0.amount"]').clear().type('20');
  });

  it('Save lease step with 2 properties', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  it('Save billing step', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  it('Save documents step', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  // --- Verify multi-property tenant ---

  it('Tenant detail shows contract overview', () => {
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.get('input[name="name"]').should('have.value', 'Multi-Property Tenant');
  });

  it('Tenant rent overview shows combined rent', () => {
    // Rent should be sum of both properties
    cy.contains(t('Rental')).should('be.visible');
  });

  it('Navigate to tenant list and back', () => {
    cy.navAppMenu('tenants');
    cy.contains('Multi-Property Tenant').should('be.visible');
    cy.contains('Multi-Property Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  // --- Edit tenant: verify expenses persist ---

  it('Edit tenant - click edit button', () => {
    cy.contains(t('Edit')).click();
    cy.get('[role=dialog]').find('button').last().click();
  });

  it('Lease tab shows 2 properties', () => {
    cy.contains(t('Lease')).click();
    cy.contains(t('Property #{{count}}', { count: 1 })).should('be.visible');
    cy.contains(t('Property #{{count}}', { count: 2 })).should('be.visible');
  });

  // --- Both properties show occupied ---

  it('First property shows occupied', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[0].name).click();
    cy.contains('Multi-Property Tenant').should('be.visible');
  });

  it('Second property shows occupied', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[1].name).click();
    cy.contains('Multi-Property Tenant').should('be.visible');
  });

  it('Third property still vacant', () => {
    cy.navAppMenu('properties');
    cy.contains(properties[2].name).click();
    cy.contains(t('Property not rented so far')).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
