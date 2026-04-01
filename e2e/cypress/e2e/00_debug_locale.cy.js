import userWithCompanyAccount from '../fixtures/user_admin_company_account.json';
import contract369 from '../fixtures/contract_369.json';
import properties from '../fixtures/properties_extended.json';
import i18n from '../support/i18n';

describe('Debug locale', () => {
  it('traces locale through the flow', () => {
    cy.resetAppData();
    cy.signUp(userWithCompanyAccount);
    cy.signIn(userWithCompanyAccount);
    cy.registerLandlord(userWithCompanyAccount);

    // After registerLandlord
    cy.url().then(url => cy.log('After registerLandlord: ' + url));
    cy.get('[data-cy=shortcutCreateContract]').should('be.visible');

    // Check if page is in French
    cy.document().then(doc => {
      const html = doc.documentElement.getAttribute('lang');
      cy.log('HTML lang after register: ' + html);
    });

    cy.createContractFromStepper(contract369);
    cy.url().then(url => cy.log('After createContract: ' + url));

    cy.navAppMenu('dashboard');
    cy.url().then(url => cy.log('After navDashboard: ' + url));
    cy.document().then(doc => {
      const html = doc.documentElement.getAttribute('lang');
      cy.log('HTML lang after navDashboard: ' + html);
    });

    // Now try addPropertyFromStepper
    cy.get('[data-cy=shortcutAddProperty]').click();
    cy.get('input[name=name]').type(properties[0].name);
    cy.get('[data-cy=submitProperty]').click();
    cy.url().then(url => cy.log('After submitProperty: ' + url));
    cy.document().then(doc => {
      const html = doc.documentElement.getAttribute('lang');
      cy.log('HTML lang on property page: ' + html);
    });

    // Check what text is actually on the page
    cy.get('body').then($body => {
      const hasEnglish = $body.text().includes('Property information');
      const hasFrench = $body.text().includes('Renseignements sur le bien');
      cy.log('Has English text: ' + hasEnglish);
      cy.log('Has French text: ' + hasFrench);
    });
  });
});
