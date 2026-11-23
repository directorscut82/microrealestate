import { amountOf, outcomeView, unitNameOf } from '../../utils/chargeOutcome';
import {
  termMonthAccusative,
  termMonthYearGenitive,
  termMonthYearNominative
} from '../../utils/greekMonths';
import { cn } from '../../utils';
import NumberFormat from '../NumberFormat';
import useTranslation from 'next-translate/useTranslation';

/**
 * Where each tenant's share of a saved bill went — one row per unit and tenant, read
 * back from the tenants' rents by the server after saving (`chargeOutcome`). So a «✓»
 * here means the share IS on that rent.
 *
 *   ✓ στο ενοίκιο Νοεμβρίου 2026        (olive)  on that month's rent
 *       έχει εξοφλήσει τον Νοέμβριο      (muted)  …the month after one the tenant paid
 *   ⚠ δεν χρεώθηκε                       (oxide)  on no rent
 *       η μίσθωση έχει λήξει             (muted)  …because the lease has ended
 *
 * When the rent holds another amount than the share (a figure changed after that rent
 * was closed) the amount that was charged follows in brackets, as on the building
 * page. `compact` (the Telegram bell): the month alone and no second line.
 * Status colour is always paired with its glyph and its words (DESIGN.md).
 */
export default function ChargeOutcomeList({
  outcomes,
  building,
  compact = false
}) {
  const { t, lang } = useTranslation('common');
  const list = Array.isArray(outcomes) ? outcomes.filter(Boolean) : [];
  if (list.length === 0) return null;
  // ONE grid for the whole list (each row is a subgrid of it), so the amounts and the
  // statuses line up from row to row while every column is as wide as its widest
  // entry needs. Three columns where there is room; on a narrow screen the status
  // goes under the name and the amount. In the bell the status is short and takes
  // only the room it needs, so the name keeps the rest.
  return (
    <ul
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 divide-y divide-border text-sm',
        compact
          ? 'sm:grid-cols-[minmax(0,1fr)_auto_auto]'
          : 'sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.2fr)]'
      )}
      data-cy="chargeOutcome"
    >
      {list.map((o, i) => {
        const view = outcomeView(o);
        const who = [unitNameOf(building, o.propertyId), o.tenantName]
          .map((s) => String(s ?? '').trim())
          .filter(Boolean)
          .join(' · ');
        return (
          // A name is never cut: it wraps.
          <li
            key={`${o.propertyId}:${o.tenantId}:${i}`}
            className="col-span-2 grid grid-cols-subgrid items-baseline gap-y-0.5 py-2 sm:col-span-3"
            data-cy="chargeOutcomeRow"
          >
            <span className="min-w-0 break-words">{who || '—'}</span>
            {/* (no figure → «—»: never «NaN €», never a «0,00 €» nobody gave) */}
            <NumberFormat
              value={amountOf(o.amount)}
              showZero
              className="text-right"
            />
            <span className="col-span-2 sm:col-span-1">
              <span
                className={cn(
                  'block',
                  view.charged ? 'text-olive' : 'text-oxide'
                )}
              >
                {view.charged ? '✓ ' : '⚠ '}
                {view.charged
                  ? compact
                    ? termMonthYearNominative(view.term, lang)
                    : t('on the rent of {{month}}', {
                        month: termMonthYearGenitive(view.term, lang)
                      })
                  : t('not charged')}
                {view.otherAmount !== null ? (
                  <>
                    {' ('}
                    <NumberFormat value={view.otherAmount} showZero />
                    {')'}
                  </>
                ) : null}
              </span>
              {!compact && view.why === 'monthPaid' && view.paidTerm ? (
                <span className="block text-xs text-muted-foreground">
                  {t('has paid {{month}} in full', {
                    month: termMonthAccusative(view.paidTerm, lang)
                  })}
                </span>
              ) : null}
              {!compact && view.why === 'leaseEnded' ? (
                <span className="block text-xs text-muted-foreground">
                  {t('the lease has ended')}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
