import {
  monthYearAccusative,
  termMonthYearAccusative
} from '../utils/greekMonths';
import moment from 'moment';
import 'moment/locale/el';

// i18n (bill-OCR audit 2026-07, review follow-up): the duplicate-bill banner
// interpolates a month name into «Έχει καταχωρηθεί για {{month}}». «για»
// governs the ACCUSATIVE, but moment's el locale returns the NOMINATIVE from
// format('MMMM') — so the shipped banner read «για Ιούλιος 2026» instead of
// «για Ιούλιο 2026». Latin locales don't inflect, which is exactly why an
// English-screen review can't catch this class of bug.
//
// These tests pin the accusative for el AND pin the pass-through for every
// other locale, so a future "simplification" back to format('MMMM YYYY')
// fails here rather than on a user's screen.
describe('monthYearAccusative', () => {
  const JULY = moment('202607', 'YYYYMM', true);

  it('returns the ACCUSATIVE month for el (not moment’s nominative)', () => {
    // The mutation-killer: format('MMMM YYYY') under el yields «Ιούλιος 2026».
    expect(monthYearAccusative(JULY, 'el')).toBe('Ιούλιο 2026');
    expect(monthYearAccusative(JULY, 'el')).not.toContain('Ιούλιος');
  });

  it('covers all twelve months in the accusative', () => {
    const expected = [
      'Ιανουάριο',
      'Φεβρουάριο',
      'Μάρτιο',
      'Απρίλιο',
      'Μάιο',
      'Ιούνιο',
      'Ιούλιο',
      'Αύγουστο',
      'Σεπτέμβριο',
      'Οκτώβριο',
      'Νοέμβριο',
      'Δεκέμβριο'
    ];
    const actual = expected.map((_, i) =>
      monthYearAccusative(
        moment(`2026${String(i + 1).padStart(2, '0')}`, 'YYYYMM', true),
        'el'
      )
    );
    expect(actual).toEqual(expected.map((m) => `${m} 2026`));
  });

  it('falls through to moment for non-inflecting locales', () => {
    // _app.js does `moment.locale(__lang)`, so moment's global locale and the
    // `lang` arg always agree in the app. Model that here rather than asking
    // for 'en' while moment is still Greek.
    const prev = moment.locale();
    try {
      moment.locale('en');
      expect(monthYearAccusative(moment('202607', 'YYYYMM', true), 'en')).toBe(
        'July 2026'
      );
      // …and the term variant falls through too.
      expect(termMonthYearAccusative(2026070100, 'en')).toBe('July 2026');
    } finally {
      moment.locale(prev);
    }
  });

  it('returns empty string for an invalid/absent moment rather than today', () => {
    // A blank label is recoverable; silently labelling a row with TODAY's
    // month is the failure mode that makes wrong money look right.
    expect(monthYearAccusative(moment('nope', 'YYYYMM', true), 'el')).toBe('');
    expect(monthYearAccusative(null, 'el')).toBe('');
    expect(monthYearAccusative(undefined, 'en')).toBe('');
  });
});

describe('termMonthYearAccusative', () => {
  it('reads the month out of a YYYYMMDDHH rent term', () => {
    expect(termMonthYearAccusative(2026070100, 'el')).toBe('Ιούλιο 2026');
    expect(termMonthYearAccusative('2026010100', 'el')).toBe('Ιανουάριο 2026');
  });

  it('ignores the day/hour tail (a term is month-granular here)', () => {
    expect(termMonthYearAccusative(2026073123, 'el')).toBe(
      termMonthYearAccusative(2026070100, 'el')
    );
  });

  it('returns empty string for an unparseable term, never today’s month', () => {
    // moment(undefined) is NOW — a duplicate banner that names the current
    // month when the term is missing would send the landlord to the wrong
    // month to check for the duplicate.
    for (const bad of [undefined, null, '', 'abc', 0, '20261301']) {
      expect(termMonthYearAccusative(bad, 'el')).toBe('');
    }
  });
});
