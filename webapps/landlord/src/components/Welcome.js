import { cn } from '../utils';
import { StoreContext } from '../store';
import { useContext } from 'react';
import useTranslation from 'next-translate/useTranslation';

/*
 * Welcome — DESIGN.md page-level greeting.
 *
 * Quiet, single-line. Manrope at body size + 500 weight, ink color. Marks
 * the dashboard's "where am I" without dominating the page.
 */
export default function Welcome({ className }) {
  const store = useContext(StoreContext);
  const { t } = useTranslation('common');
  return (
    <div
      className={cn(
        'text-title font-medium text-ink-soft tracking-tight',
        className
      )}
    >
      {t('Welcome {{firstName}} {{lastName}}!', {
        firstName: store.user.firstName,
        lastName: store.user.lastName
      })}
    </div>
  );
}
