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

export default function ({ locale, currency }: { locale: string; currency: string }) {
  moment.locale(locale);
  i18n.setLocale(locale);

  return {
    t: (...params: Parameters<typeof i18n.__>) => {
      return i18n.__(...params);
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
        return term.format('MMMM YYYY');
      }

      if (timeRange === 'years') {
        return term.format('YYYY');
      }
      return termTxt;
    }
  };
}
