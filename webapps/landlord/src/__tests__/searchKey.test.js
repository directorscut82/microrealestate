import fs from 'fs';
import path from 'path';
import { searchKey } from '../utils/searchKey';

// Names are stored in capitals without accents (as the tax office prints them);
// Greek is typed with accents. Every list compared after lower-casing and
// ς→σ but kept the accent, so «δοκιμόπουλος» was never found in
// «ΔΟΚΙΜΟΠΟΥΛΟΣ». searchKey() is the one spelling both sides are reduced to.

describe('searchKey', () => {
  it.each([
    [
      'a name, four ways',
      ['Δοκιμόπουλος', 'ΔΟΚΙΜΟΠΟΥΛΟΣ', 'δοκιμοπουλος', 'δοκιμόπουλος']
    ],
    ['a street, three ways', ['ΟΔΟΣ ΑΛΦΑ 1', 'οδός άλφα 1', 'Οδός  Άλφα-1']]
  ])('%s give one key', (_what, spellings) => {
    const keys = spellings.map(searchKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[\u03b1-\u03c9\d]+$/);
  });

  it('gives the lower-case letters, no accent, medial sigma, nothing between', () => {
    expect(searchKey('Δοκιμόπουλος')).toBe('δοκιμοπουλοσ');
    expect(searchKey('ΟΔΟΣ ΑΛΦΑ 1')).toBe('οδοσαλφα1');
  });

  it('folds dialytika, and dialytika with the accent', () => {
    expect(searchKey('Μαΐου')).toBe(searchKey('ΜΑΙΟΥ'));
    expect(searchKey('προϋπόθεση')).toBe(searchKey('ΠΡΟΥΠΟΘΕΣΗ'));
    expect(searchKey('ΐ')).toBe('ι');
  });

  it('finds a word that ends in ς inside a typed text that goes on', () => {
    const stored = searchKey('ΟΔΟΣ ΑΛΦΑ');
    expect(stored.includes(searchKey('οδος αλφα'))).toBe(true);
    expect(stored.includes(searchKey('οδός'))).toBe(true);
  });

  it('keeps Latin text, digits and an e-mail working', () => {
    expect(searchKey('Test.User-1@example.com')).toBe('testuser1@examplecom');
    expect(searchKey('ÉCOLE')).toBe('ecole');
    expect(searchKey('6900 000-000')).toBe('6900000000');
  });

  it('never throws, and gives a string', () => {
    expect(searchKey(null)).toBe('');
    expect(searchKey(undefined)).toBe('');
    expect(searchKey(0)).toBe('0');
    expect(searchKey(12345)).toBe('12345');
    expect(searchKey('')).toBe('');
    expect(searchKey('   ')).toBe('');
  });

  describe('nothing found before is lost', () => {
    // a small deterministic generator, so a failure repeats
    let seed = 20261124;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const ALPHABET = [
      ...'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ0123456789',
      ' ',
      ' ',
      '.',
      '-'
    ];
    const random = () => {
      let s = '';
      for (let n = 1 + Math.floor(next() * 24); n > 0; n--) {
        s += ALPHABET[Math.floor(next() * ALPHABET.length)];
      }
      return s;
    };
    const old = (s) =>
      s
        .replace(/\s|\.|-/gi, '')
        .toLowerCase()
        .replace(/ς/g, 'σ');

    it('gives, for 2000 random capitals without accents, what the lists gave', () => {
      for (let i = 0; i < 2000; i++) {
        const s = random();
        expect(searchKey(s)).toBe(old(s));
      }
    });

    it('finds every piece of a stored text that the lists found', () => {
      for (let i = 0; i < 2000; i++) {
        const s = random();
        const from = Math.floor(next() * s.length);
        const piece = s.slice(from, from + 1 + Math.floor(next() * 8));
        // what the lists did: the typed piece reduced like the stored text
        if (old(s).indexOf(old(piece)) !== -1) {
          expect(searchKey(s).indexOf(searchKey(piece))).not.toBe(-1);
        }
      }
    });
  });
});

