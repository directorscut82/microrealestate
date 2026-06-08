import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from '../ui/card';
import { useCallback, useMemo } from 'react';
import _ from 'lodash';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import moment from 'moment';
import { Progress } from '../ui/progress';
import TenantAvatar from './TenantAvatar';
import TenantPropertyList from './TenantPropertyList';
import TenantStatus from './TenantStatus';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

export default function TenantListItem({ tenant }) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const handleClick = useCallback(async () => {
    await router.push(
      `/${router.query.organization}/tenants/${tenant._id}`
    );
  }, [router, tenant]);

  // compute progress of duration of lease
  const progress = useMemo(() => {
    if (tenant.beginDate) {
      const startDate = moment(tenant.beginDate, 'DD/MM/YYYY');
      const endDate = moment(
        tenant.terminationDate || tenant.endDate,
        'DD/MM/YYYY'
      );
      const duration = endDate.diff(startDate, 'days');
      const elapsed = moment().diff(startDate, 'days');
      return Math.round((elapsed / duration) * 100);
    }
    return 0;
  }, [tenant.beginDate, tenant.endDate, tenant.terminationDate]);

  // Tier B8 — 3-state lease pill: terminated / future-start / running.
  // Previously a 2-state predicate ("Lease ended" vs "Lease running")
  // contradicted the no-property warning when the tenant had a future
  // beginDate but no termination. Compute the state once here and use a
  // single attribute hook for tests (data-lease-state).
  const leaseState = useMemo(() => {
    if (tenant.terminated) return 'terminated';
    if (tenant.beginDate) {
      const begin = moment(tenant.beginDate, 'DD/MM/YYYY').startOf('day');
      if (begin.isAfter(moment().startOf('day'))) return 'future';
    }
    return 'running';
  }, [tenant.terminated, tenant.beginDate]);

  // Tier B7 — alignment: make the Card a flex column with CardContent
  // expanding to fill available space, so cards on the same row line up
  // regardless of whether they show the property list or the missing-info
  // warning.
  return (
    <Card className="relative flex flex-col h-full">
      <TenantStatus tenant={tenant} className="absolute top-0.5 right-0.5" />
      <CardHeader className="mb-4 cursor-pointer" onClick={handleClick}>
        <CardTitle className="flex justify-start items-center gap-2">
          <TenantAvatar tenant={tenant} />
          <div>
            <Button
              variant="link"
              className="w-fit h-fit p-0 text-title font-medium whitespace-normal"
              data-cy="openResourceButton"
            >
              {tenant.name}
            </Button>
            {tenant.archived && (
              <Badge variant="secondary" className="ml-1 text-label">{t('Archived')}</Badge>
            )}
            <div className="text-label font-normal text-ink-muted">
              {tenant.isCompany
                ? _.startCase(_.capitalize(tenant.manager))
                : null}
            </div>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground pb-0 flex-1">
        <div className="cursor-pointer" onClick={handleClick}>
          <div>
            {tenant.beginDate
              ? tenant.lease?.name || t('custom')
              : t('No associated contract')}
          </div>
          <Progress
            value={progress}
            className={cn('h-2 my-2 bg-secondary')}
            indicatorClassName={
              tenant.terminated ? 'bg-muted-foreground/30' : 'bg-success'
            }
          />
          <div className="text-xs">
            {tenant.beginDate
              ? t('From {{startDate}} to {{endDate}}', {
                  startDate: moment(tenant.beginDate, 'DD/MM/YYYY').format('L'),
                  endDate: moment(
                    tenant.terminationDate || tenant.endDate,
                    'DD/MM/YYYY'
                  ).format('L')
                })
              : null}
          </div>
        </div>
        <TenantPropertyList tenant={tenant} className="mt-2" />
      </CardContent>

      <CardFooter className="p-0 flex-col mt-auto">
        <div className="flex items-center justify-end w-full py-3 px-5">
          <Badge
            data-lease-state={leaseState}
            variant={
              leaseState === 'terminated'
                ? 'secondary'
                : leaseState === 'future'
                  ? 'outline'
                  : 'success'
            }
            className="font-normal text-label leading-none"
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-pill shrink-0',
                leaseState === 'terminated' && 'bg-ink-muted',
                leaseState === 'future' && 'bg-amber-500',
                leaseState === 'running' && 'bg-olive'
              )}
            />
            {leaseState === 'terminated' && t('Lease ended')}
            {leaseState === 'future' && t('Lease starts in the future')}
            {leaseState === 'running' && t('Lease running')}
          </Badge>
        </div>
      </CardFooter>
    </Card>
  );
}
