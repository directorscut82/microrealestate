import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import { EmptyIllustration } from '../Illustrations';
import { GrDocumentCsv } from 'react-icons/gr';
import { LuPaperclip } from 'react-icons/lu';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { useState } from 'react';
import useTranslation from 'next-translate/useTranslation';

const months = moment.localeData().months();

// Q4 multi-month batch: per-month receipt picker. The popover renders a
// 12-month checkbox grid plus an "All year" shortcut and a "Download N
// receipts" submit button. On submit, the selected months are
// concatenated into a comma-separated 10-digit term string
// (e.g. "2026010100,2026020100,2026030100") and passed to onPick which
// downloads a single multi-section PDF — the EJS template at
// services/pdfgenerator/templates/invoice.ejs already iterates
// `tenant.rents.forEach(...)` so a 3-month selection produces a stitched
// 3-page receipt PDF without any template edits.
function ReceiptMonthPicker({ onPick, t }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState([]);
  const localeMonths = moment.localeData().months();

  const toggleMonth = (month) => {
    setSelected((prev) =>
      prev.includes(month)
        ? prev.filter((m) => m !== month)
        : [...prev, month]
    );
  };

  const allYear = () => {
    const allSelected = selected.length === 12;
    setSelected(allSelected ? [] : Array.from({ length: 12 }, (_, i) => i + 1));
  };

  const submit = () => {
    if (!selected.length) return;
    const sorted = [...selected].sort((a, b) => a - b);
    onPick(sorted);
    setOpen(false);
    setSelected([]);
  };

  // When the popover closes without a submit, reset the selection so
  // the next open starts clean. Without this the user would re-open
  // and find their abandoned selections still ticked.
  const handleOpenChange = (next) => {
    setOpen(next);
    if (!next) setSelected([]);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal>
      <PopoverTrigger asChild>
        <Button variant="secondary" className="flex items-center gap-1">
          <LuPaperclip /> {t('Receipt')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="end">
        <div className="text-xs text-muted-foreground px-2 py-1 mb-1">
          {t('Select months')}
        </div>
        <div className="grid grid-cols-3 gap-1">
          {localeMonths.map((monthName, idx) => {
            const month = idx + 1;
            const isSelected = selected.includes(month);
            return (
              <label
                key={month}
                className={cn(
                  'flex items-center gap-1 text-xs h-8 px-2 rounded cursor-pointer border',
                  isSelected
                    ? 'bg-primary/10 border-primary'
                    : 'border-transparent hover:bg-accent'
                )}
              >
                <input
                  type="checkbox"
                  className="size-3"
                  checked={isSelected}
                  onChange={() => toggleMonth(month)}
                />
                <span>{monthName.slice(0, 3)}</span>
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            onClick={allYear}
          >
            {t('All year')}
          </Button>
          <Button
            variant="default"
            size="sm"
            className="text-xs h-7"
            disabled={!selected.length}
            onClick={submit}
          >
            {t('Download {{count}} receipts', { count: selected.length })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SettlementList({ month, tenantId, settlements, notes }) {
  const { t } = useTranslation('common');

  const hasSettlements = !!settlements?.length;
  const monthName = months[month][0].toUpperCase() + months[month].slice(1);
  // Wave-26 (5): rent-level notes for this month — rent.description (private),
  // notepromo (printed on receipts as discount reason), noteextracharge
  // (printed as extra-charge reason). Concatenated into a single readable
  // block. Each line prefixed with its kind so the landlord knows what's
  // landlord-only vs tenant-facing.
  const noteLines = [];
  if (notes?.description) {
    noteLines.push({ kind: t('Note'), text: notes.description });
  }
  if (notes?.notepromo) {
    noteLines.push({ kind: t('Discount'), text: notes.notepromo });
  }
  if (notes?.noteextracharge) {
    noteLines.push({ kind: t('Extra charge'), text: notes.noteextracharge });
  }
  return (
    <div className={cn('grid grid-cols-6 border-b first:border-t')}>
      <div className="text-muted-foreground md:text-lg border-l border-r col-span-2 md:col-span-1 px-4 py-2">
        {monthName}
      </div>
      <div
        className={cn(
          // Multi-payment cell: when 2+ payments are recorded for the
          // same month, the previous flex-row layout overflowed the
          // 3-of-6-cols width because each payment used text-2xl with
          // no min-width and no wrap. Switching to flex-wrap with a
          // min-width per payment lets multiple payments wrap onto a
          // second/third line within the cell instead of spilling.
          'flex flex-wrap gap-x-6 gap-y-2 items-center justify-end col-span-2 md:col-span-3 px-4 py-2 border-r',
          !hasSettlements ? 'bg-muted' : ''
        )}
      >
        {hasSettlements
          ? settlements.map((settlement, index) => {
              const { date, amount, type } = settlement;
              return amount > 0 ? (
                <div
                  key={`${tenantId}_${month}_${index}`}
                  className="text-right min-w-[8rem] flex-shrink-0"
                >
                  <div className="text-xs text-muted-foreground">
                    {moment(date).format('L')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t(type[0].toUpperCase() + type.slice(1))}
                  </div>
                  <NumberFormat value={amount} withColor className="text-lg" />
                </div>
              ) : null;
            })
          : null}
      </div>
      <div className="col-span-2 px-4 py-2 border-r text-xs text-muted-foreground space-y-1">
        {noteLines.length > 0 ? (
          noteLines.map((n, i) => (
            <div key={i} className="leading-snug">
              <span className="font-medium uppercase tracking-wide text-[10px] text-muted-foreground/80 mr-1">
                {n.kind}
              </span>
              <span>{n.text}</span>
            </div>
          ))
        ) : null}
      </div>
    </div>
  );
}

export default function TenantSettlements({
  data,
  onCSVClick,
  onDownloadYearInvoices
}) {
  const { t } = useTranslation('common');
  const hasData = !!data?.length;
  return hasData ? (
    <Card>
      <CardHeader>
        <CardTitle className="flex justify-between items-center text-lg md:text-xl">
          {t('Payments')}
          <Button variant="ghost" size="icon" onClick={onCSVClick} aria-label={t('Download CSV')}>
            <GrDocumentCsv className="size-6" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.map((settlement) => (
          <div
            key={settlement.tenantId}
            className="border-b first:border-t last:border-none py-4"
          >
            <div className="flex justify-between text-xl px-2">
              <div>{settlement.tenant}</div>
              {/* Wave-26 round-3u: per-month receipt picker. Opens a
                  popover dropdown with one button per month of the
                  current accounting year; clicking a month downloads
                  a single-page receipt for that term. */}
              <ReceiptMonthPicker
                onPick={onDownloadYearInvoices({
                  _id: settlement.tenantId,
                  name: settlement.tenant
                })}
                t={t}
              />
            </div>
            <div className="text-muted-foreground mb-2">
              {moment(settlement.beginDate).format('L')} -{' '}
              {moment(settlement.endDate).format('L')}
            </div>
            <div>
              {months.map((_m, index) => {
                return (
                  <SettlementList
                    key={`${settlement.tenantId}_${index}`}
                    tenantId={settlement.tenantId}
                    month={index}
                    settlements={settlement.settlements[index]}
                    notes={settlement.notesByMonth?.[index]}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
      )
    </Card>
  ) : (
    <EmptyIllustration />
  );
}