// ── the seven places ───────────────────────────────────────────────────────────
// Each list page keeps its own filter; none of them is exported, so the tests
// read the page source and RUN the filter functions out of it (`_filterData`;
// on the accounting page `_filterOwners` and `_filterAccounting`), on stored
// values written the way the tax office prints them and typed the way Greek is
// typed.

const PAGES = path.resolve(__dirname, '../pages/[organization]');
const PAGE_FILES = {
  rents: 'rents/[yearMonth]/index.js',
  tenants: 'tenants/index.js',
  buildings: 'buildings/index.js',
  properties: 'properties/index.js',
  owners: 'owners/index.js',
  accounting: 'accounting/[year].js'
};
const source = (page) =>
  fs.readFileSync(path.join(PAGES, PAGE_FILES[page]), 'utf8');

function filterOf(page, name = '_filterData') {
  const src = source(page);
  const from = src.indexOf(`function ${name}(`);
  const to = src.indexOf('\n}\n', from);
  expect(from).toBeGreaterThanOrEqual(0);
  // eslint-disable-next-line no-new-func
  return new Function(
    'searchKey',
    `${src.slice(from, to + 2)}\nreturn ${name};`
  )(searchKey);
}
const found = (filter, data, searchText, key = '_id') =>
  filter(data, { searchText, statuses: [] }).map((row) => row[key]);

describe('the six list pages use searchKey and keep no copy of the normalisation', () => {
  it.each(Object.keys(PAGE_FILES))('%s', (page) => {
    const src = source(page);
    expect(src).toMatch(
      /import \{ searchKey \} from '[./]+\/utils\/searchKey';/
    );
    expect(src).not.toContain(".replace(/ς/g, 'σ')");
    expect(src).not.toContain('\\s|\\.|-');
    expect(src).not.toMatch(/const norm\b/);
  });
});

describe('rents list', () => {
  const filter = filterOf('rents');
  const rent = (_id, occupant, payments = []) => ({
    _id,
    status: 'notpaid',
    occupant: {
      isCompany: false,
      name: '',
      manager: '',
      contacts: [],
      ...occupant
    },
    payments
  });
  const data = {
    rents: [
      rent('name', { name: 'ΔΟΚΙΜΟΠΟΥΛΟΣ ΑΛΦΑ' }),
      rent('person', { name: 'ΑΛΛΟΣ', manager: 'ΠΡΟΣΩΠΟΥ ΜΑΝΑΤΖΕΡ' }),
      rent('manager', {
        isCompany: true,
        name: 'ΕΤΑΙΡΕΙΑ ΒΗΤΑ',
        manager: 'ΔΙΑΧΕΙΡΙΣΤΗΣ ΔΕΛΤΑ'
      }),
      rent('contact', { contacts: [{ contact: 'ΕΠΑΦΗ ΕΨΙΛΟΝ' }] }),
      rent('email', { contacts: [{ email: 'ΖΗΤΑ.ΔΟΚΙΜΗ@example.com' }] }),
      rent('phone', { contacts: [{ phone: '210 000 0000' }] }),
      rent('phone1', { contacts: [{ phone1: '6900-000-001' }] }),
      rent('phone2', { contacts: [{ phone2: '6900.000.002' }] }),
      rent('reference', {}, [{ reference: 'ΠΛΗΡΩΜΗ ΗΤΑ' }, { reference: null }])
    ]
  };

  it.each([
    ['δοκιμόπουλος αλφα', 'name'],
    ['εταιρεία βήτα', 'manager'],
    ['διαχειριστής δέλτα', 'manager'],
    ['Επαφή έψιλον', 'contact'],
    ['ζήτα.δοκιμή@example.com', 'email'],
    ['210 000 0000', 'phone'],
    ['6900 000 001', 'phone1'],
    ['6900-000-002', 'phone2'],
    ['πληρωμή ήτα', 'reference']
  ])('«%s» finds %s', (typed, id) => {
    expect(found(filter, data, typed)).toEqual([id]);
  });

  it('still leaves out what does not match, and the manager of a person', () => {
    expect(found(filter, data, 'ΘΗΤΑ')).toEqual([]);
    expect(found(filter, data, 'προσώπου μάνατζερ')).toEqual([]);
  });

  it('does not fail on a missing list', () => {
    expect(filter(undefined, { searchText: 'α', statuses: [] })).toEqual([]);
  });
});

