// Pangrati screen capture — non-destructive screenshot spec.
//
// Walks the unauthenticated screens, signs up a new test user, walks the
// firstaccess wizard, then captures the authenticated app surfaces.
// testIsolation: false (cypress.config) means every `it` keeps the previous
// test's state, so the order matters.
//
// Run with:
//   cd e2e && npx cypress run --spec cypress/e2e/99_pangrati_screens.cy.js \
//     --config defaultCommandTimeout=20000,pageLoadTimeout=60000,viewportWidth=1440,viewportHeight=900

describe('Pangrati design tour', () => {
  const stamp = Date.now();
  const user = {
    firstName: 'Maria',
    lastName: 'Pangrati',
    email: `pangrati+${stamp}@design.test`,
    password: 'pangrati1234',
    locale: 'en',
    currency: 'EUR',
    orgName: `Pangrati Tour ${stamp}`
  };

  // Side rail nav at >= 1280px viewport: click the data-cy on the rail item
  // (set by AppMenu's menuItems config). No hamburger.
  const navRail = (key) => {
    cy.get(`[data-cy=${key}Nav]`).should('be.visible').click();
  };

  // Settle window. Charts and fonts may need 1.5s to land.
  const settle = (ms = 1500) => cy.wait(ms);

  it('signin page', () => {
    cy.visit('/signin');
    settle(500);
    cy.contains('Sign in to your account').should('be.visible');
    cy.screenshot('01-signin-desktop', { capture: 'viewport' });
  });

  it('signup page', () => {
    cy.visit('/signup');
    settle(500);
    cy.contains('Sign up and manage your properties online').should('be.visible');
    cy.screenshot('02-signup-desktop', { capture: 'viewport' });
  });

  it('forgot password page', () => {
    cy.visit('/forgotpassword');
    settle(500);
    cy.contains('Reset your password').should('be.visible');
    cy.screenshot('03-forgotpassword-desktop', { capture: 'viewport' });
  });

  it('first access wizard (personal account)', () => {
    cy.signUp(user);
    cy.signIn(user);
    cy.checkUrl('/firstaccess');
    cy.contains('One more step').should('be.visible');
    settle(800);
    cy.screenshot('04-firstaccess-empty', { capture: 'viewport' });
  });

  it('first access wizard (company account)', () => {
    cy.get('[data-cy=companyTrue]').click();
    cy.get('input[name=legalRepresentative]').should('be.visible');
    settle(800);
    cy.screenshot('05-firstaccess-company-form', { capture: 'viewport' });
    cy.get('[data-cy=companyFalse]').click();
  });

  it('dashboard (first connection wizard)', () => {
    // Register the personal-account org so we land on the dashboard.
    cy.registerLandlord(user);
    cy.checkUrl('/dashboard', { timeout: 30000 });
    // Wait for queries + first-render. Welcome line is the marker.
    cy.get('[data-cy=dashboardPage]', { timeout: 30000 }).should('be.visible');
    cy.contains('Welcome', { timeout: 20000 }).should('be.visible');
    // Wait for the spinner to disappear by waiting for any shortcut button.
    cy.get('[data-cy=shortcutAddProperty]', { timeout: 20000 }).should(
      'be.visible'
    );
    settle(2000);
    cy.screenshot('06-dashboard-firstconnection', { capture: 'viewport' });
  });

  it('rents page (empty state)', () => {
    navRail('rents');
    cy.url().should('include', '/rents/');
    settle(2000);
    cy.screenshot('07-rents-empty', { capture: 'viewport' });
  });

  it('tenants page (empty state)', () => {
    navRail('tenants');
    cy.url().should('include', '/tenants');
    settle(1500);
    cy.screenshot('08-tenants-empty', { capture: 'viewport' });
  });

  it('properties page (empty state)', () => {
    navRail('properties');
    cy.url().should('include', '/properties');
    settle(1500);
    cy.screenshot('09-properties-empty', { capture: 'viewport' });
  });

  it('buildings page (empty state)', () => {
    navRail('buildings');
    cy.url().should('include', '/buildings');
    settle(1500);
    cy.screenshot('10-buildings-empty', { capture: 'viewport' });
  });

  it('settings index', () => {
    navRail('settings');
    cy.url().should('include', '/settings');
    settle(1500);
    cy.screenshot('11-settings-index', { capture: 'viewport' });
  });

  it('appearance settings (light)', () => {
    cy.url().then((u) => {
      const orgSegment = u.split('/landlord/')[1].split('/')[0];
      cy.visit(`/${orgSegment}/settings/appearance`);
    });
    cy.get('[data-cy=appearancePage]', { timeout: 20000 }).should('be.visible');
    settle(1000);
    cy.screenshot('12-appearance-light', { capture: 'viewport' });
  });

  it('appearance settings (dark)', () => {
    cy.contains('button', 'Dark', { matchCase: false }).click();
    settle(1500);
    cy.screenshot('13-appearance-dark', { capture: 'viewport' });
    // stay in dark mode for the surface tour below
  });

  it('dashboard (dark)', () => {
    navRail('dashboard');
    cy.url().should('include', '/dashboard');
    settle(2000);
    cy.screenshot('14-dashboard-dark', { capture: 'viewport' });
  });

  it('rents page (dark)', () => {
    navRail('rents');
    cy.url().should('include', '/rents/');
    settle(1500);
    cy.screenshot('15-rents-dark', { capture: 'viewport' });
  });

  it('tenants page (dark)', () => {
    navRail('tenants');
    cy.url().should('include', '/tenants');
    settle(1500);
    cy.screenshot('16-tenants-dark', { capture: 'viewport' });
  });

  it('properties page (dark)', () => {
    navRail('properties');
    cy.url().should('include', '/properties');
    settle(1500);
    cy.screenshot('17-properties-dark', { capture: 'viewport' });
  });

  it('back to light', () => {
    cy.url().then((u) => {
      const orgSegment = u.split('/landlord/')[1].split('/')[0];
      cy.visit(`/${orgSegment}/settings/appearance`);
    });
    cy.get('[data-cy=appearancePage]', { timeout: 20000 }).should('be.visible');
    cy.contains('button', 'Light', { matchCase: false }).click();
    settle(800);
  });
});
