import i18n from '../support/i18n';

// Multi-landlord isolation using API seeding
// Create two landlords with separate orgs, verify data isolation

describe('Multi-Landlord Isolation via API', () => {
  const t = i18n.getFixedT('fr-FR');

  const landlordA = {
    firstName: 'Alice', lastName: 'Martin',
    email: 'alice@test.com', password: 'test1234'
  };
  const landlordB = {
    firstName: 'Bob', lastName: 'Bernard',
    email: 'bob@test.com', password: 'test1234'
  };

  before(() => {
    cy.resetAppData();
    // Seed landlord A with data
    cy.seedTestData({
      user: landlordA,
      org: { name: 'Alice Properties', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail Alice', description: 'Contrat Alice', numberOfTerms: 36, timeRange: 'months' }],
      properties: [
        { name: 'Studio Alice', type: 'apartment', rent: 500 },
        { name: 'Bureau Alice', type: 'office', rent: 1200 }
      ],
      tenants: [
        {
          name: 'Tenant of Alice',
          beginDate: '01/04/2026', endDate: '31/03/2029',
          leaseName: 'Bail Alice',
          contacts: [{ name: 'Tenant A', email: 'tenantA@test.com', phone1: '0100000001', phone2: '0100000002' }],
          address: { street1: '1 rue Alice', zipCode: '75001', city: 'Paris', country: 'France' },
          properties: [{ name: 'Studio Alice', entryDate: '01/04/2026', exitDate: '31/03/2029', expenses: [{ title: 'charges', amount: 50 }] }]
        }
      ]
    });
    // Seed landlord B with different data
    cy.seedTestData({
      user: landlordB,
      org: { name: 'Bob Rentals', locale: 'fr-FR', currency: 'EUR' },
      leases: [{ name: 'Bail Bob', description: 'Contrat Bob', numberOfTerms: 12, timeRange: 'months' }],
      properties: [{ name: 'Garage Bob', type: 'garage', rent: 80 }],
      tenants: []
    });
  });

  // --- Landlord A sees only their data ---

  it('Alice signs in', () => {
    cy.signIn(landlordA);
    cy.checkPage('dashboard');
  });

  it('Alice sees her properties', () => {
    cy.navAppMenu('properties');
    cy.contains('Studio Alice').should('be.visible');
    cy.contains('Bureau Alice').should('be.visible');
  });

  it('Alice does NOT see Bob properties', () => {
    cy.contains('Garage Bob').should('not.exist');
  });

  it('Alice sees her tenant', () => {
    cy.navAppMenu('tenants');
    cy.contains('Tenant of Alice').should('be.visible');
  });

  it('Alice sees her contract', () => {
    cy.navOrgMenu('contracts');
    cy.contains('Bail Alice').should('be.visible');
    cy.contains('Bail Bob').should('not.exist');
  });

  it('Alice signs out', () => {
    cy.signOut();
  });

  // --- Landlord B sees only their data ---

  it('Bob signs in', () => {
    cy.signIn(landlordB);
    cy.checkPage('dashboard');
  });

  it('Bob sees his property', () => {
    cy.navAppMenu('properties');
    cy.contains('Garage Bob').should('be.visible');
  });

  it('Bob does NOT see Alice properties', () => {
    cy.contains('Studio Alice').should('not.exist');
    cy.contains('Bureau Alice').should('not.exist');
  });

  it('Bob does NOT see Alice tenants', () => {
    cy.navAppMenu('tenants');
    cy.contains('Tenant of Alice').should('not.exist');
  });

  it('Bob sees his contract', () => {
    cy.navOrgMenu('contracts');
    cy.contains('Bail Bob').should('be.visible');
    cy.contains('Bail Alice').should('not.exist');
  });

  it('Bob signs out', () => {
    cy.signOut();
  });

  // --- Verify Alice data still intact ---

  it('Alice signs back in — data intact', () => {
    cy.signIn(landlordA);
    cy.checkPage('dashboard');
    cy.navAppMenu('tenants');
    cy.contains('Tenant of Alice').should('be.visible');
    cy.navAppMenu('properties');
    cy.contains('Studio Alice').should('be.visible');
  });

  after(() => {
    cy.resetAppData();
  });
});
