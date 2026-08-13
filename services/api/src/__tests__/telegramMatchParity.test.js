/**
 * The Telegram ingest path and the upload dialog must resolve a bill IDENTICALLY.
 *
 * WHY THIS EXISTS: Slice 4 (`9dffa425`, 2026-07-25) gave the poller a hand-copied
 * reimplementation of `findExpenseByBillingId`, with a comment asserting "same
 * matching rule as parseBills". That was true the day it was written. It became
 * false when the upload path learned to compare the 9-digit body of a ΔΕΗ παροχή
 * (suffix-insensitive), and nothing went red — because the existing scanner suite
 * injects `findMatch` as a stub, so the real matcher was never executed by any
 * test. A bill photographed to the bot then failed to match an expense the SAME
 * bill matched when uploaded.
 *
 * These tests execute the REAL `_findMatch` (via the exported deps factory) so the
 * two surfaces cannot silently diverge again.
 */
import { jest } from '@jest/globals';

// Realm data both matchers read. The expense carries the παροχή with the ΔΕΗ
// check suffix; the incoming bill will normalise to the bare-plus-suffix form and
// a stored bare value must still match — that is the whole point.
// Swappable so one test can present an AMBIGUOUS realm to the same live matchers.
let BUILDINGS = [];
const DEFAULT_BUILDINGS = [
  {
    _id: 'bldg-1',
    name: 'ΟΔΟΣ ΗΤΑ 24',
    // Expense stores the παροχή WITHOUT the check suffix (how E9/manual entry
    // leaves it); the bill prints it WITH the suffix.
    expenses: [
      { _id: 'exp-1', name: 'Ρεύμα κοινοχρήστων', billingId: '999935585' }
    ],
    units: [],
    sharedMeters: []
  },
  {
    _id: 'bldg-2',
    name: 'ΟΔΟΣ ΒΗΤΑ 9',
    expenses: [],
    units: [],
    // A κοινόχρηστος meter — the copied matcher could not see these at all.
    sharedMeters: [
      { provider: 'deh', supplyNumber: '999000777', label: 'Κλιμακοστάσιο' }
    ]
  },
  {
    _id: 'bldg-4',
    name: 'ΟΔΟΣ ΔΕΛΤΑ 7',
    expenses: [],
    // A telecom line and a water supply recorded on APARTMENTS. The matcher used to
    // read `electricitySupplyNumber` alone, so a NOVA or ΕΥΔΑΠ bill for one flat was
    // unmatchable and telecom_private / water_private could never be reached by a
    // real bill — whatever the landlord typed on the apartment.
    units: [
      {
        _id: 'u-tel',
        propertyId: 'prop-tel',
        name: 'Δ1',
        telecomNumber: '999555111'
      },
      {
        _id: 'u-wat',
        propertyId: 'prop-wat',
        name: 'Δ2',
        eydapNumber: '999666222'
      }
    ],
    sharedMeters: []
  },
  {
    _id: 'bldg-3',
    name: 'ΟΔΟΣ ΓΑΜΑ 12',
    expenses: [],
    // An APARTMENT's own παροχή — the third tier. Stored bare, as the E9 import
    // writes it; the bill prints it with the check suffix.
    units: [
      {
        _id: 'u-1',
        propertyId: 'prop-1',
        name: 'Α2',
        electricitySupplyNumber: '999123456'
      }
    ],
    sharedMeters: []
  }
];

// TWO expenses claim one παροχή, and a THIRD building has it as a shared meter.
// The ambiguity must win: the operator decides, and no weaker source is proposed.
const AMBIGUOUS_BUILDINGS = [
  {
    _id: 'amb-X',
    name: 'ΟΔΟΣ ΑΛΦΑ 1',
    expenses: [{ _id: 'x1', name: 'Ρεύμα', billingId: '999935585' }],
    units: [],
    sharedMeters: []
  },
  {
    _id: 'amb-Y',
    name: 'ΟΔΟΣ ΒΗΤΑ 2',
    expenses: [{ _id: 'y1', name: 'Ρεύμα', billingId: '999935585' }],
    units: [],
    sharedMeters: []
  },
  {
    _id: 'amb-Z',
    name: 'ΟΔΟΣ ΓΑΜΑ 3',
    expenses: [],
    units: [],
    sharedMeters: [{ provider: 'deh', supplyNumber: '999935585' }]
  }
];

