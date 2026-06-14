import { fetchOwner, QueryKeys } from '../../../utils/restcalls';
import { useCallback, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { downloadDocument } from '../../../utils/fetch';
import ErrorPage from 'next/error';
import { LuArrowLeft, LuDownload, LuHome, LuWallet } from 'react-icons/lu';
import NumberFormat from '../../../components/NumberFormat';
import OwnerPaymentDialog from '../../../components/owners/OwnerPaymentDialog';
import Page from '../../../components/Page';
import { Progress } from '../../../components/ui/progress';
import { ownerChargeLabel } from '../../../utils/lineLabels';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

const _termLabel = (term) => {
  const s = String(term);
  return s.length >= 6 ? `${s.slice(4, 6)}/${s.slice(0, 4)}` : s;
};

function OwnerDetail() {
  const { t } = useTranslation('common');
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

  // Download the owner expense statement (Εκκαθαριστικό) — the owner twin of
  // the tenant receipt. Covers the years the owner actually has charges in
  // (distinct from charges[].term), defaulting to all of them in one PDF.
  const downloadStatement = useCallback(async () => {
    if (!owner) return;
    const years = [
      ...new Set(
        (owner.charges || []).map((c) => String(c.term).slice(0, 4))
      )
    ].filter(Boolean);
    const term = years.length ? years.join(',') : String(new Date().getFullYear());
    try {
      await downloadDocument({
        endpoint: `/documents/owner-statement/${encodeURIComponent(
          owner.ownerKey
        )}/${term}`,
        documentName: `${owner.name || 'owner'}-statement.pdf`
      });
    } catch (e) {
      toast.error(e?.response?.status === 404 ? t('No owner expenses') : t('Something went wrong'));
    }
  }, [owner, t]);

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
                variant="outline"
                onClick={downloadStatement}
                className="gap-2"
                disabled={(owner.charges || []).length === 0}
              >
                <LuDownload className="size-4" />
                {t('Download statement')}
              </Button>
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
                                name: o.name,
                                pct: o.percentage,
                                amount: new Intl.NumberFormat(undefined, {
                                  style: 'currency',
                                  currency: 'EUR'
                                }).format(o.amount)
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

          <OwnerPaymentDialog open={payOpen} setOpen={setPayOpen} owner={owner} />
        </div>
      )}
    </Page>
  );
}

export default withAuthentication(OwnerDetail);
