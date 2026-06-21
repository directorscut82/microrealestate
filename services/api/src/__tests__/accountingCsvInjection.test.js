/* eslint-env node, jest */
/**
 * CSV formula-injection on the accounting exports — round-2 audit H8.
 *
 * `_sanitizeCsvText` exists (accountingmanager.ts) but was wired ONLY into the
 * rawData=true (React/JSON) branch of _settlements — the path json2csv never
 * serialises. The three real CSV exports call the builders with rawData=false
 * and emit tenant-controlled name / reference / property names / payment
 * reference RAW. A tenant named `=cmd|'/C calc'!A1` (accepted by the name
 * validator) ships an active formula into Excel/Sheets.
 *
 * Fix: run _sanitizeCsvText over those fields on the rawData=false branches so
 * a leading =,+,-,@ is prefixed with a single quote (json2csv only escapes
 * quotes/newlines, not formula prefixes).
 *
 * type: module → jest.unstable_mockModule + dynamic import. Only Collections is
 * mocked; i18n/json2csv/moment load for real.
 */
import { jest } from '@jest/globals';
import i18n from 'i18n';

let accountingManager;
const m = { aggregate: jest.fn() };

beforeAll(async () => {
  // The handlers call i18n.setLocale + i18n.__; configure a minimal in-memory
  // catalog so __() echoes the key (updateFiles:false → no disk writes).
  i18n.configure({
    locales: ['en'],
    defaultLocale: 'en',
    objectNotation: false,
    updateFiles: false,
    syncFiles: false,
    staticCatalog: { en: {} }
  });
  class ServiceError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  // accountingmanager now imports ownermanager (for the owner-settlements
  // export), which imports OwnerStatement from common — provide the REAL util so
  // the mock is complete.
  const OwnerStatement = await import(
    '../../../common/src/utils/ownerstatement.ts'
  );
  jest.unstable_mockModule('@microrealestate/common', () => ({
    Collections: {
      Tenant: { aggregate: (...a) => m.aggregate(...a) }
    },
    ServiceError,
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    OwnerStatement
  }));
  accountingManager = await import('../managers/accountingmanager.js');
});

function makeRes() {
  const res = {
    header: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
    status: jest.fn()
  };
  res.header.mockReturnValue(res);
  res.status.mockReturnValue(res);
  return res;
}

const HOSTILE_NAME = "=cmd|'/C calc'!A1";
const HOSTILE_REF = '+1+1';
const HOSTILE_PROP = '@evil';
const HOSTILE_PAYREF = '=HYPERLINK("http://evil","x")';

const REQ = {
  realm: { _id: 'r1', locale: 'en', currency: 'EUR' },
  params: { year: '2026' }
};

// A tenant that is BOTH incoming (begin in-year) and outgoing (terminated
// in-year), with a year-matching rent carrying a hostile payment reference.
function hostileTenant() {
  return {
    _id: 't1',
    name: HOSTILE_NAME,
    reference: HOSTILE_REF,
    beginDate: new Date('2026-02-01T00:00:00Z'),
    endDate: new Date('2026-12-31T00:00:00Z'),
    terminationDate: new Date('2026-11-30T00:00:00Z'),
    incoming: true,
    outgoing: true,
    guaranty: 0,
    guarantyPayback: 0,
    properties: [{ _id: 'p1', name: HOSTILE_PROP, type: 'apartment' }],
    rents: [
      {
        year: 2026,
        month: 3,
        total: { grandTotal: 100, payment: 100 },
        payments: [
          { date: '15/03/2026', type: 'cash', amount: 100, reference: HOSTILE_PAYREF }
        ]
      }
    ]
  };
}

// Any cell whose first non-quote char is a formula prefix is dangerous.
function hasUnescapedFormula(csv) {
  // Split into cells across rows (delimiter ';', json2csv quotes fields with
  // special chars). A safe cell either does not start with =,+,-,@ OR is the
  // sanitized form starting with a single quote.
  const cells = csv.split(/[;\n\r]+/).map((c) => c.trim().replace(/^"|"$/g, ''));
  return cells.some((c) => /^[=+\-@]/.test(c));
}

describe('H8 — accounting CSV exports sanitize formula-injection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    m.aggregate.mockResolvedValue([hostileTenant()]);
  });

  it('incoming CSV neutralizes a formula-prefixed name/reference/property', async () => {
    const res = makeRes();
    await accountingManager.csv.incomingTenants(REQ, res);
    const csv = res.send.mock.calls[0][0];
    // FAILING-FIRST: today name/reference/properties ship raw → a cell starts
    // with =,+,@ → fails. After the fix each is prefixed with a single quote.
    expect(hasUnescapedFormula(csv)).toBe(false);
  });

  it('outgoing CSV neutralizes a formula-prefixed name/reference/property', async () => {
    const res = makeRes();
    await accountingManager.csv.outgoingTenants(REQ, res);
    const csv = res.send.mock.calls[0][0];
    expect(hasUnescapedFormula(csv)).toBe(false);
  });

  it('settlements XLSX neutralizes a formula-prefixed composite tenant cell + payment reference', async () => {
    // CS1/CS2: settlements now exports a real .xlsx (buffer), not a CSV string.
    // The H8 formula-injection guard must still hold: no string cell may start
    // with =,+,-,@ (Excel would evaluate it). _sanitizeCsvText is still applied
    // to name/reference/properties on the xlsx rows; assert by reading the
    // workbook back and inspecting every string cell value.
    const res = makeRes();
    await accountingManager.csv.settlements(REQ, res);
    const buf = res.send.mock.calls[0][0];
    expect(Buffer.isBuffer(buf)).toBe(true);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    const offending = [];
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === 'string' && /^[=+\-@]/.test(cell.value)) {
          offending.push(cell.value);
        }
      });
    });
    expect(offending).toEqual([]);
  });

  it('benign data is byte-unchanged (no spurious quoting)', async () => {
    m.aggregate.mockResolvedValue([
      {
        ...hostileTenant(),
        name: 'Alice Normal',
        reference: 'REF-2026-01',
        properties: [{ _id: 'p1', name: 'Apartment 1', type: 'apartment' }],
        rents: [
          {
            year: 2026,
            month: 3,
            total: { grandTotal: 100, payment: 100 },
            payments: [{ date: '15/03/2026', type: 'cash', amount: 100, reference: 'OK-REF' }]
          }
        ]
      }
    ]);
    const res = makeRes();
    await accountingManager.csv.incomingTenants(REQ, res);
    const csv = res.send.mock.calls[0][0];
    expect(csv).toContain('Alice Normal');
    expect(csv).not.toContain("'Alice"); // no leading quote added to benign data
  });
});