beforeEach(() => {
  BUILDINGS = DEFAULT_BUILDINGS;
});

let findMatch;
let findExpenseByBillingId;
let findSharedMeter;
let findExpenseMatch;

beforeAll(async () => {
  await jest.unstable_mockModule('@microrealestate/common', () => {
    class ServiceError extends Error {
      constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
      }
    }
    return {
      Collections: {
        Building: { find: () => ({ lean: async () => BUILDINGS }) },
        Realm: { find: () => ({ lean: async () => [] }) },
        TelegramOffset: {},
        InboxItem: {},
        Property: { find: () => ({ lean: async () => [] }) },
        Tenant: { find: () => ({ lean: async () => [] }) }
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      ServiceError,
      Crypto: { encrypt: (v) => v, decrypt: (v) => v },
      Service: {
        getInstance: () => ({
          envConfig: { getValues: () => ({}) },
          createServiceToken: async () => 't'
        })
      },
      Middlewares: {},
      OwnerStatement: { LOIPOI_LABEL: 'ΛΟΙΠΟΙ' },
      BuildingProjection: {},
      ShareBasis: {},
      // telegramInboxScanner now warns when a bill's month falls outside its
      // expense's active range, so this factory must provide that export too.
      // unstable_mockModule replaces the WHOLE module: an export the graph
      // consumes but the factory omits is `undefined` at call time, not a
      // resolution error, so the failure surfaces as a TypeError deep inside.
      BillTerm: { billTermFitsExpense: () => ({ fits: true }) }
    };
  });
  const scanner = await import('../jobs/telegramInboxScanner.js');
  findMatch = scanner._defaultDeps().findMatch;
  const bm = await import('../managers/billmanager.js');
  findExpenseByBillingId = bm.findExpenseByBillingId;
  findSharedMeter = bm.findSharedMeter;
  findExpenseMatch = bm.findExpenseMatch;
});

