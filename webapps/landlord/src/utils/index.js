import { clsx } from 'clsx';
import moment from 'moment';
import { extendTailwindMerge } from 'tailwind-merge';

// The Tailwind config defines CUSTOM font-size keys (label/body/title/
// headline/display/display-lg). Stock tailwind-merge only knows the
// built-in scale (xs/sm/base/...), so it treats e.g. `text-label` and
// `text-amber-700` as two conflicting `text-*` utilities and SILENTLY
// DROPS `text-label` — leaving the element at the browser-default 16px.
// That made every pill/badge that combined a custom size with a text
// colour via cn() render huge (the recurring "pill fonts are huge" bug).
// Teach tailwind-merge the custom font-size keys so size + colour coexist.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: ['label', 'body', 'title', 'headline', 'display', 'display-lg']
        }
      ]
    }
  }
});

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
