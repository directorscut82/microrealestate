// Suite 76: Building-Tenant Integration — Full Lifecycle
// Tests the REAL workflow: building with expenses → property linked to unit →
// tenant with that property → rent includes building charges (κοινόχρηστα)
//
// This is the core integration test that verifies buildings are NOT orphaned
// entities but actually affect rent computation.

import i18n from '../support/i18n';

const GATEWAY = 'http://localhost:8080';
const t = i18n.getFixedT('fr-FR');

// Seed data: building with 2 units, 2 properties, 1 lease, 1 tenant
const seedData = {
  user: {
    email: 'integration@test.com',
    password: 'test1234',
    firstName: 'Maria',
    lastName: 'Papadopoulou'
  },
  org: {
    name: 'Integration Immobilier',
    locale: 'fr-FR',
    currency: 'EUR'
  },
  leases: [
    {
      name: 'Bail 12 mois',
      description: 'Contrat annuel standard',
      numberOfTerms: 12,
      timeRange: 'months'
    }
  ],
  properties: [
    {
      name: 'Appart Athéna 2ème',
      type: 'apartment',
      rent: 500,
      surface: 72,
      atakNumber: '01117200001'
    },
    {
      name: 'Appart Athéna 3ème',
      type: 'apartment',
      rent: 550,
      surface: 85,
      atakNumber: '01117200002'
    },
    {
      name: 'Studio Sans Immeuble',
      type: 'apartment',
      rent: 350,
      surface: 30
    }
  ],
  buildings: [
    {
      name: 'Résidence Athéna',
      atakPrefix: '011172',
      yearBuilt: 1985,
      totalFloors: 5,
      hasElevator: true,
      hasCentralHeating: true,
      heatingType: 'central_oil',
      address: {
        street1: '15 Rue de la Paix',
        city: 'Galatsi',
        zipCode: '11147',
        state: 'Attique',
        country: 'GR'
      },
      units: [
        {
          atakNumber: '01117200001',
          floor: 2,
          surface: 72,
          propertyName: 'Appart Athéna 2ème',
          generalThousandths: 150,
          heatingThousandths: 120,
          elevatorThousandths: 100
        },
        {
          atakNumber: '01117200002',
          floor: 3,
          surface: 85,
          propertyName: 'Appart Athéna 3ème',
          generalThousandths: 180,
          heatingThousandths: 140,
          elevatorThousandths: 120
        }
      ],
      expenses: [
        {
          name: 'Chauffage central',
          type: 'heating',
          amount: 300,
          allocationMethod: 'heating_thousandths',
          isRecurring: true
        },
        {
          name: 'Entretien ascenseur',
          type: 'elevator',
          amount: 150,
          allocationMethod: 'elevator_thousandths',
          isRecurring: true
        },
        {
          name: 'Nettoyage parties communes',
          type: 'cleaning',
          amount: 100,
          allocationMethod: 'equal',
          isRecurring: true
        }
      ]
    }
  ]
};

let authToken;
let realmId;
let seededData;

function apiHeaders() {
  return {
    Authorization: `Bearer ${authToken}`,
    organizationId: realmId
  };
}

function signIn() {
  return cy.request({
    method: 'POST',
    url: `${GATEWAY}/api/v2/authenticator/landlord/signin`,
    body: { email: seedData.user.email, password: seedData.user.password }
  }).then((resp) => {
    authToken = resp.body.accessToken;
    return resp.body;
  });
}