describe('Telegram ↔ upload match parity', () => {
  it('the bot matches a παροχή whose SUFFIX differs from the stored value', async () => {
    // The reported 2026-08-09 shape: bill prints «9 99935585-016», the expense
    // stores «999935585». Before the shared matcher this returned null on the bot
    // path while the upload path matched.
    const hit = await findMatch('r1', '999935585016');
    expect(hit).toMatchObject({
      buildingId: 'bldg-1',
      expenseId: 'exp-1',
      expenseName: 'Ρεύμα κοινοχρήστων'
    });
  });

  it('agrees with the upload path on the SAME input (one implementation)', async () => {
    const viaBot = await findMatch('r1', '999935585016');
    const viaUpload = await findExpenseByBillingId('r1', '999935585016');
    expect(viaUpload).toBeTruthy();
    // Same building + expense, whichever door the bill came through.
    expect(viaBot.buildingId).toBe(String(viaUpload.building._id));
    expect(viaBot.expenseId).toBe(String(viaUpload.expense._id));
  });

  it('recognises a κοινόχρηστος shared meter (the copy could not)', async () => {
    const hit = await findMatch('r1', '999000777');
    expect(hit).toMatchObject({ buildingId: 'bldg-2', buildingName: 'ΟΔΟΣ ΒΗΤΑ 9' });
    // No δαπάνη exists yet, so expenseId MUST stay empty — the bell renders the
    // create-expense card on that, and a green «Αντιστοιχεί» with a blank expense
    // name would be a lie.
    expect(hit.expenseId).toBe('');
    // …and the upload path sees the same meter.
    await expect(findSharedMeter('r1', '999000777')).resolves.toMatchObject({
      buildingId: 'bldg-2',
      provider: 'deh'
    });
  });

  it('identifies an APARTMENT by its own παροχή — suffix-tolerantly', async () => {
    // THE REPORTED BILL'S SHAPE. The bot had no unit tier at all, so this bill
    // arrived unmatched by Telegram while matching on upload.
    const hit = await findMatch('r1', '999123456016');
    expect(hit).toMatchObject({
      buildingId: 'bldg-3',
      buildingName: 'ΟΔΟΣ ΓΑΜΑ 12',
      unitPropertyId: 'prop-1',
      unitLabel: 'Α2'
    });
    // No δαπάνη yet → the create-expense card, not a green «Αντιστοιχεί».
    expect(hit.expenseId).toBe('');
    // And it must NOT be mistaken for a shared meter (that would split the flat's
    // own bill across the whole building).
    expect(hit.sharedProvider).toBeUndefined();
  });

  it('matches an apartment by its TELECOM number, not just the ΔΕΗ one', async () => {
    const hit = await findMatch('r1', '999555111');
    expect(hit).toMatchObject({
      buildingId: 'bldg-4',
      unitPropertyId: 'prop-tel',
      unitLabel: 'Δ1'
    });
  });

  it('matches an apartment by its ΕΥΔΑΠ number too', async () => {
    const hit = await findMatch('r1', '999666222');
    expect(hit).toMatchObject({
      buildingId: 'bldg-4',
      unitPropertyId: 'prop-wat',
      unitLabel: 'Δ2'
    });
  });

  it('a telecom number still matches suffix-tolerantly', async () => {
    // Same body-vs-suffix rule as ΔΕΗ: the printed number may carry a check suffix.
    await expect(findMatch('r1', '999555111004')).resolves.toMatchObject({
      unitPropertyId: 'prop-tel'
    });
  });

  it('prefers a configured expense over a shared meter', async () => {
    // bldg-1's expense wins for its own παροχή; nothing shared shadows it.
    const hit = await findMatch('r1', '999935585');
    expect(hit.expenseId).toBe('exp-1');
  });

  it('returns null for an unknown παροχή', async () => {
    await expect(findMatch('r1', '999111222')).resolves.toBeNull();
  });

  it('does not match on a PREFIX (only a suffix may differ)', async () => {
    // 8 digits is not a valid body — a truncated read must not match.
    await expect(findMatch('r1', '99993558')).resolves.toBeNull();
  });
});

