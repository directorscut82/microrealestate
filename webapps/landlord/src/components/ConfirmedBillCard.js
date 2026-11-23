import { Button } from './ui/button';
import ChargeOutcomeList from './buildings/ChargeOutcomeList';
import { providerLabel } from '../utils/billExpensePrefill';
import useTranslation from 'next-translate/useTranslation';

/*
 * ConfirmedBillCard — what a bill card turns into after «Καταχώρηση», until «Εντάξει».
 *
 * The list is the server's answer after it read the tenants' rents back (the same
 * `chargeOutcome` the upload window shows): a share for a month that is closed for a
 * tenant is on that tenant's next open rent, and one that reached no rent says so.
 * The bell keeps the entry (InboxBell `confirmed`): the item itself leaves the
 * pending list when its confirm answers.
 */
export default function ConfirmedBillCard({ entry, onOk }) {
  const { t } = useTranslation('common');
  return (
    <div
      className="p-4 space-y-3 border-b last:border-b-0"
      data-cy="inboxConfirmedCard"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold uppercase">
          {providerLabel(entry.provider) || entry.provider || t('Bill')}
        </span>
        <span className="text-[11px] border rounded px-1.5 text-muted-foreground">
          Telegram
        </span>
        <span className="text-xs text-olive">✓ {t('Recorded')}</span>
      </div>
      {entry.chargeError ? (
        <div className="text-xs rounded-md bg-destructive/5 border border-destructive/30 p-2 text-destructive">
          {t(
            'Bills saved. {{failed}} could not charge tenants — charge them from the building statement.',
            { failed: 1 }
          )}
        </div>
      ) : (
        <ChargeOutcomeList
          outcomes={entry.chargeOutcome}
          building={entry.building}
          compact
        />
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={onOk} data-cy="inboxConfirmedOk">
          {t('Ok')}
        </Button>
      </div>
    </div>
  );
}