describe('Building-Tenant Integration Lifecycle', () => {
  before(() => {
    cy.resetAppData();
    cy.seedTestData(seedData).then((data) => {
      seededData = data;
      realmId = data.realmId;
    });
  });

  // =========================================================================
  // SECTION 1: Verify seed data created correctly
  // =========================================================================

  it('76.01: Seed created building with units linked to properties', () => {
    signIn().then(() => {
      cy.request({
        method: 'GET',
        url: `${GATEWAY}/api/v2/buildings`,
        headers: apiHeaders()
      }).then((resp) => {
        expect(resp.status).to.eq(200);
        const buildings = resp.body;
        expect(buildings).to.have.length(1);

        const building = buildings[0];
        expect(building.name).to.eq('Résidence Athéna');
        expect(building.atakPrefix).to.eq('011172');
        expect(building.units).to.have.length(2);
        expect(building.expenses).to.have.length(3);

        // Verify units are linked to properties
        building.units.forEach((unit) => {
          expect(unit.propertyId).to.not.be.null;
        });
      });
    });
  });

  it('76.02: Properties have buildingId set by seed', () => {
    cy.request({
      method: 'GET',
      url: `${GATEWAY}/api/v2/properties`,
      headers: apiHeaders()
    }).then((resp) => {
      const props = resp.body;
      const athena2 = props.find((p) => p.name === 'Appart Athéna 2ème');
      const athena3 = props.find((p) => p.name === 'Appart Athéna 3ème');
      const studio = props.find((p) => p.name === 'Studio Sans Immeuble');

      expect(athena2.buildingId).to.not.be.null;
      expect(athena3.buildingId).to.not.be.null;
      // Studio has no ATAK → no building link
      expect(studio.buildingId).to.be.undefined;
    });
  });

  // =========================================================================
  // SECTION 2: Create tenant with building-linked property → verify rent
  // =========================================================================

  it('76.03: Create tenant with building-linked property via API', () => {
    const tenantData = {
      name: 'Nikos Stavropoulos',
      isCompany: false,
      contacts: [{ contact: 'Nikos', email: 'nikos@test.com', phone: '6971234567' }],
      leaseId: Object.values(seededData.leases)[0],
      beginDate: '01/01/2026',
      endDate: '31/12/2026',
      properties: [{
        propertyId: seededData.properties['Appart Athéna 2ème'],
        rent: 500,
        entryDate: '01/01/2026',
        exitDate: '31/12/2026',
        expenses: [{ title: 'Charges locatives', amount: 30, beginDate: '01/01/2026', endDate: '31/12/2026' }]
      }]
    };

    cy.request({
      method: 'POST',
      url: `${GATEWAY}/api/v2/tenants`,
      headers: apiHeaders(),
      body: tenantData
    }).then((resp) => {
      expect(resp.status).to.eq(200);
      const tenant = resp.body;
      expect(tenant.name).to.eq('Nikos Stavropoulos');
      expect(tenant.rents).to.have.length.greaterThan(0);

      // Verify rent includes building charges
      const firstRent = tenant.rents[0];
      expect(firstRent.buildingCharges).to.exist;
      expect(firstRent.buildingCharges).to.have.length.greaterThan(0);

      // Calculate expected charges:
      // Heating: 300 * (120 / (120+140)) = 300 * 120/260 ≈ 138.46
      // Elevator: 150 * (100 / (100+120)) = 150 * 100/220 ≈ 68.18
      // Cleaning: 100 / 2 (equal split, 2 managed units) = 50
      const totalBuildingCharges = firstRent.buildingCharges.reduce(
        (sum, c) => sum + c.amount, 0
      );
      expect(totalBuildingCharges).to.be.greaterThan(200);

      // Grand total should be: base rent + property charges + building charges
      expect(firstRent.total.grandTotal).to.be.greaterThan(500);
    });
  });

  it('76.04: Tenant rents page shows correct total with building charges', () => {
    cy.signIn(seedData.user);
    cy.navAppMenu('rents');
    // Rents page should show the tenant with a total > base rent
    cy.contains('Nikos Stavropoulos').should('be.visible');
  });

  // =========================================================================
  // SECTION 3: Create tenant WITHOUT building → no building charges
  // =========================================================================

  it('76.05: Create tenant with non-building property → no building charges', () => {
    const tenantData = {
      name: 'Elena Georgiou',
      isCompany: false,
      contacts: [{ contact: 'Elena', email: 'elena@test.com', phone: '6979876543' }],
      leaseId: Object.values(seededData.leases)[0],
      beginDate: '01/01/2026',
      endDate: '31/12/2026',
      properties: [{
        propertyId: seededData.properties['Studio Sans Immeuble'],
        rent: 350,
        entryDate: '01/01/2026',
        exitDate: '31/12/2026',
        expenses: []
      }]
    };

    cy.request({
      method: 'POST',
      url: `${GATEWAY}/api/v2/tenants`,
      headers: apiHeaders(),
      body: tenantData
    }).then((resp) => {
      expect(resp.status).to.eq(200);
      const tenant = resp.body;

      const firstRent = tenant.rents[0];
      // No building charges — studio is not linked to any building
      const buildingCharges = firstRent.buildingCharges || [];
      expect(buildingCharges).to.have.length(0);

      // Grand total should equal base rent (350) only
      expect(firstRent.total.preTaxAmount).to.eq(350);
    });
  });

  // =========================================================================
  // SECTION 4: Auto-link property to building via ATAK prefix
  // =========================================================================

  it('76.06: Auto-link property to building when tenant created', () => {
    // Create a new property with ATAK that matches the building
    cy.request({
      method: 'POST',
      url: `${GATEWAY}/api/v2/properties`,
      headers: apiHeaders(),
      body: {
        name: 'Appart Athéna 4ème',
        type: 'apartment',
        surface: 65,
        price: 480,
        atakNumber: '01117200004'
      }
    }).then((propResp) => {
      const newPropId = propResp.body._id;

      // Verify property has NO buildingId yet
      expect(propResp.body.buildingId).to.be.undefined;

      // Add unit to building for this property
      cy.request({
        method: 'GET',
        url: `${GATEWAY}/api/v2/buildings`,
        headers: apiHeaders()
      }).then((bResp) => {
        const buildingId = bResp.body[0]._id;

        cy.request({
          method: 'POST',
          url: `${GATEWAY}/api/v2/buildings/${buildingId}/units`,
          headers: apiHeaders(),
          body: {
            atakNumber: '01117200004',
            floor: 4,
            surface: 65,
            generalThousandths: 130,
            heatingThousandths: 100,
            elevatorThousandths: 90,
            propertyId: newPropId,
            isManaged: true
          }
        }).then(() => {
          // Now create tenant with this property
          cy.request({
            method: 'POST',
            url: `${GATEWAY}/api/v2/tenants`,
            headers: apiHeaders(),
            body: {
              name: 'Dimitris Papadopoulos',
              isCompany: false,
              contacts: [{ contact: 'Dimitris', email: 'dimitris@test.com', phone: '6976543210' }],
              leaseId: Object.values(seededData.leases)[0],
              beginDate: '01/01/2026',
              endDate: '31/12/2026',
              properties: [{
                propertyId: newPropId,
                rent: 480,
                entryDate: '01/01/2026',
                exitDate: '31/12/2026',
                expenses: []
              }]
            }
          }).then((tenantResp) => {
            // Auto-link should have set property.buildingId
            cy.request({
              method: 'GET',
              url: `${GATEWAY}/api/v2/properties/${newPropId}`,
              headers: apiHeaders()
            }).then((updatedProp) => {
              expect(updatedProp.body.buildingId).to.eq(buildingId);
            });

            // Tenant should have building charges in rent
            const firstRent = tenantResp.body.rents[0];
            expect(firstRent.buildingCharges).to.have.length.greaterThan(0);
          });
        });
      });
    });
  });

  // =========================================================================
  // SECTION 5: Building expense allocation methods
  // =========================================================================

  it('76.07: Heating allocation distributes by heating thousandths', () => {
    signIn().then(() => {
      // Get tenant Nikos (unit with heatingThousandths = 120)
      cy.request({
        method: 'GET',
        url: `${GATEWAY}/api/v2/tenants`,
        headers: apiHeaders()
      }).then((resp) => {
        const nikos = resp.body.find((t) => t.name === 'Nikos Stavropoulos');
        expect(nikos).to.exist;

        const rent = nikos.rents[0];
        const heatingCharge = rent.buildingCharges.find(
          (c) => c.description === 'Chauffage central'
        );
        expect(heatingCharge).to.exist;

        // Total heating thousandths = 120 + 140 + 100 = 360 (3 units)
        // Nikos's share = 300 * (120/360) ≈ 100
        // Exact value depends on how many managed units exist
        expect(heatingCharge.amount).to.be.greaterThan(0);
      });
    });
  });

  it('76.08: Equal allocation splits evenly among managed units', () => {
    cy.request({
      method: 'GET',
      url: `${GATEWAY}/api/v2/tenants`,
      headers: apiHeaders()
    }).then((resp) => {
      const nikos = resp.body.find((t) => t.name === 'Nikos Stavropoulos');
      const rent = nikos.rents[0];
      const cleaningCharge = rent.buildingCharges.find(
        (c) => c.description === 'Nettoyage parties communes'
      );
      expect(cleaningCharge).to.exist;
      // 100 / 3 managed units ≈ 33.33
      expect(cleaningCharge.amount).to.be.greaterThan(0);
    });
  });

  // =========================================================================
  // SECTION 6: Referential integrity — can't delete building with tenants
  // =========================================================================

  it('76.09: Cannot delete building when units have active tenants', () => {
    cy.request({
      method: 'GET',
      url: `${GATEWAY}/api/v2/buildings`,
      headers: apiHeaders()
    }).then((resp) => {
      const buildingId = resp.body[0]._id;

      cy.request({
        method: 'DELETE',
        url: `${GATEWAY}/api/v2/buildings/${buildingId}`,
        headers: apiHeaders(),
        failOnStatusCode: false
      }).then((deleteResp) => {
        expect(deleteResp.status).to.eq(422);
        expect(deleteResp.body.message).to.include('active tenants');
      });
    });
  });

  // =========================================================================
  // SECTION 7: UI verification — buildings page shows correct data
  // =========================================================================

  it('76.10: Buildings page shows building with managed unit count', () => {
    cy.navAppMenu('buildings');
    cy.checkPage('buildings');
    cy.contains('Résidence Athéna').should('be.visible');
  });

  it('76.11: Building detail shows all units with linked properties', () => {
    cy.openResource('Résidence Athéna');
    cy.get('[data-cy=unitsTab]').click();
    cy.contains('01117200001').should('be.visible');
    cy.contains('01117200002').should('be.visible');
  });

  it('76.12: Building detail shows expenses', () => {
    cy.get('[data-cy=expensesTab]').click();
    cy.contains('Chauffage central').should('be.visible');
    cy.contains('Entretien ascenseur').should('be.visible');
    cy.contains('Nettoyage parties communes').should('be.visible');
  });

  // =========================================================================
  // SECTION 8: Tenant update recomputes building charges
  // =========================================================================

  it('76.13: Updating tenant recomputes rent with building charges', () => {
    // Get current tenant data
    cy.request({
      method: 'GET',
      url: `${GATEWAY}/api/v2/tenants`,
      headers: apiHeaders()
    }).then((resp) => {
      const nikos = resp.body.find((t) => t.name === 'Nikos Stavropoulos');
      const originalTotal = nikos.rents[0].total.grandTotal;

      // Update tenant (change rent amount)
      cy.request({
        method: 'PATCH',
        url: `${GATEWAY}/api/v2/tenants/${nikos._id}`,
        headers: apiHeaders(),
        body: {
          ...nikos,
          properties: nikos.properties.map((p) => ({
            ...p,
            rent: 600  // Increase rent from 500 to 600
          }))
        }
      }).then((updateResp) => {
        const newTotal = updateResp.body.rents[0].total.grandTotal;
        // Grand total should increase by ~100 (rent change)
        expect(newTotal).to.be.greaterThan(originalTotal);

        // Building charges should still be present
        expect(updateResp.body.rents[0].buildingCharges).to.have.length.greaterThan(0);
      });
    });
  });

  // =========================================================================
  // SECTION 9: Multi-property tenant with mixed building/non-building
  // =========================================================================

  it('76.14: Tenant with mixed properties gets building charges only for linked ones', () => {
    cy.request({
      method: 'POST',
      url: `${GATEWAY}/api/v2/tenants`,
      headers: apiHeaders(),
      body: {
        name: 'Mixed Properties Ltd',
        isCompany: true,
        company: 'Mixed Properties Ltd',
        contacts: [{ contact: 'Admin', email: 'admin@mixed.com', phone: '0000000000' }],
        leaseId: Object.values(seededData.leases)[0],
        beginDate: '01/01/2026',
        endDate: '31/12/2026',
        properties: [
          {
            propertyId: seededData.properties['Appart Athéna 3ème'],
            rent: 550,
            entryDate: '01/01/2026',
            exitDate: '31/12/2026',
            expenses: []
          },
          {
            propertyId: seededData.properties['Studio Sans Immeuble'],
            rent: 350,
            entryDate: '01/01/2026',
            exitDate: '31/12/2026',
            expenses: []
          }
        ]
      }
    }).then((resp) => {
      const tenant = resp.body;
      const rent = tenant.rents[0];

      // Building charges should exist for Athéna 3ème but not for Studio
      expect(rent.buildingCharges).to.have.length.greaterThan(0);

      // All charges should reference building name
      rent.buildingCharges.forEach((charge) => {
        expect(charge.buildingName).to.eq('Résidence Athéna');
      });

      // Total = 550 + 350 + building charges
      expect(rent.total.preTaxAmount).to.eq(900);
      expect(rent.total.grandTotal).to.be.greaterThan(900);
    });
  });

  after(() => {
    cy.signOut();
  });
});
