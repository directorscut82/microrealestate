import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Combined: VAT + Expenses — all via UI (no seed for tenant)
// Office rent 1200, charges 100 = 1300 pre-tax, 20% VAT = 260, total = 1560

describe('Combined: VAT + Expenses', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
    cy.navAppMenu('dashboard');
    cy.addPropertyFromStepper(properties[2]); // Bureau Marseille, rent 1200
    cy.navAppMenu('dashboard');
    cy.addTenantFromStepper({
      name: 'VAT Tenant',
      isCompany: true,
      company: 'ACME Corp',
      address: { street1: '10 bd', zipCode: '13001', city: 'Marseille', state: 'PACA', country: 'France' },
      contacts: [{ name: 'Pierre', email: 'pierre@acme.com', phone1: '0491000001', phone2: '0491000002' }],
      lease: {
        contract: contract369.name,
        beginDate: '01/04/2026',
        properties: [{
          name: properties[2].name,
          expense: { title: 'charges bureau', amount: 100 },
          entryDate: '01/04/2026',
          exitDate: '31/03/2035'
        }]
      },
      billing: { isVat: true, percentageVatRatio: 20 }
    });
  });

  it('Navigate to rents', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
  });

  it('Tenant visible', () => {
    cy.contains('VAT Tenant').should('be.visible');
  });

  it('Rent shows 1560 (1200+100=1300 pre-tax, +20% VAT=260)', () => {
    cy.contains('1 560').should('exist');
  });

  it('Tenant detail shows VAT', () => {
    cy.navAppMenu('tenants');
    cy.contains('VAT Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
    cy.contains(t('VAT')).should('exist');
  });

  it('Record full payment of 1560', () => {
    cy.navAppMenu('rents');
    cy.contains('VAT Tenant').parents('[class*="border"]').find('button').first().click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('input[name="payments.0.amount"]').clear().type('1560');
    cy.get('[role="dialog"]').contains('button', t('Save')).click();
    cy.wait(1000);
  });

  it('Next month shows same 1560 (no balance)', () => {
    cy.navAppMenu('rents');
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.get('[data-cy=rentsPage]').find('button[class*="secondary"]').eq(1).click();
    cy.get('[data-cy=rentsPage]').should('be.visible');
    cy.contains('1 560').should('exist');
  });

  after(() => { cy.resetAppData(); });
});