describe('tenants list', () => {
  const filter = filterOf('tenants');
  const tenant = (_id, fields) => ({
    _id,
    isCompany: false,
    name: '',
    manager: '',
    contacts: [],
    properties: [],
    ...fields
  });
  const data = [
    tenant('name', { name: 'ΔΟΚΙΜΟΠΟΥΛΟΣ ΑΛΦΑ' }),
    tenant('person', { name: 'ΑΛΛΟΣ', manager: 'ΠΡΟΣΩΠΟΥ ΜΑΝΑΤΖΕΡ' }),
    tenant('manager', {
      isCompany: true,
      name: 'ΕΤΑΙΡΕΙΑ ΒΗΤΑ',
      manager: 'ΔΙΑΧΕΙΡΙΣΤΗΣ ΔΕΛΤΑ'
    }),
    tenant('contact', { contacts: [{ contact: 'ΕΠΑΦΗ ΕΨΙΛΟΝ' }] }),
    tenant('email', { contacts: [{ email: 'ΖΗΤΑ.ΔΟΚΙΜΗ@example.com' }] }),
    tenant('phone', { contacts: [{ phone: '210 000 0000' }] }),
    tenant('phone1', { contacts: [{ phone1: '6900-000-001' }] }),
    tenant('phone2', { contacts: [{ phone2: '6900.000.002' }] }),
    tenant('property', { properties: [{ property: { name: 'ΟΔΟΣ ΑΛΦΑ 1' } }] })
  ];

  it.each([
    ['δοκιμόπουλος αλφα', 'name'],
    ['διαχειριστής δέλτα', 'manager'],
    ['Επαφή έψιλον', 'contact'],
    ['ζήτα.δοκιμή@example.com', 'email'],
    ['210 000 0000', 'phone'],
    ['6900 000 001', 'phone1'],
    ['6900-000-002', 'phone2'],
    ['οδός άλφα 1', 'property']
  ])('«%s» finds %s', (typed, id) => {
    expect(found(filter, data, typed)).toEqual([id]);
  });

  it('still leaves out what does not match, and the manager of a person', () => {
    expect(found(filter, data, 'ΘΗΤΑ')).toEqual([]);
    expect(found(filter, data, 'προσώπου μάνατζερ')).toEqual([]);
  });
});

describe('buildings list', () => {
  const filter = filterOf('buildings');
  const data = [
    { _id: 'name', name: 'ΟΔΟΣ ΑΛΦΑ' },
    { _id: 'description', name: 'Χ', description: 'ΠΟΛΥΚΑΤΟΙΚΙΑ ΒΗΤΑ' },
    { _id: 'street', name: 'Ψ', address: { street1: 'ΛΕΩΦΟΡΟΣ ΓΑΜΑ 2' } },
    { _id: 'city', name: 'Ω', address: { city: 'ΔΟΚΙΜΟΥΠΟΛΗ' } },
    { _id: 'nothing', name: 'Φ' }
  ];

  it.each([
    ['οδός άλφα', 'name'],
    ['Πολυκατοικία Βήτα', 'description'],
    ['λεωφόρος γάμα 2', 'street'],
    ['δοκιμούπολη', 'city']
  ])('«%s» finds %s', (typed, id) => {
    expect(found(filter, data, typed)).toEqual([id]);
  });

  it('a building with nothing written does not match every query', () => {
    expect(found(filter, data, 'ΘΗΤΑ')).toEqual([]);
  });
});

