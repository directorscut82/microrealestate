import { fetchOwner, QueryKeys } from '../../../utils/restcalls';
import { useCallback, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import ErrorPage from 'next/error';
import { LuArrowLeft, LuBuilding2, LuHome, LuWallet } from 'react-icons/lu';
import NumberFormat from '../../../components/NumberFormat';
import OwnerPaymentDialog from '../../../components/owners/OwnerPaymentDialog';
import Page from '../../../components/Page';
import { Progress } from '../../../components/ui/progress';
import { ownerChargeLabel } from '../../../utils/lineLabels';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useFormatNumber from '../../../hooks/useFormatNumber';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

const _termLabel = (term) => {
  const s = String(term);
  return s.length >= 6 ? `${s.slice(4, 6)}/${s.slice(0, 4)}` : s;
};

function OwnerDetail() {
  const { t } = useTranslation('common');
  const formatNumber = useFormatNumber();
  const router = useRouter();
  const ownerKey = decodeURIComponent(
    Array.isArray(router.query.id) ? router.query.id[0] : router.query.id || ''
  );
  const [payOpen, setPayOpen] = useState(false);

  const { data: owner, isLoading, isError } = useQuery({
    queryKey: [QueryKeys.OWNERS, ownerKey],
    queryFn: () => fetchOwner(ownerKey),
    enabled: !!ownerKey
  });

  const back = useCallback(
    () => router.push(`/${router.query.organization}/owners`),
    [router]
  );

  // (The owner statement/εκκαθαριστικό download lives in the Τιμολόγια →
  // Ιδιοκτήτες sub-tab, mirroring where tenant receipts are downloaded — not on
  // this detail page.)

  if (isError) {
    toast.error(t('Error fetching owners'));
    return <ErrorPage statusCode={404} />;
  }

  const total = Number(owner?.totalAmount) || 0;
  const paid = Number(owner?.totalPaid) || 0;
  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
  const charges = owner?.charges || [];
  const history = owner?.paymentHistory || [];

  return (
    <Page loading={isLoading} dataCy="ownerDetailPage">
      {owner && (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={back} aria-label={t('Back')}>
                <LuArrowLeft className="size-5" />
              </Button>
              <div>
                <div className="text-headline font-medium flex items-center gap-2">
                  {owner.name || t('Owner')}
                  {Number.isFinite(Number(owner.percentage)) &&
                    Number(owner.percentage) < 100 && (
                      <span className="text-base font-normal text-ink-muted">
                        ({owner.percentage}%)
                      </span>
                    )}
                  {owner.alsoRents && (
                    <Badge variant="outline" className="font-normal gap-1">
                      <LuHome className="size-3" aria-hidden="true" />
                      {t('Also a tenant')}
                    </Badge>
                  )}
                </div>
                {owner.taxId && (
                  <div className="text-label text-ink-muted">
                    {t('Tax ID')}: {owner.taxId}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setPayOpen(true)}
                className="gap-2"
                disabled={Number(owner.totalOutstanding) <= 0.005}
              >
                <LuWallet className="size-4" />
                {t('Record an owner payment')}
              </Button>
            </div>
          </div>

          {/* Paid vs total */}
          {total > 0 && (
            <Card className="p-4 space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-label text-ink-muted uppercase tracking-wide">
                  {t('Owner expenses paid')}
                </span>
                <span className="tabular-nums text-sm">
                  <NumberFormat value={paid} />
                  <span className="text-ink-muted">
                    {' / '}
                    <NumberFormat value={total} />
                  </span>
                </span>
              </div>
              <Progress value={pct} />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span className="text-olive">
                  {t('Paid')}: <NumberFormat value={paid} />
                </span>
                <span className="text-oxide">
                  {t('Outstanding')}:{' '}
                  <NumberFormat value={Number(owner.totalOutstanding) || 0} />
                </span>
              </div>
            </Card>
          )}

          {/* Charges ledger */}
          <Card className="p-4">
            <div className="text-sm font-medium mb-2">{t('Charges')}</div>
            {charges.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('No expenses for this period')}
              </p>
            ) : (
              <div className="space-y-1">
                {charges.map((c) => (
                  <div
                    key={c.ownerExpenseId}
                    className="flex items-baseline justify-between gap-2 text-sm py-0.5"
                  >
                    <span className="truncate text-muted-foreground">
                      {_termLabel(c.term)} · {c.buildingName} ·{' '}
                      {ownerChargeLabel(t, c)}
                      {Array.isArray(c.coOwners) && c.coOwners.length > 1 ? (
                        <span className="text-muted-foreground/60">
                          {' '}
                          (
                          {c.coOwners
                            .map((o) =>
                              t('{{name}} {{pct}}% = {{amount}}', {
                                name: o.isRest ? t('others') : o.name,
                                pct: o.percentage,
                                // R1-L6: org locale + currency, not hardcoded EUR
                                amount: formatNumber(o.amount)
                              })
                            )
                            .join(', ')}
                          )
                        </span>
                      ) : (
                        c.coOwnerCount > 1 && (
                          <span className="text-muted-foreground/60">
                            {' '}
                            ({t('co-owned')})
                          </span>
                        )
                      )}
                    </span>
                    <span className="flex items-center gap-3 shrink-0 tabular-nums">
                      <span className={c.paid ? 'text-olive' : 'text-oxide'}>
                        <NumberFormat value={c.amount} />
                      </span>
                      <Badge
                        variant={c.paid ? 'success' : 'outline'}
                        className={
                          'font-normal ' + (!c.paid ? 'border-oxide/40 text-oxide' : '')
                        }
                      >
                        {c.paid
                          ? t('Paid')
                          : `${t('Outstanding')} `}
                        {!c.paid && <NumberFormat value={c.outstanding} />}
                      </Badge>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Payment history */}
          {history.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2">
                {t('Payment history')}
              </div>
              <div className="space-y-1">
                {history.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground py-0.5"
                  >
                    <span className="truncate">
                      {p.date ? new Date(p.date).toLocaleDateString() : ''} ·{' '}
                      {_termLabel(p.term)} · {p.buildingName} · {t(p.type)}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </span>
                    <span className="tabular-nums text-olive">
                      <NumberFormat value={p.amount} />
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Owned apartments — ATAK, address, surface, link to property page */}
          {(owner.ownedProperties || []).length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2 flex items-center gap-2">
                <LuBuilding2 className="size-4 text-muted-foreground" />
                {t('Properties')}
              </div>
              <div className="space-y-1.5">
                {(owner.ownedProperties || []).map((prop, i) => (
                  <div
                    key={prop.propertyId || i}
                    className="text-xs py-1.5 cursor-pointer hover:bg-muted/40 -mx-2 px-2 rounded border-b border-stone-line/40 last:border-0"
                    onClick={() =>
                      prop.propertyId &&
                      router.push(
                        `/${router.query.organization}/properties/${prop.propertyId}`
                      )
                    }
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-ink font-medium truncate">
                        {prop.propertyName || prop.address?.street1 || t('Property')}
                      </span>
                      {prop.percentage != null && prop.percentage < 100 && (
                        <span className="text-ink-muted whitespace-nowrap">
                          {prop.percentage}%
                        </span>
                      )}
                    </div>
                    <div className="text-ink-muted mt-0.5">
                      {prop.address
                        ? [prop.address.street1, prop.address.city, prop.address.zipCode]
                            .filter(Boolean)
                            .join(', ')
                        : ''}
                      {prop.surface ? ` · ${prop.surface} m²` : ''}
                    </div>
                    <div className="text-ink-muted mt-0.5 font-mono text-[10px]">
                      ΑΤΑΚ {prop.atakNumber} · {prop.buildingName}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <OwnerPaymentDialog open={payOpen} setOpen={setPayOpen} owner={owner} />
        </div>
      )}
    </Page>
  );
}

export default withAuthentication(OwnerDetail);
