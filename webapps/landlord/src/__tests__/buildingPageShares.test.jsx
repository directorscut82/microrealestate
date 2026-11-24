import 'moment/locale/el';
import { ChargeBreakdown } from '../components/buildings/BuildingExpensePanel';
import el from '../../locales/el/common.json';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The building page, «Έξοδα» → «Χρεώσεις», for a month whose tenant shares are not
// all simply on that month's rent (DEFERRED_DECISIONS D-10). The server reads the
// tenants' rents back and says, share by share, where each one is
// (services/api/src/managers/chargecarry.ts placeTenantShares; its own tests pin
// that answer). This file pins what the page SAYS with it — the owner-approved
// wording, in Greek, through the real el strings.

jest.mock('../hooks/useFormatNumber', () => ({
  __esModule: true,
  default: () => (value) => `${Number(value).toFixed(2).replace('.', ',')} €`
}));
jest.mock('../components/NumberFormat', () => ({
  __esModule: true,
  default: ({ value }) => `${Number(value).toFixed(2).replace('.', ',')} €`
}));

// next-translate's `t` over the REAL Greek file: a key that is missing from it comes
// out in English, exactly as it would on the screen.
const t = (key, values = {}) =>
  (el[key] ?? key).replace(/\{\{(\w+)\}\}/g, (m, name) => values[name] ?? m);

const OCT = 2026100100;
const NOV = 2026110100;
const DEC = 2026120100;

const basis = {
  kind: 'thousandths',
  part: 333,
  whole: 999,
  total: 90,
  share: 30
};
const share = (unit, tenant, extra = {}) => ({
  expenseId: 'power',
  expenseName: 'HARNESS ΡΕΥΜΑ',
  expenseType: 'electricity_common',
  allocationMethod: 'general_thousandths',
  propertyId: `p${unit}`,
  propertyName: `HARNESS - ${unit}`,
  recipient: 'renter',
  recipientName: tenant,
  amount: 30,
  basis,
  ...extra
});
const building = {
  name: 'HARNESS',
  units: ['A', 'B', 'C'].map((u) => ({
    propertyId: `p${u}`,
    atakNumber: '0123456789012'
  })),
  uncollectedPayments: []
};

// What the page shows, as lines of text, with the status colour of each billing line.
function page(rows, term = OCT) {
  const html = renderToStaticMarkup(
    <ChargeBreakdown
      breakdown={{ rows, ownerDirect: [] }}
      building={building}
      term={String(term)}
      t={t}
      lang="el"
    />
  );
  const text = html
    .replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, '')
    // a `block` span starts a line of its own on the screen
    .replace(/<span class="block[^>]*>/g, '\n')
    .replace(/<\/(td|tr|span|div)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    // the «· για <μήνα>» suffix is held together by no-break spaces
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const billing = [
    ...html.matchAll(
      /<span class="([^"]*)" data-cy="shareBilling">(.*?)<\/span>/g
    )
  ].map((m) => [
    m[1].includes('text-olive')
      ? 'olive'
      : m[1].includes('text-oxide')
        ? 'oxide'
        : m[1],
    m[2].replace(/<!-- -->/g, '')
  ]);
  return { html, text, billing };
}

