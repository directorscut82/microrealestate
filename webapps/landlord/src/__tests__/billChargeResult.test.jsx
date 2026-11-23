import 'moment/locale/el';
import ChargeOutcomeList from '../components/buildings/ChargeOutcomeList';
import ConfirmedBillCard from '../components/ConfirmedBillCard';
import el from '../../locales/el/common.json';
import ImportedBillCard from '../components/buildings/ImportedBillCard';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// After a bill is saved, the upload window and the Telegram bell say where each
// tenant's share went (DEFERRED_DECISIONS D-10; the owner-approved screens of
// 2026-11-22). The server reads the tenants' rents back and answers share by share
// (`chargeOutcome`); its own tests pin that answer. This file pins what the two
// surfaces SAY with it — the approved wording, in Greek, through the real el strings.

jest.mock('next-translate/useTranslation', () => ({
  __esModule: true,
  default: () => {
    // eslint-disable-next-line global-require
    const strings = require('../../locales/el/common.json');
    return {
      lang: 'el',
      // (as next-translate does: «key_one» for a count of one, when the file has it)
      t: (key, values = {}) =>
        (
          (values.count === 1 && strings[`${key}_one`]) ||
          strings[key] ||
          key
        ).replace(/\{\{(\w+)\}\}/g, (m, name) => values[name] ?? m)
    };
  }
}));
jest.mock('../components/NumberFormat', () => ({
  __esModule: true,
  // (as the real one — NumberFormat.js — «—» where there is no value)
  default: ({ value }) =>
    value === undefined || value === null || Number.isNaN(value)
      ? '—'
      : `${Number(value).toFixed(2).replace('.', ',')} €`
}));

const OCT = 2026100100;
const NOV = 2026110100;
const DEC = 2026120100;

// The example of the approved screens: one building, three apartments in equal
// shares, a 90,00 € ΔΕΗ bill of October imported in November. A has not paid November,
// B has, C's lease ended on 31 October.
const building = {
  _id: 'b1',
  name: 'ΚΤΙΡΙΟ ΑΛΦΑ',
  units: ['A', 'B', 'C'].map((u) => ({ propertyId: `p${u}`, name: u }))
};
const share = (unit, extra) => ({
  propertyId: `p${unit}`,
  tenantId: `t${unit}`,
  tenantName: `TENANT-${unit}`,
  expenseId: 'e1',
  term: OCT,
  amount: 30,
  ...extra
});
const A = share('A', {
  status: 'moved',
  billedTerm: NOV,
  billedAmount: 30,
  reason: 'monthClosed'
});
const B = share('B', {
  status: 'moved',
  billedTerm: DEC,
  billedAmount: 30,
  reason: 'monthPaid'
});
const C = share('C', {
  status: 'notCharged',
  billedTerm: null,
  billedAmount: null,
  reason: 'leaseEnded'
});

