import i18n from '../support/i18n';
import contract369 from '../fixtures/contract_369.json';
import contract612 from '../fixtures/contract_612.json';
import properties from '../fixtures/properties_extended.json';
import tenants from '../fixtures/tenants_extended.json';
import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';

// Deep settings tests: landlord form, billing, access, organizations

describe('Settings Deep Tests', () => {
  const t = i18n.getFixedT('fr-FR');

  before(() => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);
  });

  // --- Landlord settings ---

  it('Landlord settings shows org name', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Landlord')).click();
    cy.get('input[name=name]').should('have.value', userWithCompanyAccount.orgName);
  });

  it('Landlord settings shows company name', () => {
    cy.get('input[name=company]').should('have.value', userWithCompanyAccount.company.name);
  });

  it('Landlord settings shows legal representative', () => {
    cy.get('input[name=legalRepresentative]').should('have.value', userWithCompanyAccount.company.legalRepresentative);
  });

  it('Landlord settings shows legal structure', () => {
    cy.get('input[name=legalStructure]').should('have.value', userWithCompanyAccount.company.legalStructure);
  });

  it('Landlord settings shows EIN', () => {
    cy.get('input[name=ein]').should('have.value', userWithCompanyAccount.company.ein);
  });

  it('Edit landlord name and save', () => {
    cy.get('input[name=name]').clear().type('Updated Org Name');
    cy.get('[data-cy=submit]').first().click();
  });

  it('Landlord name persists after navigation', () => {
    cy.navAppMenu('dashboard');
    cy.navAppMenu('settings');
    cy.contains(t('Landlord')).click();
    cy.get('input[name=name]').should('have.value', 'Updated Org Name');
  });

  it('Restore original landlord name', () => {
    cy.get('input[name=name]').clear().type(userWithCompanyAccount.orgName);
    cy.get('[data-cy=submit]').first().click();
  });

  // --- Billing settings ---

  it('Billing settings page loads', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Billing')).click();
  });

  it('Bank name field exists', () => {
    cy.get('input[name="bankName"]').should('exist');
  });

  it('IBAN field exists', () => {
    cy.get('input[name="iban"]').should('exist');
  });

  it('Fill bank details', () => {
    cy.get('input[name="bankName"]').clear().type('BNP Paribas');
    cy.get('input[name="iban"]').clear().type('FR7630004000031234567890143');
    cy.get('input[name="bankName"]').should('have.value', 'BNP Paribas');
    cy.get('input[name="iban"]').should('have.value', 'FR7630004000031234567890143');
  });

  // --- Access settings ---

  it('Access settings shows current user', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Access')).click();
    cy.contains(userWithCompanyAccount.email).should('be.visible');
  });

  it('Current user shows administrator role', () => {
    cy.contains(t('administrator')).should('be.visible');
  });

  it('Add member button exists', () => {
    cy.contains(t('New collaborator')).should('be.visible');
  });

  // --- Account settings ---

  it('Account settings shows user info', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Account')).click();
    cy.get('input[id=first-name]').should('have.value', userWithCompanyAccount.firstName);
    cy.get('input[id=last-name]').should('have.value', userWithCompanyAccount.lastName);
    cy.get('input[id=email]').should('have.value', userWithCompanyAccount.email);
  });

  // --- Third-parties settings ---

  it('Third-parties settings page loads', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Third-parties')).click();
  });

  it('Email service toggle exists', () => {
    cy.contains(t('Gmail')).should('be.visible');
  });

  it('Cloud storage toggle exists', () => {
    cy.contains(t('Backblaze B2')).should('be.visible');
  });

  // --- Contract management from settings ---

  it('Create contract from settings page', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains(t('New contract')).click();
    cy.get('input[name=name]').type('Test Contract');
    cy.get('[data-cy=submitContract]').click();
  });

  it('New contract appears in stepper mode', () => {
    cy.get('[data-cy=contractPage]').should('be.visible');
    cy.get('input[name=name]').should('have.value', 'Test Contract');
  });

  it('Fill contract details and complete', () => {
    cy.get('textarea[name=description]').type('Test description');
    cy.selectByLabel(t('Schedule type'), t('months'));
    cy.get('input[name=numberOfTerms]').type('12');
    cy.get('[data-cy=submit]').first().click();
    cy.get('[data-cy=submit]').first().click(); // templates step
  });

  it('Contract shows in list', () => {
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains('Test Contract').should('be.visible');
  });

  it('Delete unused contract', () => {
    cy.contains('Test Contract').click();
    cy.get('[data-cy=removeResourceButton]').click();
    cy.get('[role=dialog]').find('button').last().click();
    cy.navAppMenu('settings');
    cy.contains(t('Contracts')).click();
    cy.contains('Test Contract').should('not.exist');
  });

  after(() => {
    cy.resetAppData();
  });
});
