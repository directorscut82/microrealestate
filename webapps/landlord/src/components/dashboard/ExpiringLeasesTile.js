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
import { fetchTenants, QueryKeys } from '../../utils/restcalls';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import Link from 'next/link';
import { LuCalendarClock } from 'react-icons/lu';
import moment from 'moment';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const HORIZON_DAYS = 60;

/**
 * ExpiringLeasesTile — surfaces tenants whose lease ends within the next
 * 60 days. Shares the same Card / Table primitives as PendingBills so the
 * two tiles stack visually as siblings on the dashboard grid.
 *
 * Sort: ascending by endDate so the most urgent expiry is at the top.
 * Empty state: localized "no leases expiring..." copy (does not render
 * the card chrome — keeps the dashboard tidy when there's nothing due).
 */
export default function ExpiringLeasesTile({ className }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const organization = router.query?.organization;

  const { data, isLoading } = useQuery({
    queryKey: [QueryKeys.TENANTS, 'expiring-leases', HORIZON_DAYS],
    queryFn: () => fetchTenants({ expiringWithin: HORIZON_DAYS }),
    refetchOnMount: 'always',
    retry: 3
  });

  const rows = useMemo(() => {
    const tenants = Array.isArray(data) ? data : [];
    const today = moment.utc().startOf('day');
    return tenants
      .filter((tn) => tn?.endDate && !tn.terminationDate && !tn.archived)
      .map((tn) => {
        // The API returns endDate as a DD/MM/YYYY string (frontdata transform).
        // moment.utc(string) without a format hint tries ISO 8601 first, then
        // falls back to Date.parse which CANNOT parse "14/06/2026" — the
        // resulting moment is Invalid and `days` becomes NaN, so the
        // `days >= 0 && days <= HORIZON_DAYS` filter drops every row.
        // Parse explicitly with the DD/MM/YYYY format.
        const end = moment.utc(tn.endDate, 'DD/MM/YYYY', true);
        const days = end.isValid()
          ? end.startOf('day').diff(today, 'days')
          : NaN;
        const propertyName =
          tn.properties?.[0]?.property?.name ||
          tn.properties?.[0]?.propertyName ||
          '';
        return {
          _id: tn._id,
          name: tn.name,
          propertyName,
          endDate: tn.endDate,
          days
        };
      })
      .filter((row) => row.days >= 0 && row.days <= HORIZON_DAYS)
      .sort((a, b) =>
        moment.utc(a.endDate, 'DD/MM/YYYY', true).diff(
          moment.utc(b.endDate, 'DD/MM/YYYY', true)
        )
      );
  }, [data]);

  if (isLoading) return null;

  return (
    <Card className={cn('', className)}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <CardTitle className="font-sans text-title font-semibold flex items-center gap-2 text-ink">
              <LuCalendarClock className="size-4 text-ink-muted" />
              {t('Expiring leases')}
            </CardTitle>
            <CardDescription>
              {t('Lease expires on {{date}}', {
                date: moment().add(HORIZON_DAYS, 'days').format('DD/MM/YYYY')
              })}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-ink-muted text-sm py-4 px-1">
            {t('No leases expiring in the next {{n}} days', {
              n: HORIZON_DAYS
            })}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Tenant')}</TableHead>
                <TableHead>{t('Property')}</TableHead>
                <TableHead numeric>{t('End date')}</TableHead>
                <TableHead numeric>{t('Remaining')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row._id}>
                  <TableCell>
                    <div className="text-ink font-medium">{row.name}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-ink-muted">{row.propertyName}</div>
                  </TableCell>
                  <TableCell numeric>
                    <span className="font-mono tabular-nums text-ink">
                      {/* row.endDate is the same DD/MM/YYYY string the
                          parent filter parses — re-format to short
                          DD/MM/YY here. moment(str) without a format hint
                          returns Invalid Date for non-ISO inputs. */}
                      {moment.utc(row.endDate, 'DD/MM/YYYY', true).format('DD/MM/YY')}
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <span
                      className={cn(
                        'font-mono tabular-nums',
                        row.days <= 7 ? 'text-oxide font-semibold' : 'text-ink'
                      )}
                    >
                      {t('in {{n}} days', { n: row.days })}
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    {organization ? (
                      <Link
                        href={`/${organization}/tenants/${row._id}?action=renew`}
                        passHref
                        legacyBehavior
                      >
                        <Button asChild size="sm" variant="secondary">
                          <a>{t('Renew lease')}</a>
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