describe('apartments list', () => {
  const filter = filterOf('properties');
  const data = [
    { _id: 'name', name: 'ΔΙΑΜΕΡΙΣΜΑ ΑΛΦΑ' },
    { _id: 'atak', name: 'Χ', atakNumber: 'ΑΤΑΚ-ΒΗΤΑ 1' },
    { _id: 'street', name: 'Ψ', address: { street1: 'ΛΕΩΦΟΡΟΣ ΓΑΜΑ 2' } },
    { _id: 'city', name: 'Ω', address: { city: 'ΔΟΚΙΜΟΥΠΟΛΗ' } },
    { _id: 'surface', name: 'Φ', surface: 72 }
  ];

  it.each([
    ['διαμέρισμα άλφα', 'name'],
    ['ατακ βήτα 1', 'atak'],
    ['λεωφόρος γάμα 2', 'street'],
    ['δοκιμούπολη', 'city'],
    ['72', 'surface']
  ])('«%s» finds %s', (typed, id) => {
    expect(found(filter, data, typed)).toEqual([id]);
  });

  it('still leaves out what does not match', () => {
    expect(found(filter, data, 'ΘΗΤΑ')).toEqual([]);
  });
});

describe('owners list', () => {
  const filter = filterOf('owners');
  const data = [
    { _id: 'name', name: 'ΙΔΙΟΚΤΗΤΗΣ ΑΛΦΑ', taxId: '999000001' },
    { _id: 'taxId', name: 'Χ', taxId: 'ΑΦΜ-ΒΗΤΑ 7' },
    { _id: 'nothing', name: null, taxId: null }
  ];

  it.each([
    ['ιδιοκτήτης άλφα', 'name'],
    ['999 000 001', 'name'],
    ['αφμ βήτα 7', 'taxId']
  ])('«%s» finds %s', (typed, id) => {
    expect(found(filter, data, typed)).toEqual([id]);
  });

  it('still leaves out what does not match', () => {
    expect(found(filter, data, 'ΘΗΤΑ')).toEqual([]);
  });
});

describe('accounting page', () => {
  const owners = filterOf('accounting', '_filterOwners');
  const accounting = filterOf('accounting', '_filterAccounting');
  const ids = (rows) => rows.map((row) => row._id);

  describe('owners tab', () => {
    const data = [
      { _id: 'name', name: 'ΙΔΙΟΚΤΗΤΗΣ ΑΛΦΑ', taxId: '999000001' },
      { _id: 'taxId', name: 'Χ', taxId: 'ΑΦΜ-ΒΗΤΑ 7' },
      { _id: 'nothing', name: null, taxId: null }
    ];

    it.each([
      ['ιδιοκτήτης άλφα', 'name'],
      ['999 000 001', 'name'],
      ['αφμ βήτα 7', 'taxId']
    ])('«%s» finds %s', (typed, id) => {
      expect(ids(owners(data, typed))).toEqual([id]);
    });

    it('a query that matches nothing finds nothing', () => {
      expect(owners(data, 'ΘΗΤΑ')).toEqual([]);
    });

    it('an empty query returns the data as it is, and a missing list is empty', () => {
      expect(owners(data, '')).toBe(data);
      expect(owners(undefined, 'α')).toEqual([]);
      expect(owners(undefined, '')).toEqual([]);
    });
  });

  describe('incoming tenants, outgoing tenants and settlements', () => {
    const data = {
      year: 2026,
      incomingTenants: [
        { _id: 'in', name: 'ΕΙΣΕΡΧΟΜΕΝΟΣ ΑΛΦΑ' },
        { _id: 'in-other', name: 'ΑΛΛΟΣ ΒΗΤΑ' }
      ],
      outgoingTenants: [
        { _id: 'out', name: 'ΕΞΕΡΧΟΜΕΝΟΣ ΒΗΤΑ' },
        { _id: 'out-other', name: 'ΑΛΛΟΣ ΓΑΜΑ' }
      ],
      settlements: [
        { _id: 'set', tenant: 'ΕΞΟΦΛΗΣΗ ΓΑΜΑ' },
        { _id: 'set-other', tenant: 'ΑΛΛΟΣ ΔΕΛΤΑ' }
      ]
    };

    it.each([
      ['incomingTenants', 'εισερχόμενος άλφα', 'in'],
      ['outgoingTenants', 'ΕΞΕΡΧΟΜΕΝΟΣ βήτα', 'out'],
      ['settlements', 'εξόφληση γάμα', 'set']
    ])(
      'an accented query finds the capitals name in %s only',
      (list, typed, id) => {
        const result = accounting(data, typed);
        expect(ids(result[list])).toEqual([id]);
        for (const other of [
          'incomingTenants',
          'outgoingTenants',
          'settlements'
        ]) {
          if (other !== list) expect(result[other]).toEqual([]);
        }
      }
    );

    it('a query that matches nothing finds nothing, in any of the three', () => {
      expect(accounting(data, 'ΘΗΤΑ')).toEqual({
        year: 2026,
        incomingTenants: [],
        outgoingTenants: [],
        settlements: []
      });
    });

    it('an empty query returns the data as it is, and no data is an empty object', () => {
      expect(accounting(data, '')).toBe(data);
      expect(accounting(undefined, 'α')).toEqual({});
      expect(accounting(undefined, '')).toEqual({});
    });

    it('keeps every other field, and a list that is missing stays empty', () => {
      expect(accounting({ year: 2026, incomingTenants: [] }, 'α')).toEqual({
        year: 2026,
        incomingTenants: [],
        outgoingTenants: [],
        settlements: []
      });
    });
  });
});

