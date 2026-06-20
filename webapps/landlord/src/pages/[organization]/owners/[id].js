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
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

const _termLabel = (term) => {
  const s = String(term);
  return s.length >= 6 ? `${s.slice(4, 6)}/${s.slice(0, 4)}` : s;
};

// Per-unit scope label for an owner charge line. Server sends scope
// ('building'|'unit') + unitFloor + unitVacant (ownermanager.ts). A building-
// wide owner-portion reads "Ολόκληρο κτίριο"; a unit line reads the floor
// (Ισόγειο / Όροφος N), suffixed ΚΕΝΟ when the unit is vacant (the case where a
// vacant unit's tenant-share routes to the owner). Returns '' when not a unit
// scope with known floor, so the caller can omit the suffix entirely.
const _unitScopeLabel = (t, c) => {
  if (c.scope === 'building') return t('Whole building');
  if (c.scope !== 'unit') return '';
  let floorLabel = '';
  if (c.unitFloor === 0) floorLabel = t('Ground floor');
  else if (typeof c.unitFloor === 'number')
    floorLabel = `${t('Floor')} ${c.unitFloor}`;
  if (c.unitVacant) {
    // ΚΕΝΟ (neuter) per user. With a known floor: "Ισόγειο — ΚΕΝΟ".
    return floorLabel ? `${floorLabel} — ${t('Vacant unit')}` : t('Vacant unit');
  }
  return floorLabel;
};

// Group charges by month+building so the owner sees one block per
// (term, building) with the co-owner split shown ONCE in the header (not
// repeated per line — user decision 2026-06-20). Returns an array of
// { key, term, buildingName, coOwners, coOwnerCount, lines[], total }.
const _groupCharges = (charges) => {
  const groups = new Map();
  for (const c of charges) {
    const key = `${c.term}|${c.buildingId || c.buildingName}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        term: c.term,
        buildingName: c.buildingName,
        coOwners: Array.isArray(c.coOwners) ? c.coOwners : null,
        coOwnerCount: c.coOwnerCount || 0,
        lines: [],
        total: 0
      });
    }
    const g = groups.get(key);
    g.lines.push(c);
    g.total += Number(c.amount) || 0;
    // carry the richest co-owner split seen in the group for the header
    if (!g.coOwners && Array.isArray(c.coOwners) && c.coOwners.length > 1) {
      g.coOwners = c.coOwners;
      g.coOwnerCount = c.coOwnerCount || c.coOwners.length;
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.term - b.term);
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
                  {/* OD4: showZero so paid=0 renders "0,00 € / 70,00 €", not the
                      malformed "−/ 70,00 €" (NumberFormat returns "—" for 0
                      without showZero). */}
                  <NumberFormat value={paid} showZero />
                  <span className="text-ink-muted">
                    {' / '}
                    <NumberFormat value={total} showZero />
                  </span>
                </span>
              </div>
              <Progress value={pct} />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span className="text-olive">
                  {t('Paid')}: <NumberFormat value={paid} showZero />
                </span>
                <span className="text-oxide">
                  {t('Outstanding')}:{' '}
                  <NumberFormat value={Number(owner.totalOutstanding) || 0} />
                </span>
              </div>
            </Card>
          )}

          {/* Ακίνητα — one line per property, before Χρεώσεις */}
          {(owner.ownedProperties || []).length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2 flex items-center gap-2">
                <LuBuilding2 className="size-4 text-muted-foreground" />
                {t('Properties')}
              </div>
              <div className="divide-y divide-stone-line/40">
                {(owner.ownedProperties || []).map((prop, i) => (
                  <div
                    key={prop.propertyId || i}
                    className="flex items-center gap-3 py-1 text-xs cursor-pointer hover:bg-muted/40 -mx-2 px-2 rounded"
                    onClick={() =>
                      prop.propertyId &&
                      router.push(
                        `/${router.query.organization}/properties/${prop.propertyId}`
                      )
                    }
                  >
                    <span className="text-ink-muted w-5 shrink-0">#{i + 1}</span>
                    <span className="font-mono text-ink-muted w-28 shrink-0 truncate">
                      {prop.atakNumber}
                    </span>
                    <span className="text-ink-muted w-16 shrink-0 text-right">
                      {prop.surface ? `${prop.surface} m²` : ''}
                    </span>
                    <span className="text-ink truncate flex-1 min-w-0">
                      {prop.address
                        ? [prop.address.street1, prop.address.city, prop.address.zipCode]
                            .filter(Boolean)
                            .join(', ')
                        : prop.propertyName || ''}
                    </span>
                    <span className="text-ink-muted whitespace-nowrap shrink-0">
                      {prop.percentage != null && prop.percentage < 100
                        ? `${prop.percentage}%`
                        : ''}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Charges ledger — grouped by month+building. Co-owner split shown
              ONCE in the group header (user decision 2026-06-20); each line is
              labeled by its unit scope (Ολόκληρο κτίριο / floor / ΚΕΝΟ). */}
          <Card className="p-4">
            <div className="text-sm font-medium mb-2">{t('Charges')}</div>
            {charges.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('No expenses for this period')}
              </p>
            ) : (
              <div className="space-y-4">
                {_groupCharges(charges).map((g) => (
                  <div key={g.key}>
                    {/* group header: month · building, then the co-owner split
                        ONCE underneath (not per line) */}
                    <div className="flex items-baseline justify-between gap-2 text-sm font-medium">
                      <span>
                        {_termLabel(g.term)} · {g.buildingName}
                      </span>
                      <span className="tabular-nums text-ink-muted">
                        <NumberFormat value={g.total} showZero />
                      </span>
                    </div>
                    {Array.isArray(g.coOwners) && g.coOwners.length > 1 && (
                      <div className="text-xs text-muted-foreground/70 mb-1">
                        {t('Co-ownership')}:{' '}
                        {g.coOwners
                          .map((o) =>
                            `${o.isRest ? t('others') : o.name} ${o.percentage}%`
                          )
                          .join(' · ')}
                      </div>
                    )}
                    <div className="space-y-0.5 pl-3">
                      {g.lines.map((c) => {
                        const scopeLabel = _unitScopeLabel(t, c);
                        return (
                          <div
                            key={c.ownerExpenseId}
                            className="flex items-baseline justify-between gap-2 text-sm py-0.5"
                          >
                            <span className="truncate text-muted-foreground">
                              {ownerChargeLabel(t, c)}
                              {scopeLabel ? ` — ${scopeLabel}` : ''}
                            </span>
                            <span className="flex items-center gap-3 shrink-0 tabular-nums">
                              <span
                                className={c.paid ? 'text-olive' : 'text-oxide'}
                              >
                                <NumberFormat value={c.amount} />
                              </span>
                              <Badge
                                variant={c.paid ? 'success' : 'outline'}
                                className={
                                  'font-normal ' +
                                  (!c.paid ? 'border-oxide/40 text-oxide' : '')
                                }
                              >
                                {c.paid ? t('Paid') : `${t('Outstanding')} `}
                                {!c.paid && <NumberFormat value={c.outstanding} />}
                              </Badge>
                            </span>
                          </div>
                        );
                      })}
                    </div>
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

          {/* Ακίνητα — MOVED BEFORE Χρεώσεις, now renders BEFORE payments */}

          <OwnerPaymentDialog open={payOpen} setOpen={setPayOpen} owner={owner} />
        </div>
      )}
    </Page>
  );
}

export default withAuthentication(OwnerDetail);
