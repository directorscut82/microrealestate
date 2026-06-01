import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import { EmptyIllustration } from '../Illustrations';
import { GrDocumentCsv } from 'react-icons/gr';
import { LuPaperclip } from 'react-icons/lu';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import useTranslation from 'next-translate/useTranslation';

const months = moment.localeData().months();

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
              <Button
                variant="secondary"
                className="flex items-center gap-1"
                onClick={onDownloadYearInvoices({
                  _id: settlement.tenantId,
                  name: settlement.tenant
                })}
              >
                <LuPaperclip /> {t('Invoices')}
              </Button>
            </div>
            <div className="text-muted-foreground mb-2">
              {moment(settlement.beginDate).format('L')} -{' '}
              {moment(settlement.endDate).format('L')}
            </div>
            <div>
              {months.map((m, index) => {
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