describe('ambiguity must not fall through to weaker evidence', () => {
  beforeEach(() => {
    BUILDINGS = AMBIGUOUS_BUILDINGS;
  });

  it('proposes NO TARGET when two expenses claim the παροχή, and says why', async () => {
    // Before the fix, `findExpenseByBillingId` collapsed ambiguous into null, the
    // caller read that as "nothing matched", and the shared meter on ΓΑΜΑ 3 was
    // proposed instead — pre-attributing the bill to the WEAKEST candidate while
    // the two real ones were discarded.
    const hit = await findMatch('r1', '999935585');
    expect(hit).toEqual({ ambiguous: 'expense' });
    // No target of ANY kind: a buildingId here would pre-select a building the
    // evidence does not support.
    expect(hit.buildingId).toBeUndefined();
    expect(hit.expenseId).toBeUndefined();
    // The reason must reach the card, or it renders «δεν βρέθηκε δαπάνη» — the
    // opposite of the truth, whose obvious remedy (create another δαπάνη for the
    // same παροχή) makes the ambiguity permanent.
    expect(hit.ambiguous).toBe('expense');
  });

  it('reports the ambiguity distinctly from a genuine no-match', async () => {
    await expect(findExpenseMatch('r1', '999935585')).resolves.toEqual({
      status: 'ambiguous',
      hit: null
    });
    await expect(findExpenseMatch('r1', '999444333')).resolves.toEqual({
      status: 'none',
      hit: null
    });
    // The legacy wrapper still answers null for both — callers that don't care
    // about the distinction are unaffected.
    await expect(
      findExpenseByBillingId('r1', '999935585')
    ).resolves.toBeNull();
  });

  it('an AMBIGUOUS shared meter must not fall through to the apartment tier', async () => {
    // The worst shape in this file. Two buildings list the same κοινόχρηστος
    // meter AND an apartment carries the same παροχή. Collapsing ambiguous→null
    // let the unit tier win, which proposes `single_unit`: the building's ENTIRE
    // shared supply billed to one flat, every other unit paying zero — on a €500
    // bill over 400/300/200/100‰ that is €500 to one owner instead of
    // €200/150/100/50. The write-time collision guard cannot catch it, because it
    // is per-building and runs only when `sharedMeters` is submitted.
    BUILDINGS = [
      {
        _id: 'amb-1',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        expenses: [],
        units: [],
        sharedMeters: [{ provider: 'deh', supplyNumber: '999777888' }]
      },
      {
        _id: 'amb-2',
        name: 'ΟΔΟΣ ΒΗΤΑ 2',
        expenses: [],
        // The same supply recorded on an APARTMENT — the fallthrough's target.
        units: [
          {
            _id: 'u9',
            propertyId: 'prop-9',
            name: 'Β1',
            electricitySupplyNumber: '999777888'
          }
        ],
        sharedMeters: [{ provider: 'deh', supplyNumber: '999777888' }]
      }
    ];
    const hit = await findMatch('r1', '999777888');
    // No target suggested: the operator chooses. NOT a single_unit proposal.
    expect(hit).toEqual({ ambiguous: 'sharedMeter' });
    expect(hit.unitPropertyId).toBeUndefined();
    // And the matcher reports WHY, so a caller can render it honestly.
    const bm = await import('../managers/billmanager.js');
    await expect(
      bm.findSharedMeterMatch('r1', '999777888')
    ).resolves.toEqual({ status: 'ambiguous', hit: null });
  });

  it('still finds the shared meter when the παροχή is NOT ambiguous', async () => {
    // Proof the guard is narrow: ΓΑΜΑ's meter is reachable on its own number.
    BUILDINGS = [AMBIGUOUS_BUILDINGS[2]];
    await expect(findMatch('r1', '999935585')).resolves.toMatchObject({
      buildingId: 'amb-Z',
      expenseId: '',
      sharedProvider: 'deh'
    });
  });
});

