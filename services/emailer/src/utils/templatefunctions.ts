import i18n from 'i18n';
import moment from 'moment';

export default function ({ locale, currency }: { locale: string; currency: string }) {
  moment.locale(locale);
  i18n.setLocale(locale);

  return {
    t: (...params: any[]) => {
      return (i18n.__ as any)(...params);
    },
    formatNumber: (value: number, style = 'decimal', minimumFractionDigits = 2) => {
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

      return value;
    },
    formatDate: (dateTxt: string, localizedFormat: string) => {
      return moment(dateTxt, 'DD/MM/YYYY').format(localizedFormat);
    },
    formatTerm: (termTxt: string, timeRange: string) => {
      const term = moment(termTxt, 'YYYYMMDDHH');
      if (timeRange === 'days') {
        return term.format('LL');
      }

      if (timeRange === 'weeks') {
        return `${term.format('MMM')} ${term
          .startOf('week')
          .format('Do')} - ${term.endOf('week').format('Do')}`;
      }

      if (timeRange === 'months') {
        // Greek grammar: after a noun («ειδοποίηση ενοικίου ...», «απόδειξη
        // ...») the month must be GENITIVE («Ιουλίου 2026»), not nominative
        // («Ιούλιος 2026»). moment's el locale only emits the genitive form
        // when a day-of-month token precedes MMMM, so format one and strip it.
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
