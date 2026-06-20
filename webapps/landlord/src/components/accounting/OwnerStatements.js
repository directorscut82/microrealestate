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
  const monthName = months[month][0].toUpperCase() + months[month].slice(1);

  return (
    <div className={cn('grid grid-cols-6 border-b first:border-t')}>
      <div className="text-muted-foreground md:text-lg border-l border-r col-span-2 md:col-span-1 px-4 py-2">
        {monthName}
      </div>
      <div
        className={cn(
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
                    {s.description || t(s.type || 'expense')}
                  </div>
                  <NumberFormat value={s.amount} withColor className="text-lg" />
                </div>
              ) : null;
            })
          : null}
      </div>
      <div className="col-span-2 px-4 py-2 border-r text-xs text-muted-foreground">
        {hasSettlements && settlements.some((s) => s.owed > 0) && (
          <div className="leading-snug">
            <span className="font-medium uppercase tracking-wide text-[10px] text-muted-foreground/80 mr-1">
              {t('Owed')}
            </span>
            <NumberFormat
              value={settlements.reduce((sum, s) => sum + (s.owed || 0), 0)}
              className="text-xs"
            />
          </div>
        )}
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
