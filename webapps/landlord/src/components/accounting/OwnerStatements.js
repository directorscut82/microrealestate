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

function StatementMonthPicker({ onPick, t }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState([]);
  const localeMonths = moment.localeData().months();

  const toggleMonth = (month) =>
    setSelected((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month]
    );
  const allYear = () =>
    setSelected(
      selected.length === 12 ? [] : Array.from({ length: 12 }, (_, i) => i + 1)
    );
  const submit = () => {
    if (!selected.length) return;
    onPick([...selected].sort((a, b) => a - b));
    setOpen(false);
    setSelected([]);
  };
  const handleOpenChange = (next) => {
    setOpen(next);
    if (!next) setSelected([]);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal>
      <PopoverTrigger asChild>
        <Button variant="secondary" className="flex items-center gap-1">
          {/* OS7: this downloads a STATEMENT (εκκαθαριστικό), not a receipt.
              The tenant tab correctly uses 'Receipt'/Απόδειξη for receipts. */}
          <LuPaperclip /> {t('Statement')}
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
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={allYear}>
            {t('All year')}
          </Button>
          <Button
            variant="default"
            size="sm"
            className="text-xs h-7"
            disabled={!selected.length}
            onClick={submit}
          >
            {t('Download {{count}} statements', { count: selected.length })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SettlementRow({ month, ownerKey, settlements }) {
  const { t } = useTranslation('common');
  const hasSettlements = !!settlements?.length;
  // Derive the month name at RENDER from moment (locale set by _app), NOT the
  // module-level `months` array captured at import before the locale was set —
  // that rendered every month in the wrong language (Spanish: Enero/Febrero…).
  const rawMonth = moment().month(month).format('MMMM');
  const monthName = rawMonth.charAt(0).toUpperCase() + rawMonth.slice(1);

  return (
    <div className={cn('grid grid-cols-6 border-b first:border-t')}>
      <div className="text-muted-foreground md:text-lg border-l border-r col-span-2 md:col-span-1 px-4 py-2">
        {monthName}
      </div>
      <div
        className={cn(
          // MIDDLE = the money column (mirrors TenantSettlements): each
          // καταβολή's date + payment type + amount. OS1/OS2: was empty / showed
          // charge metadata; now shows recorded payments.
          'flex flex-wrap gap-x-6 gap-y-2 items-center justify-end col-span-2 md:col-span-3 px-4 py-2 border-r',
          !hasSettlements ? 'bg-muted' : ''
        )}
      >
        {hasSettlements
          ? settlements.map((s, index) => {
              return s.amount > 0 ? (
                <div
                  key={`${ownerKey}_${month}_${index}`}
                  className="text-right min-w-[8rem] flex-shrink-0"
                >
                  {s.date && (
                    <div className="text-xs text-muted-foreground">
                      {moment(s.date).format('L')}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {/* payment TYPE (Μεταφορά/Μετρητά/Επιταγή), like the tenant
                        grid — guard a legacy/empty type (H7 class). */}
                    {s.type ? t(s.type[0].toUpperCase() + s.type.slice(1)) : ''}
                  </div>
                  <NumberFormat value={s.amount} withColor className="text-lg" />
                </div>
              ) : null;
            })
          : null}
      </div>
      <div className="col-span-2 px-4 py-2 border-r text-xs text-muted-foreground space-y-1">
        {/* RIGHT = notes recorded during the καταβολή (mirrors the tenant grid's
            notes column). OS1: owed was wrongly rendered here; owed now lives in
            the header total only. */}
        {hasSettlements
          ? settlements
              .filter((s) => s.amount > 0 && s.description)
              .map((s, index) => (
                <div key={`${ownerKey}_${month}_note_${index}`} className="leading-snug">
                  {s.description}
                </div>
              ))
          : null}
      </div>
    </div>
  );
}

export default function OwnerStatements({ data, onDownloadStatement, onCSVClick }) {
  const { t } = useTranslation('common');
  const hasData = !!data?.length;
  return hasData ? (
    <Card>
      <CardHeader>
        <CardTitle className="flex justify-between items-center text-lg md:text-xl">
          {t('Payments')}
          {onCSVClick && (
            <Button variant="ghost" size="icon" onClick={onCSVClick} aria-label={t('Download CSV')}>
              <GrDocumentCsv className="size-6" />
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.map((owner) => (
          <div
            key={owner.ownerKey}
            className="border-b first:border-t last:border-none py-4"
          >
            <div className="flex justify-between text-xl px-2">
              <div>{owner.name || t('Owner')}</div>
              <StatementMonthPicker
                onPick={onDownloadStatement(owner)}
                t={t}
              />
            </div>
            {/* OS5/OS6: a second header line so the owner block matches the
                tenant block's height (tenant shows the lease date range). Owners
                have no lease range → show units/buildings + ΑΦΜ instead, so the
                two tabs line up row-for-row. */}
            <div className="text-muted-foreground mb-2 px-2 text-sm">
              {[
                owner.unitCount != null
                  ? t('{{count}} units', { count: owner.unitCount })
                  : null,
                owner.buildingCount != null
                  ? t('{{count}} buildings', { count: owner.buildingCount })
                  : null,
                owner.taxId ? `${t('Tax ID')}: ${owner.taxId}` : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <div>
              {months.map((_m, index) => (
                <SettlementRow
                  key={`${owner.ownerKey}_${index}`}
                  ownerKey={owner.ownerKey}
                  month={index}
                  settlements={owner.settlements?.[index]}
                />
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  ) : (
    <EmptyIllustration />
  );
}
