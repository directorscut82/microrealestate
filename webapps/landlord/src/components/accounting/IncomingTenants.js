import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import { EmptyIllustration } from '../Illustrations';
import { GrDocumentCsv } from 'react-icons/gr';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import PropertyIcon from '../properties/PropertyIcon';
import useTranslation from 'next-translate/useTranslation';

export default function IncomingTenants({ data, onCSVClick }) {
  const { t } = useTranslation('common');
  const hasData = !!data?.length;

  return hasData ? (
    <Card>
      {/* No duplicate card title: the active tab already reads
          "Εισερχόμενοι ενοικιαστές (N)". Keep only the CSV-export affordance,
          right-aligned. */}
      <CardHeader className="pb-2">
        <CardTitle className="flex justify-end items-center">
          <Button variant="ghost" size="icon" onClick={onCSVClick} aria-label={t('Download CSV')}>
            <GrDocumentCsv className="size-6" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {data.map((tenant) => (
          <div
            key={tenant._id}
            className={cn(
              'flex flex-col gap-2 md:flex-row md:justify-between',
              'border-b first:border-t last:border-none py-2'
            )}
          >
            <div className="min-w-0">
              {/* The tenant NAME is the row title and must dominate; the
                  deposit (often 0,00 €) must not out-size it. */}
              <div className="text-title font-medium text-ink">
                {tenant.name}
              </div>
              <div className="text-sm text-muted-foreground">
                {moment(tenant.beginDate).format('L')}
                {/* _incomingTenants intentionally omits endDate; moment(undefined)
                    rendered TODAY (advancing daily) as a fabricated contract-end
                    (round-2 audit M4). Only render the end side when present —
                    matching the CSV which omits the column. */}
                {tenant.endDate
                  ? ` ${t('to')} ${moment(tenant.endDate).format('L')}`
                  : ''}
              </div>
              <div className="flex items-center flex-wrap gap-2 mt-1.5">
                {tenant.properties.map((property) => (
                  <div
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                    key={property._id}
                  >
                    <PropertyIcon type={property.type} />
                    <span>{property.name}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="shrink-0">
              <div className="text-muted-foreground text-xs md:text-right">
                {t('Deposit')}
              </div>
              {/* Demoted from text-2xl: a deposit (frequently 0,00 €) must not
                  be the most dominant element on the row. Zero renders as a
                  muted '—' rather than five identical loud zeros. */}
              {Number(tenant.guaranty) > 0 ? (
                <NumberFormat
                  value={tenant.guaranty}
                  className="font-mono tabular-nums text-headline md:text-right"
                />
              ) : (
                <div className="text-ink-muted md:text-right">—</div>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  ) : (
    <EmptyIllustration />
  );
}
