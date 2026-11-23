import {
  termMonthYearAccusative,
  termMonthYearNominative
} from '../../utils/greekMonths';
import { buildingLabel } from '../../utils/entityLabels';
import ChargeOutcomeList from './ChargeOutcomeList';
import { LuReceipt } from 'react-icons/lu';
import { amountOf, monthClosedForAll } from '../../utils/chargeOutcome';
import NumberFormat from '../NumberFormat';
import { providerLabel } from '../../utils/billExpensePrefill';
import useTranslation from 'next-translate/useTranslation';

/**
 * A bill that was saved, on the result the window stays open on after «Επιβεβαίωση
 * Εισαγωγής»: the file, the month and the amount, where it was recorded — and, when
 * the tenants were charged, where each tenant's share went. The list is the server's
 * answer after it read the tenants' rents back (`chargeOutcome`), not a forecast: a
 * share for a month that is closed for a tenant goes on that tenant's next open rent,
 * and one that reached no rent says so.
 */
export default function ImportedBillCard({ bill, building }) {
  const { t, lang } = useTranslation('common');
  const outcomes = bill.chargeOutcome || [];
  // ('' for a term that names no month: then the month is simply not said)
  const billMonth = termMonthYearAccusative(bill.term, lang);
  const closedMonth = termMonthYearNominative(bill.term, lang);
  // (what is not known is left out, separator and all)
  const headline = [providerLabel(bill.provider) || bill.provider, billMonth]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  const target = [bill.expenseName, buildingLabel(building)]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className="rounded-lg border border-border overflow-hidden"
      data-cy="importedBill"
    >
      <div className="flex items-start gap-3 border-b border-border bg-muted/20 px-4 py-3">
        <LuReceipt className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={bill.filename}>
            {bill.filename}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {headline.map((part) => `${part} · `).join('')}
            <NumberFormat value={amountOf(bill.amount)} showZero />
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {target && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="text-muted-foreground">{t('Expense')}</span>
            <span className="font-medium">{target}</span>
          </div>
        )}

        {bill.chargeRequested && (bill.chargeError || outcomes.length > 0) && (
          <div data-cy="importedBillCharge">
            <div className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted">
              {t('Charged to tenants')}
            </div>
            {bill.chargeError ? (
              // The bill is saved and the charge failed. A message says what to do
              // about it — not when another bill of the batch could not be saved:
              // that message takes its place (DEFERRED_DECISIONS D-10, «Still open»).
              // Here, under the bill it concerns, only what is true.
              <div className="text-sm text-oxide">⚠ {t('not charged')}</div>
            ) : (
              <>
                {closedMonth && monthClosedForAll(outcomes) ? (
                  <p className="mb-1 text-pretty text-xs text-muted-foreground">
                    {t(
                      "{{month}} is closed for the tenants. Each tenant's share went on their next open rent.",
                      { month: closedMonth }
                    )}
                  </p>
                ) : null}
                <ChargeOutcomeList outcomes={outcomes} building={building} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