describe('a bill matches on ANY identifier it printed, not only the primary', () => {
  // ΕΥΔΑΠ prints three numbers: the ΑΡΙΘΜΟΣ ΜΕΤΡΗΤΗ (the physical meter — the right
  // key and the parser's primary), the ΑΡΙΘΜΟΣ ΛΟΓΑΡΙΑΣΜΟΥ and the ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ.
  // Rows entered before the meter was settled on hold one of the latter two. Matching
  // only the primary told that landlord their own bill was unrecognised — a failure
  // with no visible cause, because every number on the screen looks correct.
  const METER = 'A99E90001';
  const ACCOUNT = '99900011122003';
  const REGISTRY = '999000133';

  it('resolves on an ALTERNATE when the primary matches nothing', async () => {
    BUILDINGS = [
      {
        _id: 'alt-1',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        // The landlord recorded the ACCOUNT number, not the meter.
        expenses: [{ _id: 'e-alt', name: 'Νερό κοινοχρήστων', billingId: ACCOUNT }],
        units: [],
        sharedMeters: []
      }
    ];
    const bm = await import('../managers/billmanager.js');
    const r = await bm.resolveBillTarget('r1', [METER, ACCOUNT, REGISTRY]);
    expect(r.expenseStatus).toBe('match');
    expect(String(r.expenseHit.expense._id)).toBe('e-alt');
    // And it reports WHICH key resolved, so the card can say so.
    expect(r.matchedKey).toBe(ACCOUNT);
  });

  it('the PRIMARY wins over an alternate, across tiers', async () => {
    // The meter matches a configured δαπάνη; the account number matches a bare
    // shared meter. Tiers-within-key means the δαπάνη wins — resolving the alternate
    // first would attribute the bill to the weaker evidence.
    BUILDINGS = [
      {
        _id: 'p-1',
        name: 'ΟΔΟΣ ΒΗΤΑ 2',
        expenses: [{ _id: 'e-primary', name: 'Νερό', billingId: METER }],
        units: [],
        sharedMeters: []
      },
      {
        _id: 'p-2',
        name: 'ΟΔΟΣ ΓΑΜΑ 3',
        expenses: [],
        units: [],
        sharedMeters: [{ provider: 'eydap', supplyNumber: ACCOUNT }]
      }
    ];
    const bm = await import('../managers/billmanager.js');
    const r = await bm.resolveBillTarget('r1', [METER, ACCOUNT]);
    expect(String(r.expenseHit.expense._id)).toBe('e-primary');
    expect(r.matchedKey).toBe(METER);
    // The shared meter is never even consulted for the primary key.
    expect(r.sharedHit).toBeNull();
  });

  it('AMBIGUITY on one key stops the walk — no alternate is tried', async () => {
    // Two δαπάνες claim the meter, and the account number would resolve cleanly to a
    // third building. Continuing would answer a question only the operator can
    // answer, using evidence just refused for being unclear.
    BUILDINGS = [
      {
        _id: 'a-1',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        expenses: [{ _id: 'x1', name: 'Νερό', billingId: METER }],
        units: [],
        sharedMeters: []
      },
      {
        _id: 'a-2',
        name: 'ΟΔΟΣ ΒΗΤΑ 2',
        expenses: [{ _id: 'x2', name: 'Νερό', billingId: METER }],
        units: [],
        sharedMeters: []
      },
      {
        _id: 'a-3',
        name: 'ΟΔΟΣ ΓΑΜΑ 3',
        expenses: [{ _id: 'x3', name: 'Νερό', billingId: ACCOUNT }],
        units: [],
        sharedMeters: []
      }
    ];
    const bm = await import('../managers/billmanager.js');
    const r = await bm.resolveBillTarget('r1', [METER, ACCOUNT]);
    expect(r.expenseStatus).toBe('ambiguous');
    expect(r.expenseHit).toBeNull();
    // x3 must NOT have been proposed.
    expect(r.sharedHit).toBeNull();
    expect(r.unitHit).toBeNull();
  });

  it('an alternate reaches the APARTMENT tier too', async () => {
    BUILDINGS = [
      {
        _id: 'u-b',
        name: 'ΟΔΟΣ ΔΕΛΤΑ 7',
        expenses: [],
        units: [{ _id: 'u1', propertyId: 'prop-1', name: 'Α2', eydapNumber: REGISTRY }],
        sharedMeters: []
      }
    ];
    const bm = await import('../managers/billmanager.js');
    const r = await bm.resolveBillTarget('r1', [METER, ACCOUNT, REGISTRY]);
    expect(r.unitHit).toMatchObject({ propertyId: 'prop-1', unitLabel: 'Α2' });
    expect(r.matchedKey).toBe(REGISTRY);
  });

  it('skips blanks and duplicates instead of re-querying', async () => {
    // The primary is often one of the alternates too; querying it twice doubles the
    // DB work for the same answer.
    BUILDINGS = [];
    const bm = await import('../managers/billmanager.js');
    const r = await bm.resolveBillTarget('r1', [METER, METER, '', null, undefined]);
    expect(r.expenseStatus).toBe('none');
    expect(r.matchedKey).toBeUndefined();
  });

  it('the BOT lane passes the alternates through', async () => {
    // The deps signature accepts them and the caller supplies them — otherwise the
    // resolver would only ever see the primary on the Telegram path.
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.resolve(here, '../jobs/telegramInboxScanner.ts'),
      'utf8'
    );
    expect(src).toContain('bill.alternateBillingIds || []');
    expect(src).toContain('resolveBillTarget');
  });
});
