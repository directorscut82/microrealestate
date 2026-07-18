import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import Link from 'next/link';
import { LuFileWarning } from 'react-icons/lu';
import moment from 'moment';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/**
 * ExpiringEnergyCertsTile — properties whose energy certificate (ΠΕΑ,
 * issue + 5 years) expires within the next 60 days. Fed by the dashboard
 * endpoint's `expiries.energyCertificates` block (computed live server-side,
 * same windows as the daily Telegram scanner). Sibling of ExpiringLeasesTile:
 * same Card/Table primitives, same urgency accent, renders nothing while
 * empty except the reassurance line.
 */
export default function ExpiringEnergyCertsTile({ dashboardData, className }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const organization = router.query?.organization;

  const rows = dashboardData?.expiries?.energyCertificates || [];

  return (
    <Card className={cn('', className)}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <CardTitle className="font-sans text-title font-semibold flex items-center gap-2 text-ink">
              <LuFileWarning className="size-4 text-ink-muted" />
              {t('Expiring energy certificates')}
            </CardTitle>
            <CardDescription>
              {t(
                'Properties whose energy certificate (issue + 5 years) expires within the next {{n}} days',
                { n: 60 }
              )}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-ink-muted text-sm py-4 px-1">
            {t('No energy certificates expiring in the next {{n}} days', {
              n: 60
            })}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Property')}</TableHead>
                <TableHead numeric>{t('Issued')}</TableHead>
                <TableHead numeric>{t('Expires')}</TableHead>
                <TableHead numeric>{t('Remaining')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.propertyId}>
                  <TableCell>
                    <div className="text-ink font-medium">{row.name}</div>
                  </TableCell>
                  <TableCell numeric>
                    <span className="font-mono tabular-nums text-ink-muted">
                      {moment.utc(row.issueDate).format('DD/MM/YY')}
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <span className="font-mono tabular-nums text-ink">
                      {moment.utc(row.expiresAt).format('DD/MM/YY')}
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <span
                      className={cn(
                        'font-mono tabular-nums',
                        row.daysLeft <= 14
                          ? 'text-oxide font-semibold'
                          : 'text-ink'
                      )}
                    >
                      {t('in {{n}} days', { n: row.daysLeft })}
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    {organization ? (
                      <Link
                        href={`/${organization}/properties/${row.propertyId}`}
                        passHref
                        legacyBehavior
                      >
                        <Button asChild size="sm" variant="secondary">
                          <a>{t('Open property')}</a>
                        </Button>
                      </Link>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
