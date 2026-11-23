import moment from 'moment';

/**
 * Greek month names in the grammatical cases the UI actually needs.
 *
 * moment's `el` locale returns the NOMINATIVE from `format('MMMM')`
 * («Ιούλιος») and the GENITIVE only when a day-of-month token is present
 * («1 Ιουλίου»). Interpolating the nominative into a slot governed by a
 * preposition produces broken Greek — «για Ιούλιος 2026» instead of «για
 * Ιούλιο 2026». Latin locales don't inflect, so the bug is invisible to a
 * reviewer reading the English screen.
 *
 * Three copies of these arrays already exist inline (MonthFigures,
 * BuildingDashboard, overview/[year]); this module is the shared home for
 * new call sites. It is deliberately NOT a `utils/index.js` export —
 * that module is imported app-wide and carries the `cn()` warning.
 */

// After «για», «έως», «τον» — the accusative.
const EL_ACCUSATIVE = [
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

// Standing on its own — a list entry, the subject of a sentence — the nominative.
// (moment's `el` locale gives it too, but only when moment's locale IS `el`; these
// helpers go by the `lang` they are handed, like the two below.)
const EL_NOMINATIVE = [
  'Ιανουάριος',
  'Φεβρουάριος',
  'Μάρτιος',
  'Απρίλιος',
  'Μάιος',
  'Ιούνιος',
  'Ιούλιος',
  'Αύγουστος',
  'Σεπτέμβριος',
  'Οκτώβριος',
  'Νοέμβριος',
  'Δεκέμβριος'
];

// After a noun — «το ενοίκιο Νοεμβρίου 2026», «η απόδειξη Ιουλίου» — the genitive.
const EL_GENITIVE = [
  'Ιανουαρίου',
  'Φεβρουαρίου',
  'Μαρτίου',
  'Απριλίου',
  'Μαΐου',
  'Ιουνίου',
  'Ιουλίου',
  'Αυγούστου',
  'Σεπτεμβρίου',
  'Οκτωβρίου',
  'Νοεμβρίου',
  'Δεκεμβρίου'
];

/**
 * «<Month> <YYYY>» for a slot governed by a preposition that takes the
 * accusative (e.g. the el string «Έχει καταχωρηθεί για {{month}}»).
 *
 * Non-Greek locales fall through to moment's own month name: they do not
 * inflect, so `format('MMMM YYYY')` is already correct there.
 *
 * @param {import('moment').Moment} m   the month to name (must be valid)
 * @param {string} lang                 the active locale from useTranslation
 * @returns {string}
 */
export function monthYearAccusative(m, lang) {
  if (!m?.isValid?.()) return '';
  return lang === 'el'
    ? `${EL_ACCUSATIVE[m.month()]} ${m.format('YYYY')}`
    : m.format('MMMM YYYY');
}

/**
 * Same, from a YYYYMMDDHH rent term (or any prefix of one — only the first
 * 6 chars are read). Returns '' for an unparseable term rather than
 * moment's "now", so a caller never labels a row with today's month by
 * accident.
 *
 * @param {number|string} term
 * @param {string} lang
 * @returns {string}
 */
export function termMonthYearAccusative(term, lang) {
  const ym = String(term ?? '').slice(0, 6);
  const m = moment(ym, 'YYYYMM', true);
  return m.isValid() ? monthYearAccusative(m, lang) : '';
}

/**
 * «<Month> <YYYY>» for a slot that follows a noun (the el string «χρεώθηκε στο
 * ενοίκιο {{month}}» → «… στο ενοίκιο Νοεμβρίου 2026»): the genitive in Greek,
 * moment's own month name everywhere else. From a YYYYMMDDHH rent term; ''
 * for an unparseable one.
 *
 * @param {number|string} term
 * @param {string} lang
 * @returns {string}
 */
export function termMonthYearGenitive(term, lang) {
  const ym = String(term ?? '').slice(0, 6);
  const m = moment(ym, 'YYYYMM', true);
  if (!m.isValid()) return '';
  return lang === 'el'
    ? `${EL_GENITIVE[m.month()]} ${m.format('YYYY')}`
    : m.format('MMMM YYYY');
}

/**
 * «<Month> <YYYY>» standing on its own («✓ Νοέμβριος 2026», «Ο Οκτώβριος 2026 έχει
 * κλείσει…»): the nominative in Greek, moment's own month name everywhere else. From
 * a YYYYMMDDHH rent term; '' for an unparseable one.
 *
 * @param {number|string} term
 * @param {string} lang
 * @returns {string}
 */
export function termMonthYearNominative(term, lang) {
  const ym = String(term ?? '').slice(0, 6);
  const m = moment(ym, 'YYYYMM', true);
  if (!m.isValid()) return '';
  return lang === 'el'
    ? `${EL_NOMINATIVE[m.month()]} ${m.format('YYYY')}`
    : m.format('MMMM YYYY');
}

/**
 * «<Month>», no year, for a slot governed by «τον» («έχει εξοφλήσει τον Νοέμβριο»):
 * the accusative in Greek, moment's own month name everywhere else. From a
 * YYYYMMDDHH rent term; '' for an unparseable one.
 *
 * @param {number|string} term
 * @param {string} lang
 * @returns {string}
 */
export function termMonthAccusative(term, lang) {
  const ym = String(term ?? '').slice(0, 6);
  const m = moment(ym, 'YYYYMM', true);
  if (!m.isValid()) return '';
  return lang === 'el' ? EL_ACCUSATIVE[m.month()] : m.format('MMMM');
}