// The text of each element, one line per element that holds text of its own.
const lines = (html) =>
  html
    .replace(/<svg.*?<\/svg>/g, '')
    .replace(/<!-- -->/g, '')
    .replace(/<\/(li|div|p|span|button|ul)>/g, '\n')
    .replace(/<(li|div|p|span|button|ul)[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
// The rows of a list: who, how much, the status line with its colour, the line under it.
const rows = (html) =>
  [...html.matchAll(/<li[^>]*data-cy="chargeOutcomeRow"[^>]*>(.*?)<\/li>/g)].map(
    (m) => {
      const status = /<span class="block (text-olive|text-oxide)">(.*?)<\/span>/.exec(
        m[1]
      );
      return [
        ...lines(m[1].replace(status[0], '\n')),
        `${status[1].replace('text-', '')}: ${lines(status[2]).join(' ')}`
      ];
    }
  );

describe('the list of shares in the upload window', () => {
  const html = renderToStaticMarkup(
    <ChargeOutcomeList outcomes={[A, B, C]} building={building} />
  );

  it('the approved example, word for word', () => {
    expect(rows(html)).toEqual([
      ['A · TENANT-A', '30,00 €', 'olive: ✓ στο ενοίκιο Νοεμβρίου 2026'],
      [
        'B · TENANT-B',
        '30,00 €',
        'έχει εξοφλήσει τον Νοέμβριο',
        'olive: ✓ στο ενοίκιο Δεκεμβρίου 2026'
      ],
      [
        'C · TENANT-C',
        '30,00 €',
        'η μίσθωση έχει λήξει',
        'oxide: ⚠ δεν χρεώθηκε'
      ]
    ]);
  });

  it('a status colour is never alone: every status line starts with its glyph and has its words', () => {
    const statuses = [
      ...html.matchAll(/<span class="block (text-olive|text-oxide)">(.*?)<\/span>/g)
    ].map((m) => [m[1], lines(m[2]).join(' ')]);
    expect(statuses).toHaveLength(3);
    statuses.forEach(([colour, text]) => {
      expect(text).toMatch(colour === 'text-olive' ? /^✓ \S/ : /^⚠ \S/);
    });
  });

  it.each([
    [
      'a share on the bill’s own month',
      { status: 'billed', billedTerm: OCT, billedAmount: 30 },
      ['olive: ✓ στο ενοίκιο Οκτωβρίου 2026']
    ],
    [
      'a share that should be on a rent and is not',
      { status: 'missing', billedTerm: null, billedAmount: null, reason: 'recomputeFailed' },
      ['oxide: ⚠ δεν χρεώθηκε']
    ],
    [
      'a share an old line may be for',
      { status: 'notCharged', billedTerm: null, billedAmount: null, reason: 'unclear' },
      ['oxide: ⚠ δεν χρεώθηκε']
    ],
    [
      'a rent that holds another amount than the share',
      { status: 'moved', billedTerm: NOV, billedAmount: 25, reason: 'monthClosed' },
      ['olive: ✓ στο ενοίκιο Νοεμβρίου 2026 (25,00 €)']
    ],
    [
      'a share «moved» to a month that is none: no month can be named',
      { status: 'moved', billedTerm: 2026130100, billedAmount: 30, reason: 'monthPaid' },
      ['oxide: ⚠ δεν χρεώθηκε']
    ],
    [
      'a rent amount that is no figure: nothing in brackets',
      { status: 'moved', billedTerm: NOV, billedAmount: '', reason: 'monthClosed' },
      ['olive: ✓ στο ενοίκιο Νοεμβρίου 2026']
    ],
    [
      'a share «moved» to text that only begins like a month: no month is named, and no paid month either',
      { status: 'moved', billedTerm: '202611abc', billedAmount: 30, reason: 'monthPaid' },
      ['oxide: ⚠ δεν χρεώθηκε']
    ]
  ])('%s', (_what, extra, said) => {
    expect(
      rows(
        renderToStaticMarkup(
          <ChargeOutcomeList outcomes={[share('A', extra)]} building={building} />
        )
      )
    ).toEqual([['A · TENANT-A', '30,00 €', ...said]]);
  });

  it('a unit with no name of its own: the tenant alone', () => {
    expect(
      rows(
        renderToStaticMarkup(
          <ChargeOutcomeList outcomes={[A]} building={{ units: [] }} />
        )
      )[0][0]
    ).toBe('TENANT-A');
  });

  it('neither a unit name nor a tenant name: «—» in its place, never an empty cell', () => {
    expect(
      rows(
        renderToStaticMarkup(
          <ChargeOutcomeList
            outcomes={[{ ...A, tenantName: '' }]}
            building={{ units: [] }}
          />
        )
      )[0][0]
    ).toBe('—');
  });

  it.each([
    ['text that is no number', 'abc'],
    ['nothing', null],
    ['an empty text', '']
  ])(
    'a share whose amount is %s: «—» — never «NaN €», never «0,00 €» — and what the rent holds is still said',
    (_what, amount) => {
      expect(
        rows(
          renderToStaticMarkup(
            <ChargeOutcomeList
              outcomes={[{ ...A, amount }]}
              building={building}
            />
          )
        )
      ).toEqual([
        ['A · TENANT-A', '—', 'olive: ✓ στο ενοίκιο Νοεμβρίου 2026 (30,00 €)']
      ]);
    }
  );

  it.each([[[]], [null], [undefined], ['x']])(
    'no shares (%p): nothing is rendered',
    (outcomes) => {
      expect(
        renderToStaticMarkup(
          <ChargeOutcomeList outcomes={outcomes} building={building} />
        )
      ).toBe('');
    }
  );
});

describe('the list of shares in the bell', () => {
  it('the approved example: the month alone, and no line under it', () => {
    expect(
      rows(
        renderToStaticMarkup(
          <ChargeOutcomeList outcomes={[A, B, C]} building={building} compact />
        )
      )
    ).toEqual([
      ['A · TENANT-A', '30,00 €', 'olive: ✓ Νοέμβριος 2026'],
      ['B · TENANT-B', '30,00 €', 'olive: ✓ Δεκέμβριος 2026'],
      ['C · TENANT-C', '30,00 €', 'oxide: ⚠ δεν χρεώθηκε']
    ]);
  });

  it('a share «moved» to a month that is none: «not charged» — never «✓» alone', () => {
    expect(
      rows(
        renderToStaticMarkup(
          <ChargeOutcomeList
            outcomes={[{ ...B, billedTerm: 0 }]}
            building={building}
            compact
          />
        )
      )
    ).toEqual([['B · TENANT-B', '30,00 €', 'oxide: ⚠ δεν χρεώθηκε']]);
  });
});

describe('a saved bill, on the result the upload window stays open on', () => {
  const bill = (extra = {}) => ({
    uid: '0:w3-last-month.pdf',
    filename: 'w3-last-month.pdf',
    provider: 'deh',
    term: OCT,
    amount: 90,
    buildingId: 'b1',
    expenseName: 'ΡΕΥΜΑ ΚΟΙΝΟΧΡΗΣΤΩΝ',
    chargeRequested: true,
    chargeError: null,
    chargeOutcome: [A, B, C],
    ...extra
  });
  const card = (b) =>
    lines(renderToStaticMarkup(<ImportedBillCard bill={b} building={building} />));

  it('the approved example: the file, the month and the amount, where it was recorded, and where each share went', () => {
    expect(card(bill())).toEqual([
      'w3-last-month.pdf',
      'ΔΕΗ · Οκτώβριο 2026 · 90,00 €',
      'Έξοδο',
      'ΡΕΥΜΑ ΚΟΙΝΟΧΡΗΣΤΩΝ · ΚΤΙΡΙΟ ΑΛΦΑ',
      'Χρέωση ενοικιαστών',
      'Ο Οκτώβριος 2026 έχει κλείσει για τους ενοικιαστές. Το μερίδιο του καθενός μπήκε στο επόμενο ανοιχτό ενοίκιό του.',
      'A · TENANT-A',
      '30,00 €',
      '✓ στο ενοίκιο Νοεμβρίου 2026',
      'B · TENANT-B',
      '30,00 €',
      '✓ στο ενοίκιο Δεκεμβρίου 2026',
      'έχει εξοφλήσει τον Νοέμβριο',
      'C · TENANT-C',
      '30,00 €',
      '⚠ δεν χρεώθηκε',
      'η μίσθωση έχει λήξει'
    ]);
  });

  it('one share on the bill’s own month: the list alone — the month is not closed «for the tenants»', () => {
    const own = share('A', { status: 'billed', billedTerm: OCT, billedAmount: 30 });
    const said = card(bill({ chargeOutcome: [own, B] }));
    expect(said.join('\n')).not.toContain('έχει κλείσει');
    expect(said).toContain('✓ στο ενοίκιο Οκτωβρίου 2026');
    expect(said).toContain('Χρέωση ενοικιαστών');
  });

  it.each([
    [
      'a share that should be on a rent and is not',
      { status: 'missing', billedTerm: null, billedAmount: null, reason: 'recomputeFailed' }
    ],
    [
      'a share an old line may be for',
      { status: 'notCharged', billedTerm: null, billedAmount: null, reason: 'unclear' }
    ],
    [
      'a share from before the change',
      { status: 'notCharged', billedTerm: null, billedAmount: null, reason: 'notCarried' }
    ]
  ])(
    '%s, next to one that went on a later rent: the list alone — «each share went on the next open rent» would not be true of it',
    (_what, extra) => {
      const said = card(bill({ chargeOutcome: [B, share('A', extra)] }));
      expect(said.join('\n')).not.toContain('έχει κλείσει');
      expect(said).toContain('✓ στο ενοίκιο Δεκεμβρίου 2026');
      expect(said).toContain('⚠ δεν χρεώθηκε');
    }
  );

  it('a share «moved» to text that only begins like a month, alone: nothing is said about a closed or a paid month', () => {
    const said = card(
      bill({
        chargeOutcome: [
          share('A', {
            status: 'moved',
            billedTerm: '202611abc',
            billedAmount: 30,
            reason: 'monthPaid'
          })
        ]
      })
    );
    expect(said.join('\n')).not.toContain('έχει κλείσει');
    expect(said.join('\n')).not.toContain('έχει εξοφλήσει');
    expect(said).toContain('⚠ δεν χρεώθηκε');
  });

  it.each([
    ['text that is no number', 'abc'],
    ['an empty text', ''],
    ['nothing', null]
  ])(
    'a bill whose amount is %s: «—», never «NaN €» or «0,00 €»',
    (_what, amount) => {
      expect(card(bill({ amount }))[1]).toBe('ΔΕΗ · Οκτώβριο 2026 · —');
    }
  );

  it.each([
    ['no provider', ''],
    ['a provider that is not given', undefined]
  ])(
    'a bill with %s: the month and the amount, with no separator in front',
    (_what, provider) => {
      expect(card(bill({ provider }))[1]).toBe('Οκτώβριο 2026 · 90,00 €');
    }
  );

  it('a bill whose month is none: the month is not named, and nothing is said about it', () => {
    const said = card(bill({ term: 'abc' }));
    expect(said[1]).toBe('ΔΕΗ · 90,00 €');
    expect(said.join('\n')).not.toContain('έχει κλείσει');
    expect(said).toContain('Χρέωση ενοικιαστών');
  });

  it('the bill is saved and the charge failed: «not charged», under the bill it concerns, and no list', () => {
    const said = card(bill({ chargeError: 'boom', chargeOutcome: [] }));
    expect(said.slice(4)).toEqual(['Χρέωση ενοικιαστών', '⚠ δεν χρεώθηκε']);
    // …the server's message is not shown as it is
    expect(said.join('\n')).not.toContain('boom');
  });

  it.each([
    ['a bill that was not charged to tenants', { chargeRequested: false, chargeOutcome: [] }],
    ['a bill charged to tenants when no tenant has a share', { chargeOutcome: [] }]
  ])('%s: the bill and where it was recorded, nothing about tenants', (_what, extra) => {
    expect(card(bill(extra))).toEqual([
      'w3-last-month.pdf',
      'ΔΕΗ · Οκτώβριο 2026 · 90,00 €',
      'Έξοδο',
      'ΡΕΥΜΑ ΚΟΙΝΟΧΡΗΣΤΩΝ · ΚΤΙΡΙΟ ΑΛΦΑ'
    ]);
  });

  it('a provider the app has no name for, and a bill with no month: nothing is invented', () => {
    expect(
      card(bill({ provider: 'acme', term: null, chargeRequested: false })).slice(0, 2)
    ).toEqual(['w3-last-month.pdf', 'acme · 90,00 €']);
  });
});

describe('a bill card of the bell, after «Καταχώρηση»', () => {
  const entry = (extra = {}) => ({
    id: 'i1',
    provider: 'deh',
    building,
    chargeError: null,
    chargeOutcome: [A, B, C],
    ...extra
  });
  const card = (e) =>
    lines(renderToStaticMarkup(<ConfirmedBillCard entry={e} onOk={() => {}} />));

  it('the approved example: what was recorded, where each share went, and «Εντάξει»', () => {
    expect(card(entry())).toEqual([
      'ΔΕΗ',
      'Telegram',
      '✓ Καταχωρήθηκε',
      'A · TENANT-A',
      '30,00 €',
      '✓ Νοέμβριος 2026',
      'B · TENANT-B',
      '30,00 €',
      '✓ Δεκέμβριος 2026',
      'C · TENANT-C',
      '30,00 €',
      '⚠ δεν χρεώθηκε',
      'Εντάξει'
    ]);
  });

  it('recorded without charging the tenants: what was recorded, and «Εντάξει»', () => {
    expect(card(entry({ chargeOutcome: [] }))).toEqual([
      'ΔΕΗ',
      'Telegram',
      '✓ Καταχωρήθηκε',
      'Εντάξει'
    ]);
  });

  it('the charge failed: the card says so (it used to be dropped with the message)', () => {
    expect(card(entry({ chargeError: 'boom', chargeOutcome: [] }))).toEqual([
      'ΔΕΗ',
      'Telegram',
      '✓ Καταχωρήθηκε',
      'Οι λογαριασμοί αποθηκεύτηκαν. 1 δεν χρέωσαν ενοικιαστές — χρεώστε τους από τη μηνιαία κατάσταση.',
      'Εντάξει'
    ]);
  });
});

describe('the words, as approved', () => {
  it.each([
    ['{{count}} recorded', '{{count}} καταχωρήθηκαν'],
    ['{{count}} recorded_one', '1 καταχωρήθηκε'],
    ['Recorded', 'Καταχωρήθηκε'],
    [
      "{{month}} is closed for the tenants. Each tenant's share went on their next open rent.",
      'Ο {{month}} έχει κλείσει για τους ενοικιαστές. Το μερίδιο του καθενός μπήκε στο επόμενο ανοιχτό ενοίκιό του.'
    ],
    ['on the rent of {{month}}', 'στο ενοίκιο {{month}}'],
    ['has paid {{month}} in full', 'έχει εξοφλήσει τον {{month}}'],
    ['the lease has ended', 'η μίσθωση έχει λήξει'],
    // …and the ones that were there already
    ['not charged', 'δεν χρεώθηκε'],
    ['Charged to tenants', 'Χρέωση ενοικιαστών'],
    ['Charge tenants for {{month}}', 'Χρέωση ενοικιαστών για {{month}}'],
    ['Close', 'Κλείσιμο'],
    ['Ok', 'Εντάξει']
  ])('%s', (key, greek) => {
    expect(el[key]).toBe(greek);
  });

  it.each(['en', 'fr-FR', 'de-DE', 'es-CO', 'pt-BR'])(
    'every new key is in %s too (a key missing from a language shows in English there)',
    (lang) => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const strings = require(`../../locales/${lang}/common.json`);
      [
        '{{count}} recorded',
        '{{count}} recorded_one',
        'Recorded',
        "{{month}} is closed for the tenants. Each tenant's share went on their next open rent.",
        'on the rent of {{month}}',
        'has paid {{month}} in full',
        'the lease has ended'
      ].forEach((key) => {
        expect([key, typeof strings[key]]).toEqual([key, 'string']);
        expect(strings[key].length).toBeGreaterThan(0);
      });
    }
  );
});
