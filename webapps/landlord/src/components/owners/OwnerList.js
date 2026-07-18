import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { LuHome, LuMail, LuPhone } from 'react-icons/lu';
import { Badge } from '../ui/badge';
import { Checkbox } from '../ui/checkbox';
import NumberFormat from '../NumberFormat';
import { useRouter } from 'next/router';
import useFormatNumber from '../../hooks/useFormatNumber';
import useTranslation from 'next-translate/useTranslation';

// Owners as a ruled LEDGER TABLE (DESIGN.md primary surface) — replaces the
// prior grid of identical owner cards (banned identical-card-grid) with their
// inline-wrapping money and em-dash '—' zero values. Paid/total share one
// right-aligned mono column with showZero so a zero-paid owner reads '0,00 €',
// not a dash.
//
// Selection (optional): when `selected`/`setSelected` are provided a leading
// checkbox column appears for the notification batch-send. Only owners with
// an email or phone are selectable; ΛΟΙΠΟΙ placeholders (loipoi: keys) never
// are — they have no identity to notify.
export default function OwnerList({ owners = [], selected, setSelected }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const formatNumber = useFormatNumber();

  if (!owners.length) return null;

  const selectable = !!setSelected;
  const isSelectable = (o) =>
    !String(o.ownerKey || '').startsWith('loipoi:') && (o.hasEmail || o.hasPhone);

  const toggle = (owner) => (checked) => {
    if (!setSelected) return;
    setSelected((prev) =>
      checked
        ? [...prev, owner.ownerKey]
        : prev.filter((k) => k !== owner.ownerKey)
    );
  };

  const open = (key) =>
    router.push(
      `/${router.query.organization}/owners/${encodeURIComponent(key)}`
    );

  return (
    <div className="overflow-x-auto rounded-lg border border-stone-line">
      <Table>
        <TableHeader>
          <TableRow>
            {selectable && <TableHead className="w-8" />}
            <TableHead>{t('Owner')}</TableHead>
            <TableHead>{t('Contact')}</TableHead>
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
                {selectable && (
                  <TableCell
                    className="w-8"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={(selected || []).includes(owner.ownerKey)}
                      disabled={!isSelectable(owner)}
                      onCheckedChange={toggle(owner)}
                      aria-labelledby={owner.name}
                    />
                  </TableCell>
                )}
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
                <TableCell>
                  {owner.phone || owner.email ? (
                    <div className="space-y-0.5 text-label text-ink-soft">
                      {owner.phone && (
                        <div className="flex items-center gap-1.5">
                          <LuPhone
                            className="size-3 shrink-0 text-ink-muted"
                            aria-hidden="true"
                          />
                          <span className="font-mono tabular-nums">
                            {owner.phone}
                          </span>
                        </div>
                      )}
                      {owner.email && (
                        <div className="flex items-center gap-1.5">
                          <LuMail
                            className="size-3 shrink-0 text-ink-muted"
                            aria-hidden="true"
                          />
                          <span className="truncate max-w-52">
                            {owner.email}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-label text-ink-muted">
                      {String(owner.ownerKey || '').startsWith('loipoi:')
                        ? '—'
                        : t('No contact info')}
                    </span>
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
                  {/* State pills carry a leading glyph, not color alone, so
                      they read for color-blind users and match the card
                      variant (OwnerListItem.js). */}
                  {!hasExpenses ? (
                    <Badge
                      data-owner-state="none"
                      variant="outline"
                      className="font-normal text-ink-muted border-stone-line gap-1.5"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-pill shrink-0 bg-ink-muted/40"
                      />
                      {t('No owner expenses')}
                    </Badge>
                  ) : settled ? (
                    <Badge
                      data-owner-state="settled"
                      variant="paid"
                      className="gap-1.5"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-pill shrink-0 bg-olive"
                      />
                      {t('Settled')}
                    </Badge>
                  ) : (
                    <Badge
                      data-owner-state="outstanding"
                      variant="overdue"
                      className="font-normal gap-1.5"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-pill shrink-0 bg-oxide"
                      />
                      {t('Outstanding')}:{' '}
                      <span className="font-mono tabular-nums">
                        {formatNumber(outstanding)}
                      </span>
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
