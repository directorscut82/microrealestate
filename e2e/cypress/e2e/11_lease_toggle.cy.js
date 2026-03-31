import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

describe('Lease Toggle Active/Inactive', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
    cy.createContractFromStepper(contract369);
  });

  const t = i18n.getFixedT('fr-FR');

  it('Contract is active by default', () => {
    cy.navOrgMenu('contracts');
    cy.get('[data-cy=contractsPage]').should('exist');
    cy.get('button[role=switch]').should('have.attr', 'data-state', 'checked');
  });

  it('Toggle contract inactive', () => {
    cy.get('button[role=switch]').click();
    cy.get('button[role=switch]').should(
      'have.attr',
      'data-state',
      'unchecked'
    );
  });

  it('Inactive state persists after page reload', () => {
    cy.reload();
    cy.get('[data-cy=contractsPage]').should('exist');
    cy.get('button[role=switch]').should(
      'have.attr',
      'data-state',
      'unchecked'
    );
  });

  it('Toggle contract active again', () => {
    cy.get('button[role=switch]').click();
    cy.get('button[role=switch]').should('have.attr', 'data-state', 'checked');
  });

  it('Active state persists after page reload', () => {
    cy.reload();
    cy.get('[data-cy=contractsPage]').should('exist');
    cy.get('button[role=switch]').should('have.attr', 'data-state', 'checked');
  });

  after(() => {
    cy.signOut();
  });
});
