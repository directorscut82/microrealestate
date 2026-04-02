// Real presence awareness test:
// Alice and Bob are both members of the same org.
// Bob views a tenant page (via API heartbeat).
// Alice navigates to the same tenant page in the browser.
// Alice sees "Bob Bernard consulte aussi cette page" banner.

describe('Presence Awareness — Real Two-User Flow', () => {
  const userA = { firstName: 'Alice', lastName: 'Martin', email: 'alice@test.com', password: 'test1234' };
  const userB = { firstName: 'Bob', lastName: 'Bernard', email: 'bob@test.com', password: 'test1234' };

  let realmId, tenantId, propertyId, leaseId, bobToken;

  before(() => {
    cy.resetAppData();
    // Create Bob's account first (seed creates an account)
    cy.seedTestData({
      user: userB,
      org: { name: 'Bob Dummy' },
      leases: [], properties: [], tenants: []
    });
    // Create Alice's org with Bob as a member
    cy.seedTestData({
      user: userA,
      org: {
        name: 'Shared Org',
        locale: 'fr-FR',
        currency: 'EUR',
        members: [{ name: 'Bob Bernard', email: 'bob@test.com', role: 'renter', registered: true }]
      },
      leases: [{ name: 'Bail', description: 'Test', numberOfTerms: 12, timeRange: 'months' }],
      properties: [{ name: 'Apt Shared', type: 'apartment', rent: 500 }],
      tenants: [{
        name: 'Shared Tenant',
        beginDate: '01/04/2026', endDate: '31/03/2027',
        leaseName: 'Bail',
        contacts: [{ name: 'C', email: 'c@t.com', phone1: '01', phone2: '02' }],
        address: { street1: '1 rue', zipCode: '75', city: 'Paris', country: 'France' },
        properties: [{ name: 'Apt Shared', entryDate: '01/04/2026', exitDate: '31/03/2027', expenses: [{ title: 'charges', amount: 50 }] }]
      }]
    }).then((data) => {
      realmId = data.realmId;
      tenantId = data.tenants[0].id;
      propertyId = data.properties['Apt Shared'];
      leaseId = data.leases['Bail'];
    });
    // Get Bob's auth token
    cy.request({
      method: 'POST',
      url: 'http://localhost:8080/api/v2/authenticator/landlord/signin',
      body: { email: userB.email, password: userB.password }
    }).then((resp) => {
      bobToken = resp.body.accessToken;
    });
  });

  // --- Tenant page presence ---

  it('Bob starts viewing tenant page (via API)', () => {
    cy.request({
      method: 'POST',
      url: `http://localhost:8080/api/v2/presence/tenant/${tenantId}`,
      headers: { 'Authorization': `Bearer ${bobToken}`, 'organizationId': realmId }
    }).then((resp) => {
      expect(resp.status).to.eq(200);
    });
  });

  it('Alice signs in and navigates to same tenant', () => {
    cy.signIn(userA);
    cy.checkPage('dashboard');
    cy.navAppMenu('tenants');
    cy.contains('Shared Tenant').click();
    cy.get('[data-cy=tenantPage]').should('be.visible');
  });

  it('Alice sees Bob in the presence banner', () => {
    // The usePresence hook fires a heartbeat which returns Bob as a viewer
    // The PresenceBanner should show "Bob Bernard consulte aussi cette page"
    cy.contains('Bob Bernard', { timeout: 35000 }).should('be.visible');
    cy.contains('consulte aussi cette page').should('be.visible');
  });

  // --- Property page presence ---

  it('Bob starts viewing property page (via API)', () => {
    cy.request({
      method: 'POST',
      url: `http://localhost:8080/api/v2/presence/property/${propertyId}`,
      headers: { 'Authorization': `Bearer ${bobToken}`, 'organizationId': realmId }
    }).then((resp) => {
      expect(resp.status).to.eq(200);
    });
  });

  it('Alice navigates to same property', () => {
    cy.navAppMenu('properties');
    cy.contains('Apt Shared').click();
    cy.get('input[name=name]').should('have.value', 'Apt Shared');
  });

  it('Alice sees Bob on property page', () => {
    cy.contains('Bob Bernard', { timeout: 35000 }).should('be.visible');
  });

  // --- Contract page presence ---

  it('Bob starts viewing contract page (via API)', () => {
    cy.request({
      method: 'POST',
      url: `http://localhost:8080/api/v2/presence/contract/${leaseId}`,
      headers: { 'Authorization': `Bearer ${bobToken}`, 'organizationId': realmId }
    }).then((resp) => {
      expect(resp.status).to.eq(200);
    });
  });

  it('Alice navigates to same contract', () => {
    cy.navOrgMenu('contracts');
    cy.contains('Bail').click();
    cy.get('[data-cy=contractPage]').should('be.visible');
  });

  it('Alice sees Bob on contract page', () => {
    cy.contains('Bob Bernard', { timeout: 35000 }).should('be.visible');
  });

  // --- No presence when alone ---

  it('Alice navigates to a page Bob is NOT viewing', () => {
    cy.navAppMenu('dashboard');
    cy.get('[data-cy=dashboardPage]').should('be.visible');
    // No presence banner on dashboard (Bob isn't viewing it)
    cy.contains('Bob Bernard').should('not.exist');
  });

  after(() => {
    cy.resetAppData();
  });
});
