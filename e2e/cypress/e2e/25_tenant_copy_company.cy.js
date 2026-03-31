import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Tests for copying tenant from existing, company tenant fields, billing with VAT

describe('Tenant Copy & Company Flows', () => {
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
    cy.addPropertyFromStepper(properties[2]);
    cy.navAppMenu('dashboard');
    // Create first tenant (personal)
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
    cy.navAppMenu('dashboard');
  });

  // --- Copy tenant flow ---

  it('Open new tenant dialog', () => {
    cy.navAppMenu('tenants');
    cy.get('[data-cy=shortcutAddTenant]').click();
  });

  it('Copy from existing toggle appears', () => {
    cy.contains(t('Copy from an existing tenant')).should('be.visible');
  });

  it('Enable copy from existing', () => {
    cy.get('#isCopyFrom').click();
  });

  it('Select source tenant', () => {
    cy.selectByLabel(t('Tenant'), tenants[0].name);
  });

  it('Set new tenant name', () => {
    cy.get('input[name=name]').type('Copie de ' + tenants[0].name);
    cy.get('[data-cy=submitTenant]').click();
  });

  it('Copied tenant has source address', () => {
    cy.get('input[name="address.street1"]').should('have.value', tenants[0].address.street1);
    cy.get('input[name="address.city"]').should('have.value', tenants[0].address.city);
  });

  it('Copied tenant has source contacts', () => {
    cy.get('input[name="contacts.0.contact"]').should('have.value', tenants[0].contacts[0].name);
    cy.get('input[name="contacts.0.email"]').should('have.value', tenants[0].contacts[0].email);
  });

  it('Complete copied tenant stepper', () => {
    cy.get('[data-cy=submit]').first().click(); // tenant info
    // Lease step — select a different property
    cy.selectByLabel(t('Lease'), contract369.name);
    cy.get('input[name=beginDate]').clear().type('2024-06-01');
    cy.selectByLabel(t('Property'), properties[1].name);
    cy.get('input[name="properties.0.expenses.0.title"]').type('charges');
    cy.get('input[name="properties.0.expenses.0.amount"]').clear().type('15');
    cy.get('[data-cy=submit]').first().click(); // lease
    cy.get('[data-cy=submit]').first().click(); // billing
    cy.get('[data-cy=submit]').first().click(); // documents
  });

  it('Copied tenant appears in list', () => {
    cy.navAppMenu('tenants');
    cy.contains('Copie de ' + tenants[0].name).should('be.visible');
  });

  // --- Company tenant flow ---

  it('Create company tenant', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=shortcutAddTenant]').click();
    cy.get('input[name=name]').type(tenants[2].name);
    cy.get('[data-cy=submitTenant]').click();
  });

  it('Select business account type', () => {
    cy.get('[data-cy=tenantIsBusinessAccount]').click();
  });

  it('Company fields appear', () => {
    cy.get('input[name=legalRepresentative]').should('be.visible');
    cy.get('input[name=legalStructure]').should('be.visible');
    cy.get('input[name=ein]').should('be.visible');
    cy.get('input[name=capital]').should('be.visible');
  });

  it('Fill company fields', () => {
    cy.get('input[name=legalRepresentative]').type(tenants[2].manager);
    cy.get('input[name=legalStructure]').type(tenants[2].legalStructure);
    cy.get('input[name=ein]').type(tenants[2].ein);
    cy.get('input[name=capital]').type(tenants[2].capital);
  });

  it('Fill company address', () => {
    cy.get('input[name="address.street1"]').type(tenants[2].address.street1);
    cy.get('input[name="address.zipCode"]').type(tenants[2].address.zipCode);
    cy.get('input[name="address.city"]').type(tenants[2].address.city);
    cy.get('input[name="address.country"]').type(tenants[2].address.country);
  });

  it('Fill company contacts (2 contacts)', () => {
    cy.get('input[name="contacts.0.contact"]').type(tenants[2].contacts[0].name);
    cy.get('input[name="contacts.0.email"]').type(tenants[2].contacts[0].email);
    cy.get('input[name="contacts.0.phone1"]').type(tenants[2].contacts[0].phone1);
    cy.get('button[data-cy=addContactsItem]').click();
    cy.get('input[name="contacts.1.contact"]').type(tenants[2].contacts[1].name);
    cy.get('input[name="contacts.1.email"]').type(tenants[2].contacts[1].email);
    cy.get('input[name="contacts.1.phone1"]').type(tenants[2].contacts[1].phone1);
  });

  it('Save company tenant info', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  it('Set lease for company tenant', () => {
    cy.selectByLabel(t('Lease'), contract369.name);
    cy.get('input[name=beginDate]').clear().type('2024-01-01');
    cy.selectByLabel(t('Property'), properties[2].name);
    cy.get('input[name="properties.0.expenses.0.title"]').type('charges bureau');
    cy.get('input[name="properties.0.expenses.0.amount"]').clear().type('100');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Billing shows VAT toggle for company org', () => {
    cy.get('#isVat').should('be.visible');
    cy.get('#isVat').click();
    cy.get('input[name=vatRatio]').clear().type('20');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Complete company tenant stepper', () => {
    cy.get('[data-cy=submit]').first().click(); // documents
  });

  it('Company tenant appears in list', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[2].name).should('be.visible');
  });

  it('Search by company manager name', () => {
    cy.searchResource(tenants[2].manager);
    cy.contains(tenants[2].name).should('be.visible');
    cy.searchResource('');
  });

  // --- Three tenants total ---

  it('All three tenants in list', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
    cy.contains('Copie de ' + tenants[0].name).should('be.visible');
    cy.contains(tenants[2].name).should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
