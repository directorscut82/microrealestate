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

  // Required-field gap detector: surface what the server-side Tier A1
  // validators would reject on save. The list shows the user exactly
  // which fields they need to fill in (firstName/lastName for naturals,
  // company/legalForm for legal entities, taxId for both, plus a
  // checksum-valid Greek AFM). Without this, a tenant created via the
  // stepper or a partial PDF import LOOKS complete in the tile but
  // 422s on the next manual save.
  const missingFields = useMemo(() => {
    const missing = [];
    if (tenant.isCompany) {
      if (!tenant.company || !String(tenant.company).trim()) missing.push('company');
      if (!tenant.legalForm || !String(tenant.legalForm).trim()) missing.push('legalForm');
    } else {
      if (!tenant.firstName || !String(tenant.firstName).trim()) missing.push('firstName');
      if (!tenant.lastName || !String(tenant.lastName).trim()) missing.push('lastName');
    }
    if (!tenant.taxId || !String(tenant.taxId).trim()) {
      missing.push('taxId');
    } else {
      // Quick AFM checksum (matches services/api/src/validators.ts).
      // Mark "taxIdInvalid" when present-but-bad so the user fixes the
      // value rather than thinking the field is empty.
      const t = String(tenant.taxId).trim();
      if (/^\d{9}$/.test(t)) {
        let s = 0;
        for (let i = 0; i < 8; i++) s += Number(t[i]) * Math.pow(2, 8 - i);
        if (((s % 11) % 10) !== Number(t[8])) missing.push('taxIdInvalid');
      } else {
        missing.push('taxIdInvalid');
      }
    }
    return missing;
  }, [
    tenant.isCompany,
    tenant.firstName,
    tenant.lastName,
    tenant.company,
    tenant.legalForm,
    tenant.taxId
  ]);

  // Tier B8 — 4-state lease pill: terminated / future-start / incomplete /
  // running.
  //
  // 'incomplete' (added after a screenshot showed the contradiction):
  // a tenant with NO property/contract assigned cannot have a "running"
  // lease — rent billing literally cannot start (TenantPropertyList shows
  // the "No property assigned" warning in that case). Previously the pill
  // defaulted to 'running' (green) while the body said "no property set",
  // which is incoherent. A tenant with no beginDate OR no properties is
  // 'incomplete', not running.
  const leaseState = useMemo(() => {
    if (tenant.terminated) return 'terminated';
    const hasProperty = Array.isArray(tenant.properties)
      ? tenant.properties.length > 0
      : false;
    // Future-dated lease: surface 'future' even if the property isn't
    // linked yet — "starts later" is the dominant fact the user needs.
    if (tenant.beginDate) {
      const begin = moment(tenant.beginDate, 'DD/MM/YYYY').startOf('day');
      if (begin.isAfter(moment().startOf('day'))) return 'future';
    }
    // For a lease whose window has begun (or has no begin date), a
    // missing contract window OR missing property means billing can't
    // run — that's 'incomplete', NOT 'running'. This is the bug a real
    // screenshot surfaced: a no-property tenant showing a green
    // "Lease running" pill while the body warned "no property set".
    if (!tenant.beginDate || !hasProperty) return 'incomplete';
    return 'running';
  }, [tenant.terminated, tenant.beginDate, tenant.properties]);

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
        {missingFields.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 w-full py-2 px-5 border-t border-stone-line/60"
            data-cy="tenantMissingFields"
            data-missing-fields={missingFields.join(',')}
          >
            <span className="text-label text-ink-muted shrink-0">
              {t('Missing fields')}:
            </span>
            {missingFields.map((f) => (
              <Badge
                key={f}
                variant="outline"
                className="text-label border-amber-500 text-amber-700 leading-none"
              >
                {f === 'firstName' && t('First name')}
                {f === 'lastName' && t('Last name')}
                {f === 'company' && t('Company')}
                {f === 'legalForm' && t('Legal structure')}
                {f === 'taxId' && t('Tax ID')}
                {f === 'taxIdInvalid' && t('Tax ID (invalid)')}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-center justify-end w-full py-3 px-5">
          <Badge
            data-lease-state={leaseState}
            variant={
              leaseState === 'terminated'
                ? 'secondary'
                : leaseState === 'future' || leaseState === 'incomplete'
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
                leaseState === 'incomplete' && 'bg-amber-500',
                leaseState === 'running' && 'bg-olive'
              )}
            />
            {leaseState === 'terminated' && t('Lease ended')}
            {leaseState === 'future' && t('Lease starts in the future')}
            {leaseState === 'incomplete' && t('Setup incomplete')}
            {leaseState === 'running' && t('Lease running')}
          </Badge>
        </div>
      </CardFooter>
    </Card>
  );
}
