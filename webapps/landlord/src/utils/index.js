import { clsx } from 'clsx';
import moment from 'moment';
import { twMerge } from 'tailwind-merge';

// NOTE: stock tailwind-merge (not extended). An earlier attempt to teach
// it the custom font-size tokens (text-label/title/...) was correct in
// isolation but had APP-WIDE blast radius: dozens of components had been
// silently rendering a dropped custom size at the 16px browser default
// for months, and "fixing" the merge made every one of them snap to its
// real (smaller) size at once — the whole UI looked tiny. We do NOT make
// global cn() changes to solve local sizing. Components that must combine
// a custom size with a text-colour use an arbitrary-value size class
// (e.g. text-[0.6875rem]), which stock tailwind-merge keeps alongside the
// colour. See badge.js / TenantListItem pills.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function getPeriod(t, term, frequency) {
  const termMoment = moment(term, 'YYYYMMDDHH');
  switch (frequency) {
    case 'years':
      return termMoment.format('YYYY');
    case 'months':
      return t('{{month}} {{year}}', {
        month: termMoment.format('MMMM'),
        year: termMoment.format('YYYY')
      });
    case 'weeks':
      return t('{{month}} {{startDay}} to {{endDay}}', {
        month: termMoment.format('MMM'),
        startDay: termMoment.startOf('week').format('Do'),
        endDay: termMoment.endOf('week').format('Do')
      });
    case 'days':
      return termMoment.format('L');
    default:
      return '';
  }
}

export function buildPathname(router) {
  let basePath = router.basePath || '';
  if (router.locale) {
    basePath = `${basePath}/${router.locale}`;
  }

  const segments = router.pathname.match(/\[[^\]]+\]/g);
  let newPathname = router.pathname;
  if (segments) {
    segments.forEach((segment) => {
      const key = segment.slice(1, -1);
      newPathname = newPathname.replace(segment, router.query[key] || '');
    });
  }

  return `${basePath}${newPathname}`;
}
