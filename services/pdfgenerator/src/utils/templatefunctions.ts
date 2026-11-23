import { fileURLToPath } from 'url';
import i18n from 'i18n';
import moment from 'moment';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

i18n.configure({
  locales: ['en', 'fr-FR', 'pt-BR', 'de-DE', 'es-CO', 'el'],
  directory: path.join(__dirname, '..', '..', 'templates', 'locales'),
  updateFiles: false
});

// Greek month names in the ACCUSATIVE — the case «για» governs («για Οκτώβριο 2026»).
// moment's `el` locale gives the nominative («Οκτώβριος») or, next to a day number, the
// genitive («Οκτωβρίου»); neither is right after «για». The landlord app keeps the same
// list in webapps/landlord/src/utils/greekMonths.js.
const EL_ACCUSATIVE_MONTHS = [
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

export default function ({ locale, currency }: { locale: string; currency: string }) {
  moment.locale(locale);
  i18n.setLocale(locale);

  return {
    t: (...params: Parameters<typeof i18n.__>) => {
      return i18n.__(...params);
    },
    // «<month> <year>» for the slot after «for»/«για»: a building-charge line billed on
    // a later month says which month it is FOR («… · για Οκτώβριο 2026»). '' when the
    // term is not a month, so a caller never prints today's month by accident.
    formatTermFor: (termTxt: string | number): string => {
      const term = moment(String(termTxt), 'YYYYMMDDHH', true);
      if (!term.isValid()) {
        return '';
      }
      if (locale === 'el' || locale.startsWith('el-')) {
        return `${EL_ACCUSATIVE_MONTHS[term.month()]} ${term.format('YYYY')}`;
      }
      return term.format('MMMM YYYY');
    },
    formatNumber: (value: number, style = 'decimal', minimumFractionDigits = 2): string => {
      if (['currency', 'decimal'].includes(style)) {
        return Intl.NumberFormat(locale, {
          style: style as 'currency' | 'decimal',
          currency,
          minimumFractionDigits
        }).format(value);
      }

      if (style === 'percent') {
        return Number(value).toLocaleString(locale, {
          style: 'percent',
          minimumFractionDigits
        });
      }

      return String(value);
    },
    formatDate: (dateTxt: string, localizedFormat: string): string => {
      return moment(dateTxt, 'DD/MM/YYYY').format(localizedFormat);
    },
    formatTerm: (termTxt: string, timeRange: string): string => {
      const term = moment(termTxt, 'YYYYMMDDHH');
      if (timeRange === 'days') {
        return term.format('LL');
      }

      if (timeRange === 'weeks') {
        return i18n.__('{{month}} {{startDay}} to {{endDay}}', {
          month: term.format('MMM'),
          startDay: term.startOf('week').format('Do'),
          endDay: term.endOf('week').format('Do')
        });
      }

      if (timeRange === 'months') {
        // Greek grammar: after a noun («απόδειξη ...», «εκκαθαριστικό ...») the
        // month must be GENITIVE («Ιουλίου 2026»), not nominative («Ιούλιος
        // 2026»). moment's el locale only emits the genitive when a day-of-month
        // token precedes MMMM, so format one and strip it. This mirrors the
        // emailer's formatTerm so an email and its ATTACHED PDF agree (they
        // previously said «Ιουλίου» vs «Ιούλιος» for the same term).
        if (locale === 'el' || locale.startsWith('el-')) {
          const genitiveMonth = term.format('D MMMM').replace(/^\d+\s/, '');
          return `${genitiveMonth} ${term.format('YYYY')}`;
        }
        return term.format('MMMM YYYY');
      }

      if (timeRange === 'years') {
        return term.format('YYYY');
      }
      return termTxt;
    }
  };
}
