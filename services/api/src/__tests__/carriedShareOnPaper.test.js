/* eslint-env node, jest */
/**
 * A share of a building charge billed on a LATER month than the one it is for
 * (DEFERRED_DECISIONS D-10) says which month it is for wherever the tenant reads it:
 * the printed rent notice and receipt, and the rent-call e-mail. Owner's wording:
 * «… · για Οκτώβριο 2026».
 *
 * The pdfgenerator and the emailer have no test suite of their own, so this one
 * renders their REAL templates with their REAL template helpers and locale files
 * (cross-workspace imports, as newExpenseTypesReachMoneySurfaces.test.js does), and
 * runs the real function that attaches the calculation line to a receipt.
 */
import { createRequire } from 'module';
import ejs from 'ejs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const PDF = path.join(REPO, 'services/pdfgenerator');
const MAIL = path.join(REPO, 'services/emailer/src');

const OCT = 2026100100;
const NOV = 2026110100;

// The lines of a November rent: November's own share of the power, and October's,
// which arrived after October was over.
const own = {
  description: 'Common power',
  amount: 40,
  buildingName: 'Building 1',
  type: 'electricity_common',
  propertyId: 'A',
  expenseId: 'power'
};
const carried = { ...own, amount: 30, forTerm: OCT };

const pick = (mod, name) => mod[name] ?? mod.default?.[name] ?? mod.default;
const text = (html) =>
  html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

describe('the printed notice and receipt', () => {
  let helpers;
  let body;
  beforeAll(async () => {
    const mod = await import(
      '../../../pdfgenerator/src/utils/templatefunctions.js'
    );
    helpers = pick(mod, 'default');
    body = fs.readFileSync(
      path.join(PDF, 'templates/partials/invoicebody.ejs'),
      'utf8'
    );
  });
  const render = (lines, locale = 'el') =>
    text(
      ejs.render(body, {
        rent: {
          preTaxAmounts: [{ description: 'Apt A', amount: 400 }],
          buildingCharges: lines,
          discounts: [],
          debts: [],
          charges: []
        },
        _: helpers({ locale, currency: 'EUR' })
      })
    );

  it('a share carried in says which month it is for; the month’s own line reads as it always did', () => {
    const lines = render([own, carried]);
    expect(lines).toContain('Κοινόχρηστο Ρεύμα  (Building 1 - Common power)');
    expect(lines).toContain(
      'Κοινόχρηστο Ρεύμα  (Building 1 - Common power) · για Οκτώβριο 2026'
    );
    // nothing else changed on the page: one line with the month, and only one
    expect(lines.filter((l) => l.includes('για '))).toHaveLength(1);
  });

  it('in English', () => {
    expect(render([carried], 'en')).toContain(
      'Electricity Common  (Building 1 - Common power) · for October 2026'
    );
  });

  it.each([
    ['a text', 'October'],
    ['a fraction', OCT + 0.5],
    ['null', null],
    ['a month that does not exist', 2026130100]
  ])('a line whose month is %s prints no month', (_what, forTerm) => {
    const lines = render([{ ...own, forTerm }]);
    expect(lines).toContain('Κοινόχρηστο Ρεύμα  (Building 1 - Common power)');
    expect(lines.filter((l) => l.includes('για '))).toHaveLength(0);
  });

  it('its calculation line is printed under it like any other', () => {
    const lines = render([
      {
        ...carried,
        basis: { kind: 'equal', total: 60, count: 2, share: 30 }
      }
    ]);
    const at = lines.findIndex((l) => l.endsWith('· για Οκτώβριο 2026'));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe('60,00 € ÷ 2 μονάδες = 30,00 €');
  });

  it('every month of the year, in the case «για» asks for', () => {
    const _ = helpers({ locale: 'el', currency: 'EUR' });
    expect(
      Array.from({ length: 12 }, (x, i) =>
        _.formatTermFor(`2026${String(i + 1).padStart(2, '0')}0100`)
      )
    ).toEqual([
      'Ιανουάριο 2026',
      'Φεβρουάριο 2026',
      'Μάρτιο 2026',
      'Απρίλιο 2026',
      'Μάιο 2026',
      'Ιούνιο 2026',
      'Ιούλιο 2026',
      'Αύγουστο 2026',
      'Σεπτέμβριο 2026',
      'Οκτώβριο 2026',
      'Νοέμβριο 2026',
      'Δεκέμβριο 2026'
    ]);
    expect(_.formatTermFor(OCT)).toBe('Οκτώβριο 2026');
    expect(_.formatTermFor('nothing')).toBe('');
    expect(_.formatTermFor(undefined)).toBe('');
    expect(helpers({ locale: 'en', currency: 'EUR' }).formatTermFor(OCT)).toBe(
      'October 2026'
    );
  });

  it.each(['el', 'en', 'fr-FR', 'de-DE', 'es-CO', 'pt-BR'])(
    'the wording exists in %s',
    (locale) => {
      const strings = JSON.parse(
        fs.readFileSync(
          path.join(PDF, 'templates/locales', `${locale}.json`),
          'utf8'
        )
      );
      expect(strings['for {{month}}']).toMatch(/\{\{month\}\}/);
      const mail = JSON.parse(
        fs.readFileSync(path.join(MAIL, 'locales', `${locale}.json`), 'utf8')
      );
      expect(mail['for {{month}}']).toBe(strings['for {{month}}']);
    }
  );
});

