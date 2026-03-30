import i18n from '../support/i18n';
import userWithPersonalAccount from '../fixtures/user_admin_personal_account.json';

describe('Navigation', () => {
  before(() => {
    cy.resetAppData();
    cy.signUp(userWithPersonalAccount);
    cy.signIn(userWithPersonalAccount);
    cy.registerLandlord(userWithPersonalAccount);
  });

  const t = i18n.getFixedT('fr-FR');

  // Test 16
  it('Dashboard page loads', () => {
    cy.checkPage('dashboard');
  });

  // Test 17
  it('Navigate to Rents via app menu', () => {
    cy.navAppMenu('rents');
    const now = new Date();
    cy.checkUrl(`/rents/${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`);
    cy.contains(t('Rents'));
  });

  // Test 18
  it('Navigate to Tenants via app menu', () => {
    cy.navAppMenu('tenants');
    cy.checkUrl('/tenants');
    cy.contains(t('Tenants'));
  });

  // Test 19
  it('Navigate to Properties via app menu', () => {
    cy.navAppMenu('properties');
    cy.checkUrl('/properties');
    cy.contains(t('Properties'));
  });

  // Test 20
  it('Navigate to Accounting via app menu', () => {
    cy.navAppMenu('accounting');
    const now = new Date();
    cy.checkUrl(`/accounting/${now.getFullYear()}`);
    cy.contains(t('Accounting'));
  });

  // Test 21
  it('Navigate to Settings via app menu', () => {
    cy.navAppMenu('settings');
    cy.checkUrl('/settings');
    cy.contains(t('Landlord'));
    cy.contains(t('Billing'));
    cy.contains(t('Contracts'));
  });

  // Test 22
  it('Navigate to Landlord settings via org menu', () => {
    cy.navOrgMenu('landlord');
    cy.checkUrl('/landlord');
    cy.contains(t('Landlord'));
  });

  // Test 23
  it('Navigate to Billing settings via org menu', () => {
    cy.navOrgMenu('billing');
    cy.checkUrl('/billing');
    cy.contains(t('Billing'));
  });

  // Test 24
  it('Navigate to Contracts settings via org menu', () => {
    cy.navOrgMenu('contracts');
    cy.checkUrl('/contracts');
    cy.contains(t('Contracts'));
  });

  // Test 25
  it('Navigate to Access settings via org menu', () => {
    cy.navOrgMenu('access');
    cy.checkUrl('/access');
    cy.contains(t('Access'));
  });

  // Test 26
  it('Navigate to Third-parties settings via org menu', () => {
    cy.navOrgMenu('thirdparties');
    cy.checkUrl('/thirdparties');
    cy.contains(t('Third-parties'));
  });

  // Test 27
  it('Navigate to Organizations via org menu', () => {
    cy.navOrgMenu('organizations');
    cy.checkUrl('/organizations');
    cy.contains(t('Organizations'));
  });

  // Test 28
  it('Navigate back to Dashboard', () => {
    cy.navAppMenu('dashboard');
    cy.checkUrl('/dashboard');
  });

  after(() => {
    cy.signOut();
  });
});
