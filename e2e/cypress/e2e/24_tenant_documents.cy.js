import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Tests for tenant document management (text documents)

describe('Tenant Document Management', () => {
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
  });

  // --- Navigate to tenant documents ---

  it('Navigate to tenant detail', () => {
    cy.navAppMenu('tenants');
    cy.contains(tenants[0].name).click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  it('Click edit to enable editing', () => {
    cy.contains(t('Edit')).click();
    cy.get('[role=dialog]').find('button').last().click();
  });

  it('Documents tab is visible', () => {
    cy.contains(t('Documents')).click();
  });

  // --- Create text document from template ---

  it('Create document button exists', () => {
    cy.get('[data-cy=addTenantTextDocument]').should('be.visible');
  });

  it('Open document creator drawer', () => {
    cy.get('[data-cy=addTenantTextDocument]').click();
  });

  it('Drawer shows blank document option', () => {
    cy.contains(t('Blank document')).should('be.visible');
  });

  it('Drawer shows template-based document option', () => {
    cy.contains('Bail').should('be.visible');
  });

  it('Create document from Bail template', () => {
    cy.get('[data-cy=template-Bail]').click();
  });

  it('Rich text editor opens with template content', () => {
    cy.get('.ProseMirror').should('be.visible');
  });

  it('Close rich text editor', () => {
    cy.get('[data-cy=close]').click();
  });

  it('Document appears in document list', () => {
    cy.contains('Bail').should('be.visible');
  });

  // --- Create blank document ---

  it('Open document creator again', () => {
    cy.get('[data-cy=addTenantTextDocument]').click();
  });

  it('Create blank document', () => {
    cy.get(`[data-cy=template-${t('Blank document').replace(/\s/g, '')}]`).click();
  });

  it('Edit blank document title and content', () => {
    cy.get('input[name=title]').clear().type('Notes locataire');
    cy.get('[data-cy="savingTextDocument"]').should('not.exist');
    cy.get('.ProseMirror').type('Notes importantes pour ce locataire.');
    cy.get('[data-cy="savingTextDocument"]').should('not.exist');
    cy.get('[data-cy=close]').click();
  });

  it('Both documents appear in list', () => {
    cy.contains('Bail').should('be.visible');
    cy.contains('Notes locataire').should('be.visible');
  });

  // --- Edit existing document ---

  it('Click on document to edit', () => {
    cy.contains('Notes locataire').click();
    cy.get('.ProseMirror').should('be.visible');
  });

  it('Modify document content', () => {
    cy.get('.ProseMirror').type(' Mise à jour.');
    cy.get('[data-cy="savingTextDocument"]').should('not.exist');
    cy.get('[data-cy=close]').click();
  });

  // --- Delete document ---

  it('Delete the blank document', () => {
    cy.contains('Notes locataire').parents('[class*=border-b]').find('button').last().click();
    cy.get('[role=dialog]').find('button').last().click();
  });

  it('Only template document remains', () => {
    cy.contains('Bail').should('be.visible');
    cy.contains('Notes locataire').should('not.exist');
  });

  after(() => {
    cy.resetAppData();
  });
});