describe('the calculation line of a receipt', () => {
  let enrich;
  beforeAll(async () => {
    const mod = await import('../../../pdfgenerator/data/index.js');
    enrich = pick(mod, '_enrichTenantChargeBasis');
  });

  const expense = (allocationMethod) => ({
    _id: 'power',
    name: 'Common power',
    type: 'electricity_common',
    amount: 0,
    allocationMethod,
    customAllocations: []
  });
  const row = (month, amount, inputAmount) => ({
    term: month,
    amount,
    inputAmount,
    description: 'Common power',
    expenseId: 'power',
    repairId: null
  });
  const unit = (id, rows = []) => ({
    propertyId: id,
    generalThousandths: 500,
    surface: 80,
    monthlyCharges: rows
  });

  it('a carried share is explained with the figures of the month it is FOR', () => {
    // October's statement was 60, November's is 80; the unit pays half.
    const building = {
      units: [unit('A', [row(OCT, 30, 60), row(NOV, 40, 80)]), unit('B')],
      expenses: [expense('general_thousandths')]
    };
    const [ownLine, carriedLine] = enrich([own, carried], building, 'A', NOV);
    expect(ownLine.basis).toEqual({
      kind: 'thousandths',
      part: 500,
      whole: 1000,
      total: 80,
      share: 40
    });
    // with November's figure this read «500 ÷ 1000 × 80 = 30» and was dropped,
    // or — when the two months happen to agree — printed November's equation
    expect(carriedLine.basis).toEqual({
      kind: 'thousandths',
      part: 500,
      whole: 1000,
      total: 60,
      share: 30
    });
  });

  it('…and with the number of parties of that month', () => {
    // The tenant held units A and B in October and gave up B on the 31st. October:
    // 40 ÷ 2 parties (the tenant, and vacant C) = 20. November: 60 ÷ 3 = 20.
    const building = {
      units: [
        unit('A', [row(OCT, 20, 40), row(NOV, 20, 60)]),
        unit('B'),
        unit('C')
      ],
      expenses: [expense('equal')],
      _tenantGroups: [
        {
          propertyIds: ['A', 'B'],
          beginDate: new Date('2026-07-01T00:00:00Z'),
          endDate: new Date('2027-06-30T00:00:00Z'),
          terminationDate: null,
          properties: [
            { propertyId: 'A' },
            { propertyId: 'B', exitDate: new Date('2026-10-31T00:00:00Z') }
          ]
        }
      ]
    };
    const [ownLine, carriedLine] = enrich(
      [
        { ...own, amount: 20 },
        { ...carried, amount: 20 }
      ],
      building,
      'A',
      NOV
    );
    expect(ownLine.basis).toEqual({
      kind: 'equal',
      count: 3,
      total: 60,
      share: 20
    });
    expect(carriedLine.basis).toEqual({
      kind: 'equal',
      count: 2,
      total: 40,
      share: 20
    });
  });

  it('…of its own unit, when the tenant has two', () => {
    const building = {
      units: [
        unit('A', [row(NOV, 40, 80)]),
        { ...unit('B', [row(OCT, 15, 60)]), generalThousandths: 250 },
        { ...unit('C'), generalThousandths: 250 }
      ],
      expenses: [expense('general_thousandths')]
    };
    const [, carriedLine] = enrich(
      [own, { ...carried, propertyId: 'B', amount: 15 }],
      building,
      'A',
      NOV
    );
    expect(carriedLine.basis).toEqual({
      kind: 'thousandths',
      part: 250,
      whole: 1000,
      total: 60,
      share: 15
    });
  });

  it.each([
    ['its month has no statement row', { forTerm: 2026090100 }],
    ['its expense is gone', { expenseId: 'gone' }],
    ['its unit is gone', { propertyId: 'gone' }],
    ['it names no expense', { expenseId: undefined }],
    ['the figures do not add up to it', { amount: 31 }]
  ])('correct or absent: no line when %s', (_what, change) => {
    const building = {
      units: [unit('A', [row(OCT, 30, 60), row(NOV, 40, 80)]), unit('B')],
      expenses: [expense('general_thousandths')]
    };
    const [, carriedLine] = enrich(
      [own, { ...carried, ...change }],
      building,
      'A',
      NOV
    );
    expect(carriedLine.basis).toBeUndefined();
    // and the line itself is handed on untouched
    expect(carriedLine).toEqual({ ...carried, ...change });
  });

  it('the lines of the month itself are explained exactly as before', () => {
    // no ids on the line (stored before lines carried them): matched by type and name
    const building = {
      units: [unit('A', [row(NOV, 40, 80)]), unit('B')],
      expenses: [expense('general_thousandths')]
    };
    const old = {
      description: 'Common power',
      amount: 40,
      buildingName: 'Building 1',
      type: 'electricity_common'
    };
    expect(enrich([old], building, 'A', NOV)[0].basis).toEqual({
      kind: 'thousandths',
      part: 500,
      whole: 1000,
      total: 80,
      share: 40
    });
  });
});

