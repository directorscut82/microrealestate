import i18n from '../support/i18n';

const SEED_DATA = {
  user: {
    firstName: 'Pagination',
    lastName: 'Test',
    email: 'pagination@test.com',
    password: 'test1234'
  },
  org: {
    name: 'Pagination Org',
    locale: 'en',
    currency: 'EUR'
  },
  leases: [
    { name: 'Monthly Lease', numberOfTerms: 12, timeRange: 'months' }
  ],
  properties: [],
  tenants: []
};

// Generate 105 tenants to exceed PAGE_LIMIT of 100
for (let i = 1; i <= 105; i++) {
  SEED_DATA.tenants.push({
    name: `Tenant ${String(i).padStart(3, '0')}`,
    leaseName: 'Monthly Lease',
    beginDate: '01/01/2026',
    endDate: '31/12/2026',
    contacts: [{ name: `Contact ${i}`, email: `t${i}@test.com`, phone1: '0000000000', phone2: '' }],
    properties: []
  });
}

// Generate 105 properties
for (let i = 1; i <= 105; i++) {
  SEED_DATA.properties.push({
    name: `Property ${String(i).padStart(3, '0')}`,
    type: 'apartment',
    rent: 500 + i,
    surface: 50
  });
}

describe('Pagination - Load More', () => {
  before(() => {
    cy.resetAppData();
    cy.seedTestData(SEED_DATA);
    cy.signIn({ email: 'pagination@test.com', password: 'test1234' });
    cy.url().should('include', '/dashboard');
  });

  it('Tenants page makes paginated API request and shows Load More', () => {
    cy.intercept('GET', '**/api/v2/tenants*').as('tenantApiRequest');
    cy.navAppMenu('tenants');
    cy.wait('@tenantApiRequest', { timeout: 30000 }).then((interception) => {
      // First request should be paginated with page=1
      expect(interception.request.url).to.include('page=1');
      expect(interception.request.url).to.include('limit=100');
      expect(interception.response.headers['x-total-count']).to.eq('105');
      expect(interception.response.headers['x-total-pages']).to.eq('2');
      // Should return exactly 100 items (page 1 of 2)
      expect(interception.response.body).to.have.length(100);
    });
    cy.contains('Tenant 001', { timeout: 10000 }).should('exist');
    cy.get('[data-cy=loadMoreBtn]').should('be.visible');
  });

  it('Clicking Load More fetches page 2 and button disappears', () => {
    cy.intercept('GET', '**/api/v2/tenants*page=2*').as('tenantsPage2');
    cy.get('[data-cy=loadMoreBtn]').click();
    cy.wait('@tenantsPage2', { timeout: 15000 }).then((interception) => {
      expect(interception.response.statusCode).to.eq(200);
      expect(interception.response.headers['x-total-count']).to.eq('105');
      expect(interception.response.headers['x-page']).to.eq('2');
      // Page 2 should have the remaining 5 items
      expect(interception.response.body).to.have.length(5);
    });
    // All data loaded (100+5=105) — button should disappear
    cy.get('[data-cy=loadMoreBtn]').should('not.exist');
  });

  it('After Load More, search finds tenant from page 2', () => {
    // Tenant 105 was on API page 2 — search should find it
    cy.get('input[placeholder*="Search"]').clear().type('Tenant 105');
    cy.contains('Tenant 105').should('exist');
  });

  it('Properties page shows Load More and fetches page 2', () => {
    cy.intercept('GET', '**/api/v2/properties?*').as('propertiesRequest');
    cy.navAppMenu('properties');
    cy.wait('@propertiesRequest', { timeout: 30000 }).then((interception) => {
      expect(interception.request.url).to.include('page=1');
      expect(interception.response.headers['x-total-count']).to.eq('105');
      expect(interception.response.body).to.have.length(100);
    });
    cy.contains('Property 001', { timeout: 10000 }).should('exist');
    cy.get('[data-cy=loadMoreBtn]').should('be.visible');

    cy.intercept('GET', '**/api/v2/properties?*page=2*').as('propertiesPage2');
    cy.get('[data-cy=loadMoreBtn]').click();
    cy.wait('@propertiesPage2', { timeout: 15000 }).then((interception) => {
      expect(interception.response.statusCode).to.eq(200);
      expect(interception.response.headers['x-page']).to.eq('2');
      expect(interception.response.body).to.have.length(5);
    });
    cy.get('[data-cy=loadMoreBtn]').should('not.exist');
  });

  it('After Load More, search finds property from page 2', () => {
    cy.get('input[placeholder*="Search"]').clear().type('Property 105');
    cy.contains('Property 105').should('exist');
  });
});
