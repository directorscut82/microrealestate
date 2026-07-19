import i18n from 'i18n';
import moment from 'moment';

export default function ({ locale, currency }: { locale: string; currency: string }) {
  moment.locale(locale);
  i18n.setLocale(locale);

  // Normalise one raw period token to a full YYYYMMDDHH term (a bare 4-digit
  // year → January of that year) and pick the timeRange.
  const _oneTerm = (
    raw: string
  ): { termTxt: string; timeRange: 'years' | 'months' } => {
    const s = String(raw).trim();
    return s.length === 4
      ? { termTxt: `${s}010100`, timeRange: 'years' }
      : { termTxt: s, timeRange: 'months' };
  };

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
    },
    // N2 (audit-2026-07): render a WHOLE period, which may be a comma-separated
    // list of terms (a multi-month owner send). The old inline IIFE took only
    // `split(',')[0]`, so a Jan+Feb+Mar send was labelled «Ιανουαρίου 2026»
    // while its attached PDF covered all three. Format the FULL span: a single
    // term → that term; multiple → «first – last» using the same (genitive)
    // formatTerm so email text and PDF agree.
    formatPeriod(period: string): string {
      const parts = String(period || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0) return '';
      const fmt = (raw: string) => {
        const { termTxt, timeRange } = _oneTerm(raw);
        return this.formatTerm(termTxt, timeRange);
      };
      if (parts.length === 1) return fmt(parts[0]);
      const sorted = [...parts].sort();
      const first = fmt(sorted[0]);
      const last = fmt(sorted[sorted.length - 1]);
      return first === last ? first : `${first} – ${last}`;
    }
  };
}
