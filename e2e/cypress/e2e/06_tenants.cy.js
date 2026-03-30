import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties.json';
import tenants from '../fixtures/tenants.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Tenant Management', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[0]);
    cy.navAppMenu('dashboard');
  });

  const t = i18n.getFixedT('fr-FR');

  // Convert DD/MM/YYYY to YYYY-MM-DD for date inputs
  const toISODate = (d) => {
    const [day, month, year] = d.split('/');
    return `${year}-${month}-${day}`;
  };

  // Test 51
  it('Add tenant from stepper - name field', () => {
    cy.get('[data-cy=shortcutAddTenant]').click();
    cy.get('input[name=name]').type(tenants[0].name);
    cy.get('[data-cy=submitTenant]').click();
  });

  // Test 52
  it('Set tenant as personal account', () => {
    cy.get('[data-cy=tenantIsPersonalAccount]').click();
  });

  // Test 53
  it('Set tenant address', () => {
    if (tenants[0].address) {
      const { street1, zipCode, city, state, country } = tenants[0].address;
      cy.get('input[name="address.street1"]').type(street1);
      cy.get('input[name="address.zipCode"]').type(zipCode);
      cy.get('input[name="address.city"]').type(city);
      cy.get('input[name="address.state"]').type(state);
      cy.get('input[name="address.country"]').type(country);
    }
  });

  // Test 54
  it('Add tenant contact', () => {
    const contact = tenants[0].contacts[0];
    cy.get('input[name="contacts.0.contact"]').type(contact.name);
    cy.get('input[name="contacts.0.email"]').type(contact.email);
    cy.get('input[name="contacts.0.phone1"]').type(contact.phone1);
    cy.get('input[name="contacts.0.phone2"]').type(contact.phone2);
  });

  // Test 55
  it('Add second contact', () => {
    if (tenants[0].contacts.length > 1) {
      cy.get('[data-cy=addContactsItem]').click();
      const contact = tenants[0].contacts[1];
      cy.get('input[name="contacts.1.contact"]').type(contact.name);
      cy.get('input[name="contacts.1.email"]').type(contact.email);
      cy.get('input[name="contacts.1.phone1"]').type(contact.phone1);
      cy.get('input[name="contacts.1.phone2"]').type(contact.phone2);
    }
  });

  // Test 56
  it('Save tenant info step', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  // Test 57
  it('Set lease contract for tenant', () => {
    if (tenants[0].lease) {
      cy.selectByLabel(t('Lease'), tenants[0].lease.contract);
    }
  });

  // Test 58
  it('Set lease begin date', () => {
    if (tenants[0].lease) {
      cy.get('input[name=beginDate]').clear().type(toISODate(tenants[0].lease.beginDate));
    }
  });

  // Test 59
  it('Set property for tenant lease', () => {
    if (tenants[0].lease?.properties?.length) {
      const prop = tenants[0].lease.properties[0];
      cy.selectByLabel(t('Property'), prop.name);
    }
  });

  // Test 60
  it('Set property expense', () => {
    if (tenants[0].lease?.properties?.length) {
      const prop = tenants[0].lease.properties[0];
      cy.get('input[name="properties.0.expenses.0.title"]').type(prop.expense.title);
      cy.get('input[name="properties.0.expenses.0.amount"]').clear().type(prop.expense.amount);
    }
  });

  // Test 61
  it('Set property entry/exit dates', () => {
    if (tenants[0].lease?.properties?.length) {
      const prop = tenants[0].lease.properties[0];
      cy.get('input[name="properties.0.entryDate"]').clear().type(toISODate(prop.entryDate));
      cy.get('input[name="properties.0.exitDate"]').clear().type(toISODate(prop.exitDate));
    }
  });

  // Test 62
  it('Save lease step', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  // Test 63
  it('Set billing - VAT toggle', () => {
    if (tenants[0].billing?.isVat) {
      cy.get('#isVat').click();
      cy.get('input[name=vatRatio]').clear().type(tenants[0].billing.percentageVatRatio);
    }
  });

  // Test 64
  it('Save billing step', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  // Test 65
  it('Save documents step (complete stepper)', () => {
    cy.get('[data-cy=submit]').first().click();
  });

  // Test 66
  it('Tenant appears in list', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).should('be.visible');
  });

  // Test 67
  it('Tenant shows lease contract name', () => {
    cy.contains(tenants[0].lease.contract).should('be.visible');
  });

  // Test 68
  it('Tenant shows lease running status', () => {
    cy.contains(t('Lease running')).should('be.visible');
  });

  // Test 69
  it('Search tenant by name', () => {
    cy.searchResource(tenants[0].name);
    cy.contains(tenants[0].name).should('be.visible');
  });

  // Test 70
  it('Tenant appears in rents page', () => {
    cy.navAppMenu('rents');
    cy.contains(tenants[0].name).should('be.visible');
  });

  after(() => {
    cy.signOut();
  });
});