describe('the month a bill is for (October), read back from the rents', () => {
  const october = [
    share('A', 'TENANT-A', {
      billing: [
        {
          tenantName: 'TENANT-A',
          status: 'moved',
          billedTerm: NOV,
          billedAmount: 30
        }
      ]
    }),
    share('B', 'TENANT-B', {
      billing: [
        {
          tenantName: 'TENANT-B',
          status: 'moved',
          billedTerm: DEC,
          billedAmount: 30
        }
      ]
    }),
    share('C', 'TENANT-C', {
      billing: [
        {
          tenantName: 'TENANT-C',
          status: 'notCharged',
          billedTerm: null,
          billedAmount: null,
          reason: 'leaseEnded'
        }
      ]
    })
  ];

  it('each share says where it was charged, in the approved words and colours', () => {
    expect(page(october).billing).toEqual([
      ['olive', '✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026'],
      ['olive', '✓ χρεώθηκε στο ενοίκιο Δεκεμβρίου 2026'],
      ['oxide', '⚠ δεν χρεώθηκε, η μίσθωση έχει λήξει']
    ]);
  });

  it('under the calculation of the share, which stays as it was', () => {
    const { text } = page(october);
    const at = text.indexOf('✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026');
    expect(text[at - 1]).toBe(
      'χιλιοστά μονάδας 333 ÷ 999 συνολικά × κόστος 90,00 € = 30,00 €'
    );
    expect(text[at - 2]).toBe('Κοινόχρηστο Ρεύμα (HARNESS ΡΕΥΜΑ)');
    expect(text[at + 1]).toBe('30,00 €');
  });

  it.each([
    [
      'written before shares were carried',
      { status: 'notCharged', reason: 'notCarried' }
    ],
    [
      'that an old rent line may or may not be for',
      { status: 'notCharged', reason: 'unclear' }
    ],
    ['not on a rent yet', { status: 'missing', reason: 'recomputeFailed' }],
    ['of a kind this page does not know', { status: 'somethingNew' }],
    ['said to be moved, to no month', { status: 'moved', billedTerm: null }],
    ['said to be billed, on no month', { status: 'billed', billedTerm: null }]
  ])('a share %s is «not charged», never «charged»', (_what, billing) => {
    expect(
      page([share('A', 'TENANT-A', { billing: [billing] })]).billing
    ).toEqual([['oxide', '⚠ δεν χρεώθηκε']]);
  });

  it('the rent holds another amount than the share shown: the amount that was charged follows in brackets', () => {
    // the figure was changed after that rent was closed
    const billedAs = (billedAmount) =>
      page([
        share('A', 'TENANT-A', {
          billing: [{ status: 'moved', billedTerm: NOV, billedAmount }]
        })
      ]).billing;
    expect(billedAs(40)).toEqual([
      ['olive', '✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026 (40,00 €)']
    ]);
    // the same amount, or none reported: nothing more
    expect(billedAs(30)).toEqual([
      ['olive', '✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026']
    ]);
    expect(billedAs(null)).toEqual([
      ['olive', '✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026']
    ]);
    expect(billedAs(undefined)).toEqual([
      ['olive', '✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026']
    ]);
  });

  it('a share on its own month’s rent that holds another amount than the one shown: said, with that amount', () => {
    // billed 30 on October's rent, which was then closed; the figure is 35 now. The
    // first version said nothing here and listed 35 as charged.
    expect(
      page([
        share('A', 'TENANT-A', {
          amount: 35,
          billing: [{ status: 'billed', billedTerm: OCT, billedAmount: 30 }]
        })
      ]).billing
    ).toEqual([['olive', '✓ χρεώθηκε στο ενοίκιο Οκτωβρίου 2026 (30,00 €)']]);
  });

  it('one tenant of the unit billed on the month, another on the next: both are said, by name', () => {
    // the first version left out the one who WAS billed, and the line that remained
    // read as the whole row's
    expect(
      page(
        [
          share('A', 'ARRIVING', {
            billing: [
              {
                tenantName: 'LEAVING',
                status: 'billed',
                billedTerm: NOV,
                billedAmount: 30
              },
              {
                tenantName: 'ARRIVING',
                status: 'moved',
                billedTerm: DEC,
                billedAmount: 30
              }
            ]
          })
        ],
        NOV
      ).billing
    ).toEqual([
      ['olive', '✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026 (LEAVING)'],
      ['olive', '✓ χρεώθηκε στο ενοίκιο Δεκεμβρίου 2026 (ARRIVING)']
    ]);
  });

  it('a share on its own month’s rent says nothing more than it always did', () => {
    const { billing, text } = page([share('A', 'TENANT-A')]);
    expect(billing).toEqual([]);
    expect(text.join('\n')).not.toContain('χρεώθηκε');
    // …and an empty list is not a status
    expect(page([share('A', 'TENANT-A', { billing: [] })]).billing).toEqual([]);
  });

  it('two tenants of the unit that month: one line each, with the name', () => {
    expect(
      page([
        share('A', 'TENANT-A', {
          billing: [
            { tenantName: 'TENANT-A', status: 'moved', billedTerm: NOV },
            {
              tenantName: 'TENANT-Z',
              status: 'notCharged',
              reason: 'leaseEnded'
            }
          ]
        })
      ]).billing
    ).toEqual([
      ['olive', '✓ χρεώθηκε στο ενοίκιο Νοεμβρίου 2026 (TENANT-A)'],
      ['oxide', '⚠ δεν χρεώθηκε, η μίσθωση έχει λήξει (TENANT-Z)']
    ]);
  });
});

