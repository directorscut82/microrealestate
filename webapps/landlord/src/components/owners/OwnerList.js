import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { Badge } from '../ui/badge';
import { LuHome } from 'react-icons/lu';
import NumberFormat from '../NumberFormat';
import { useRouter } from 'next/router';
import useFormatNumber from '../../hooks/useFormatNumber';
import useTranslation from 'next-translate/useTranslation';

// Owners as a ruled LEDGER TABLE (DESIGN.md primary surface) — replaces the
// prior grid of identical owner cards (banned identical-card-grid) with their
// inline-wrapping money and em-dash '—' zero values. Paid/total share one
// right-aligned mono column with showZero so a zero-paid owner reads '0,00 €',
// not a dash.
export default function OwnerList({ owners = [] }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const formatNumber = useFormatNumber();

  if (!owners.length) return null;

  const open = (key) =>
    router.push(
      `/${router.query.organization}/owners/${encodeURIComponent(key)}`
    );

  return (
    <div className="overflow-x-auto rounded-lg border border-stone-line">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('Owner')}</TableHead>
            <TableHead className="text-right">{t('Units')}</TableHead>
            <TableHead className="text-right">
              {t('Owner expenses paid')}
            </TableHead>
            <TableHead>{t('Status')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {owners.map((owner) => {
            const total = Number(owner.totalAmount) || 0;
            const paid = Number(owner.totalPaid) || 0;
            const outstanding = Number(owner.totalOutstanding) || 0;
            const settled = outstanding <= 0.005;
            const hasExpenses = total > 0.005;
            const showPct =
              Number.isFinite(Number(owner.percentage)) &&
              Number(owner.percentage) < 100;
            return (
              <TableRow
                key={owner.ownerKey}
                className="cursor-pointer"
                data-cy="openResourceButton"
                onClick={() => open(owner.ownerKey)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink truncate">
                      {owner.name || t('Owner')}
                      {showPct && (
                        <span className="ml-1 font-normal text-ink-muted">
                          ({owner.percentage}%)
                        </span>
                      )}
                    </span>
                    {owner.alsoRents && (
                      <Badge variant="neutral" className="font-normal gap-1">
                        <LuHome className="size-3 shrink-0" aria-hidden="true" />
                        {t('Also a tenant')}
                      </Badge>
                    )}
                  </div>
                  {owner.taxId && (
                    <div className="font-mono tabular-nums text-label text-ink-muted">
                      {t('Tax ID')}: {owner.taxId}
                    </div>
                  )}
                </TableCell>
                <TableCell numeric className="text-ink-soft">
                  {owner.unitCount || 0}
                </TableCell>
                <TableCell numeric>
                  {hasExpenses ? (
                    <>
                      <NumberFormat value={paid} showZero />
                      <span className="text-ink-muted">
                        {' / '}
                        <NumberFormat value={total} showZero />
                      </span>
                    </>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {!hasExpenses ? (
                    <Badge
                      data-owner-state="none"
                      variant="neutral"
                      className="font-normal"
                    >
                      {t('No owner expenses')}
                    </Badge>
                  ) : settled ? (
                    <Badge data-owner-state="settled" variant="paid">
                      {t('Settled')}
                    </Badge>
                  ) : (
                    <Badge
                      data-owner-state="outstanding"
                      variant="overdue"
                      className="font-normal"
                    >
                      {t('Outstanding')}: {formatNumber(outstanding)}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