describe('the rent-call e-mail', () => {
  let helpers;
  beforeAll(async () => {
    const mod = await import('../../../emailer/src/utils/templatefunctions.js');
    helpers = pick(mod, 'default');
    // The emailer's own copy of the i18n module (not this package's), configured as
    // services/emailer/src/index.ts configures it: its own strings, not the PDF's.
    const emailerI18n = await import(
      createRequire(path.join(MAIL, 'index.ts')).resolve('i18n')
    );
    (emailerI18n.default ?? emailerI18n).configure({
      locales: ['en', 'fr-FR', 'pt-BR', 'de-DE', 'es-CO', 'el'],
      directory: path.join(MAIL, 'locales'),
      updateFiles: false
    });
  });

  const data = (locale) => ({
    landlord: {
      name: 'Landlord',
      hasBankInfo: false,
      hasContact: false,
      hasAddress: false
    },
    tenant: {
      name: 'Tenant',
      street1: '',
      zipCode: '',
      city: '',
      contract: { lease: { timeRange: 'months' } },
      rents: [
        {
          term: NOV,
          preTaxAmounts: [{ description: 'Apt A', amount: 400 }],
          charges: [],
          buildingCharges: [own, carried],
          total: {
            discount: 0,
            debts: 0,
            vat: 0,
            balance: 0,
            grandTotal: 470
          }
        }
      ]
    },
    period: String(NOV),
    _: helpers({ locale, currency: 'EUR' })
  });
  const mail = (file, locale = 'el') =>
    ejs.renderFile(
      path.join(MAIL, 'emailparts/contents/rentcall', file),
      data(locale)
    );

  it('the page: the carried share says which month it is for', async () => {
    const lines = text(await mail('body_html.ejs'));
    // the emailer's own Greek strings are the ones in use
    expect(lines).toContain('Γεια σας,');
    expect(lines).toContain('Building 1 - Common power');
    expect(lines).toContain('Building 1 - Common power · για Οκτώβριο 2026');
    expect(lines.filter((l) => l.includes('· για '))).toHaveLength(1);
  });

  it('the plain text: the same', async () => {
    // (amounts come with a no-break space before the €)
    const lines = (await mail('body_text.ejs'))
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((l) => l.trim());
    expect(lines).toContain('Γεια σας,');
    expect(lines).toContain('- Building 1 - Common power: 40,00 €');
    expect(lines).toContain(
      '- Building 1 - Common power · για Οκτώβριο 2026: 30,00 €'
    );
  });

  it('in English', async () => {
    const lines = text(await mail('body_html.ejs', 'en'));
    expect(lines).toContain('Building 1 - Common power · for October 2026');
  });

  it('the same helper as the printed page', () => {
    expect(helpers({ locale: 'el', currency: 'EUR' }).formatTermFor(OCT)).toBe(
      'Οκτώβριο 2026'
    );
    expect(helpers({ locale: 'el', currency: 'EUR' }).formatTermFor('x')).toBe(
      ''
    );
  });
});
