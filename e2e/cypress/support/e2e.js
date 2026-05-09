// ***********************************************************
// This example support/index.js is processed and
// loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************

import './commands';
import './i18n';

// SAFETY: Verify resetservice is connected to a test database before ANY test runs.
// This prevents catastrophic data loss if resetservice is misconfigured.
before(() => {
  const apiBaseUrl = Cypress.env('GATEWAY_BASEURL');
  cy.request({
    method: 'GET',
    url: `${apiBaseUrl}/api/reset/health`,
    failOnStatusCode: false
  }).then((resp) => {
    if (resp.status === 200 && resp.body?.database) {
      const db = resp.body.database;
      if (db === 'mredb') {
        throw new Error(
          'FATAL: resetservice is connected to production database "mredb". ' +
            'Tests REFUSED to run. Fix MONGO_URL for resetservice to use mredb_test.'
        );
      }
    }
  });
});
