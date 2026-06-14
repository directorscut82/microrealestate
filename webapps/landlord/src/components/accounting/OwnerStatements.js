import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import { EmptyIllustration } from '../Illustrations';
import { LuPaperclip } from 'react-icons/lu';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { useState } from 'react';
import useTranslation from 'next-translate/useTranslation';

// Per-month statement picker for an owner — mirrors the tenant
// ReceiptMonthPicker. The selected months become a comma-separated
// YYYYMMDDHH term string passed to onPick, which downloads a single
// multi-section owner statement PDF (owner_statement.ejs iterates the
// sections exactly like the tenant receipt iterates rents).
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

// Τιμολόγια → Ιδιοκτήτες sub-tab. Lists every owner with name + ΑΦΜ + paid/
// outstanding and a per-owner statement (εκκαθαριστικό) download — the owner
// counterpart to the tenant receipts tab. `onDownloadStatement(owner)` returns
// a (months[]) => void that downloads the owner_statement PDF for those terms.
export default function OwnerStatements({ data, onDownloadStatement }) {
  const { t } = useTranslation('common');
  const hasData = !!data?.length;
  return hasData ? (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg md:text-xl">{t('Owners')}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.map((owner) => {
          const total = Number(owner.totalAmount) || 0;
          const paid = Number(owner.totalPaid) || 0;
          const outstanding = Number(owner.totalOutstanding) || 0;
          return (
            <div
              key={owner.ownerKey}
              className="border-b first:border-t last:border-none py-4"
            >
              <div className="flex justify-between items-start gap-3 px-2">
                <div className="min-w-0">
                  <div className="text-xl truncate">
                    {owner.name || t('Owner')}
                    {Number.isFinite(Number(owner.percentage)) &&
                      Number(owner.percentage) < 100 && (
                        <span className="ml-1 text-base text-muted-foreground">
                          ({owner.percentage}%)
                        </span>
                      )}
                  </div>
                  {owner.taxId ? (
                    <div className="text-sm text-muted-foreground">
                      {t('Tax ID')}: {owner.taxId}
                    </div>
                  ) : null}
                  <div className="text-sm text-muted-foreground mt-1">
                    {t('{{count}} units', { count: owner.unitCount || 0 })} ·{' '}
                    {total > 0.005 ? (
                      <>
                        <span className="text-olive">
                          {t('Paid')}: <NumberFormat value={paid} />
                        </span>
                        {' · '}
                        <span className={outstanding > 0.005 ? 'text-oxide' : ''}>
                          {t('Outstanding')}:{' '}
                          <NumberFormat value={outstanding} />
                        </span>
                      </>
                    ) : (
                      <span>{t('No owner expenses')}</span>
                    )}
                  </div>
                </div>
                {total > 0.005 ? (
                  <StatementMonthPicker
                    onPick={onDownloadStatement(owner)}
                    t={t}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  ) : (
    <EmptyIllustration />
  );
}