// A search used to THROW on a missing value in three places, and the list then
// fell back silently (List.handleSearch): the tenants list showed everything
// unfiltered, the rents list showed nothing. searchKey() reads a missing value
// as '', so the search applies and finds the right rows. This is the one place
// where a search now returns other rows than it did.
describe('searches that used to throw on a missing value', () => {
  const tenant = (_id, fields) => ({
    _id,
    isCompany: false,
    name: 'ΑΛΛΟΣ',
    manager: '',
    contacts: [],
    properties: [],
    ...fields
  });
  const rent = (_id, occupant, payments = []) => ({
    _id,
    status: 'notpaid',
    occupant: {
      isCompany: false,
      name: 'ΑΛΛΟΣ',
      manager: '',
      contacts: [],
      ...occupant
    },
    payments
  });

  it('tenants: a property without a name does not stop the search', () => {
    const data = [
      tenant('nameless', {
        properties: [{ property: {} }, { property: { name: null } }]
      }),
      tenant('named', { properties: [{ property: { name: 'ΟΔΟΣ ΑΛΦΑ 1' } }] }),
      tenant('none')
    ];
    expect(found(filterOf('tenants'), data, 'οδός άλφα 1')).toEqual(['named']);
  });

  it('tenants: a contact without an e-mail does not stop the search', () => {
    const data = [
      tenant('no-email', {
        contacts: [{ contact: 'ΕΠΑΦΗ ΕΨΙΛΟΝ', email: null }]
      }),
      tenant('email', {
        contacts: [{ contact: 'ΑΛΛΗ', email: 'a@example.com' }]
      })
    ];
    const filter = filterOf('tenants');
    expect(found(filter, data, 'επαφή έψιλον')).toEqual(['no-email']);
    expect(found(filter, data, 'a@example.com')).toEqual(['email']);
  });

  it('rents: a contact without an e-mail does not stop the search', () => {
    const data = {
      rents: [
        rent('no-email', {
          contacts: [{ contact: 'ΕΠΑΦΗ ΕΨΙΛΟΝ', email: null }]
        }),
        rent('email', {
          contacts: [{ contact: 'ΑΛΛΗ', email: 'a@example.com' }]
        })
      ]
    };
    const filter = filterOf('rents');
    expect(found(filter, data, 'επαφή έψιλον')).toEqual(['no-email']);
    expect(found(filter, data, 'a@example.com')).toEqual(['email']);
  });

  it('rents: a payment without a reference does not stop the search', () => {
    const data = {
      rents: [
        rent('nameless', {}, [{ reference: null }, {}]),
        rent('named', {}, [{ reference: null }, { reference: 'ΠΛΗΡΩΜΗ ΗΤΑ' }]),
        rent('none')
      ]
    };
    expect(found(filterOf('rents'), data, 'πληρωμή ήτα')).toEqual(['named']);
  });
});
