/**
 * What the building's details form sends when «Αποθήκευση» is pressed.
 *
 * It sent the whole loaded record with the form laid over it. The record carries every
 * owner charge stored for the building and grows by the month; the api reads 100 KB of
 * JSON per request. On 24/11/2026 the real 11-apartment building was 489 KB: its details
 * could not be saved (413, «Κάτι πήγε στραβά»). The server keeps only the detail fields,
 * so nothing but the form was ever needed.
 */
import { buildingDetailsRequest } from '../utils/buildingDetails';

const API_JSON_LIMIT = 100 * 1024; // Express's default, which the api keeps

/** A building as the page holds it after a few years: 11 apartments, 2,000 owner charges. */
function loadedBuilding() {
  return {
    _id: 'b0000000000000000000001',
    __v: 41,
    realmId: 'r0000000000000000000001',
    name: 'ΚΤΙΡΙΟ ΑΛΦΑ',
    atakPrefix: '999741',
    address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1', city: 'ΔΟΚΙΜΑΙ', zipCode: '00000' },
    blockNumber: '12',
    blockStreets: 'ΟΔΟΣ ΑΛΦΑ / ΟΔΟΣ ΒΗΤΑ',
    notes: 'παλιά σημείωση',
    createdDate: '2026-01-05T10:00:00.000Z',
    updatedDate: '2026-11-20T10:00:00.000Z',
    units: Array.from({ length: 11 }, (_, i) => ({
      _id: `u${i}`,
      atakNumber: `99974100${String(i + 1).padStart(3, '0')}`,
      propertyId: `p${i}`,
      generalThousandths: 91,
      owners: [{ name: 'ΔΟΚΙΜΗ ΑΛΦΑ', percentage: 100 }],
      monthlyCharges: []
    })),
    expenses: [{ _id: 'e1', name: 'ΑΣΦΑΛΙΣΗ', type: 'insurance', amount: 100 }],
    repairs: [{ _id: 'r1', description: 'ΣΤΕΓΗ', amount: 1200 }],
    contractors: [{ _id: 'c1', name: 'ΔΟΚΙΜΗ ΒΗΤΑ' }],
    ownerMonthlyExpenses: Array.from({ length: 2000 }, (_, i) => ({
      _id: `o${i}`,
      expenseId: 'e1',
      term: 2026010100 + (i % 12) * 10000,
      amount: 9.09,
      description: 'ΑΣΦΑΛΙΣΗ',
      propertyId: `p${i % 11}`,
      source: 'owner-fixed',
      payments: [],
      paid: false,
      paidDate: null
    }))
  };
}

/** What BuildingForm hands to the page on submit (every field the form holds). */
function formPart(over = {}) {
  return {
    name: 'ΚΤΙΡΙΟ ΑΛΦΑ',
    description: '',
    atakPrefix: '999741',
    yearBuilt: '',
    totalFloors: '',
    hasElevator: false,
    hasCentralHeating: false,
    heatingType: '',
    address: {
      street1: 'ΟΔΟΣ ΑΛΦΑ 1',
      street2: '',
      city: 'ΔΟΚΙΜΑΙ',
      zipCode: '00000',
      state: '',
      country: ''
    },
    manager: { name: '', phone: '', email: '', taxId: '', company: '' },
    bankInfo: { name: '', iban: '' },
    sharedMeters: [],
    notes: 'νέα σημείωση',
    ...over
  };
}

describe('what the building details form sends', () => {
  it('is the building’s id and the form — nothing else of the loaded record', () => {
    const part = formPart();
    const sent = buildingDetailsRequest(loadedBuilding(), part);
    expect(Object.keys(sent).sort()).toEqual(
      ['_id', ...Object.keys(part)].sort()
    );
    expect(sent._id).toBe('b0000000000000000000001');
  });

  it.each([
    'ownerMonthlyExpenses',
    'units',
    'expenses',
    'repairs',
    'contractors',
    'blockNumber',
    'blockStreets',
    'realmId',
    '__v',
    'createdDate',
    'updatedDate'
  ])('leaves the record’s «%s» at home', (field) => {
    const building = loadedBuilding();
    expect(building).toHaveProperty(field);
    expect(buildingDetailsRequest(building, formPart())).not.toHaveProperty(
      field
    );
  });

  it('fits the api’s 100 KB however much the building has accumulated', () => {
    const building = loadedBuilding();
    // the record itself is far past the limit — the case that could not be saved
    expect(JSON.stringify(building).length).toBeGreaterThan(API_JSON_LIMIT);
    const sent = JSON.stringify(buildingDetailsRequest(building, formPart()));
    expect(sent.length).toBeLessThan(2 * 1024);
  });

  it('is the same size for a building with no owner charges and one with 2,000', () => {
    const empty = { ...loadedBuilding(), ownerMonthlyExpenses: [] };
    expect(
      JSON.stringify(buildingDetailsRequest(empty, formPart())).length
    ).toBe(
      JSON.stringify(buildingDetailsRequest(loadedBuilding(), formPart()))
        .length
    );
  });

  it('carries what was typed where the record says otherwise', () => {
    const sent = buildingDetailsRequest(
      loadedBuilding(),
      formPart({ name: 'ΚΤΙΡΙΟ ΒΗΤΑ', notes: '' })
    );
    expect(sent.name).toBe('ΚΤΙΡΙΟ ΒΗΤΑ');
    // an emptied field is sent empty, not replaced by the stored text
    expect(sent.notes).toBe('');
  });

  it('carries a field of the form the record never had', () => {
    const building = loadedBuilding();
    expect(building).not.toHaveProperty('sharedMeters');
    const meters = [{ provider: 'deh', supplyNumber: '999741001', label: '' }];
    expect(
      buildingDetailsRequest(building, formPart({ sharedMeters: meters }))
        .sharedMeters
    ).toEqual(meters);
  });

  it('does not change the loaded record or the form’s values', () => {
    const building = loadedBuilding();
    const part = formPart();
    const before = JSON.stringify([building, part]);
    buildingDetailsRequest(building, part);
    expect(JSON.stringify([building, part])).toBe(before);
  });
});