describe('the month a share was billed on (November)', () => {
  const novemberOwn = share('A', 'TENANT-A', {
    expenseId: 'water',
    expenseName: 'HARNESS ΝΕΡΟ',
    expenseType: 'water_common',
    amount: 20,
    basis: { kind: 'none' }
  });
  const movedIn = share('A', 'TENANT-A', {
    tenantId: 'tA',
    groupKey: 'pA',
    forTerm: OCT
  });

  it('lists it with the unit’s own lines, marked with the month it is for', () => {
    const { text, billing } = page([novemberOwn, movedIn], NOV);
    expect(text).toContain('Κοινόχρηστο Νερό (HARNESS ΝΕΡΟ)');
    // the month it is for, on a line of its own right under the label
    const at = text.indexOf('Κοινόχρηστο Ρεύμα (HARNESS ΡΕΥΜΑ)');
    expect(text.slice(at, at + 2)).toEqual([
      'Κοινόχρηστο Ρεύμα (HARNESS ΡΕΥΜΑ)',
      'για Οκτώβριο 2026'
    ]);
    // …and only there: the month's own line has none
    expect(text.filter((l) => l.startsWith('για '))).toHaveLength(1);
    expect(billing).toEqual([]);
    // one group for the unit, and its total is what November's rent holds of it
    expect(text.filter((l) => l.startsWith('A — TENANT-A'))).toHaveLength(1);
    const header = text.findIndex((l) => l.startsWith('A — TENANT-A'));
    expect(text.slice(header, header + 3)).toEqual([
      'A — TENANT-A',
      '(ΑΤΑΚ 0123…9012)',
      '50,00 €'
    ]);
  });

  it('a tenant who has left the unit gets a group of their own, under their name', () => {
    const { text } = page(
      [
        share('A', 'TENANT-B', { amount: 20, basis: { kind: 'none' } }),
        { ...movedIn, groupKey: 'pA|tA' }
      ],
      NOV
    );
    const headers = text.filter((l) => /^A — TENANT-/.test(l));
    expect(headers).toEqual(['A — TENANT-B', 'A — TENANT-A']);
    const own = text.indexOf('A — TENANT-A');
    expect(text.slice(own, own + 6)).toEqual([
      'A — TENANT-A',
      '(ΑΤΑΚ 0123…9012)',
      '30,00 €',
      'Κοινόχρηστο Ρεύμα (HARNESS ΡΕΥΜΑ)',
      'για Οκτώβριο 2026',
      'χιλιοστά μονάδας 333 ÷ 999 συνολικά × κόστος 90,00 € = 30,00 €'
    ]);
  });
});

describe('no English on the Greek page', () => {
  it('every string of the new lines exists in el', () => {
    [
      'charged on the rent of {{month}}',
      'not charged, the lease has ended',
      'not charged',
      'for {{month}}',
      "What you enter now for this month goes on each tenant's next open rent and says which month it is for. The table shows where each share was charged. Owner charges are not affected."
    ].forEach((key) => {
      expect(typeof el[key]).toBe('string');
      expect(el[key]).not.toBe(key);
    });
  });

  it('and in every other language file', () => {
    ['en', 'fr-FR', 'de-DE', 'es-CO', 'pt-BR'].forEach((locale) => {
      // eslint-disable-next-line global-require
      const strings = require(`../../locales/${locale}/common.json`);
      [
        'charged on the rent of {{month}}',
        'not charged, the lease has ended',
        'not charged',
        'for {{month}}',
        "What you enter now for this month goes on each tenant's next open rent and says which month it is for. The table shows where each share was charged. Owner charges are not affected."
      ].forEach((key) => expect(typeof strings[key]).toBe('string'));
    });
  });
});
