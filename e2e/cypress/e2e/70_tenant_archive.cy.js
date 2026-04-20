import i18n from '../support/i18n';

describe('Tenant Archive', { testIsolation: false }, () => {
  const t = i18n.getFixedT('fr-FR');
  const user = {
    firstName: 'Archive', lastName: 'Test',
    email: 'archive@test.com', password: 'test1234'
  };

  before(() => {
    cy.resetAppData();
    cy.seedTestData({
      user,
      org: { name: 'Archive Test Org', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail Test', numberOfTerms: 36, timeRange: 'months' }],
      properties: [{ name: 'Apt Test', type: 'apartment', rent: 500 }],
      tenants: [{
        name: 'Locataire Archive',
        beginDate: '01/04/2026', endDate: '31/03/2029',
        leaseName: 'Bail Test',
        contacts: [{ name: 'Contact A', email: 'a@test.com', phone1: '0600000001' }],
        properties: [{ name: 'Apt Test', entryDate: '01/04/2026', exitDate: '31/03/2029', expenses: [{ title: 'charges', amount: 10 }] }]
      }]
    });
    cy.signIn(user);
  });

  it('Tenant visible in list', () => {
    cy.navAppMenu('tenants');
    cy.contains('Locataire Archive').should('be.visible');
  });

  it('Archive button visible on tenant detail', () => {
    cy.openResource('Locataire Archive');
    cy.get('[data-cy=archiveResourceButton]').should('be.visible');
  });

  it('Archive tenant hides from list', () => {
    cy.get('[data-cy=archiveResourceButton]').click();
    cy.get('[data-cy=tenantsPage]', { timeout: 10000 }).should('be.visible');
    cy.contains('Locataire Archive').should('not.exist');
  });

  it('Show archived toggle reveals archived tenant', () => {
    cy.get('[data-cy=showArchivedToggle]').click();
    cy.contains('Locataire Archive', { timeout: 10000 }).should('be.visible');
    cy.contains(t('Archived')).should('be.visible');
  });

  it('Archived tenant detail shows unarchive button', () => {
    cy.openResource('Locataire Archive');
    cy.get('[data-cy=archiveResourceButton]').contains(t('Unarchive'));
  });

  it('Unarchive tenant brings back to list', () => {
    cy.get('[data-cy=archiveResourceButton]').click();
    cy.get('[data-cy=tenantsPage]', { timeout: 10000 }).should('be.visible');
    cy.get('[data-cy=showArchivedToggle]').click();
    cy.contains('Locataire Archive', { timeout: 10000 }).should('be.visible');
  });
});
