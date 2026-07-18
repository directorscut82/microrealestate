import { fetchOwner, QueryKeys } from '../../../utils/restcalls';
import { useCallback, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import DocumentsPanel from '../../../components/documents/DocumentsPanel';
import ErrorPage from 'next/error';
import { LuArrowLeft, LuBuilding2, LuHome, LuWallet } from 'react-icons/lu';
import NumberFormat from '../../../components/NumberFormat';
import OwnerPaymentDialog from '../../../components/owners/OwnerPaymentDialog';
import Page from '../../../components/Page';
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
// Signature of a co-owner split so we can tell whether all co-owned lines in a
// group share the SAME split (then show it once in the header) or differ (then
// the header split would mislabel some lines — show per line instead). Step-7
// BROKEN 6: a (term,building) group can mix a building-wide co-owned charge with
// per-unit charges that have a different/no split.
const _splitSig = (coOwners) =>
  Array.isArray(coOwners) && coOwners.length > 1
    ? coOwners.map((o) => `${o.ownerKey || o.name}:${o.percentage}`).join('|')
    : '';

const _groupCharges = (charges) => {
  const groups = new Map();
  for (const c of charges) {
    const key = `${c.term}|${c.buildingId || c.buildingName}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        term: c.term,
        buildingName: c.buildingName,
        lines: [],
        total: 0,
        _sigs: new Set()
      });
    }
    const g = groups.get(key);
    g.lines.push(c);
    g.total += Number(c.amount) || 0;
    const sig = _splitSig(c.coOwners);
    if (sig) g._sigs.add(sig);
    else g._hasSoleOwned = true; // a line with no co-owner split
  }
  // Decide header vs per-line split. The header split is shown ONLY when the
  // group is UNIFORMLY co-owned: every line shares exactly one split signature
  // AND no sole-owned line is present (Step-7 r2 OWN-1: a header split must not
  // imply a split for sole-owned lines in a mixed group). Otherwise each
  // co-owned line shows its own split inline.
  return Array.from(groups.values())
    .map((g) => {
      const uniform = g._sigs.size === 1 && !g._hasSoleOwned;
      const headerCoOwners = uniform
        ? g.lines.find((l) => _splitSig(l.coOwners))?.coOwners || null
        : null;
      return {
        ...g,
        coOwners: headerCoOwners,
        // per-line split whenever we can't show a single header split but
        // co-owned lines exist (mixed signatures, or co-owned mixed with sole).
        showSplitPerLine: !headerCoOwners && g._sigs.size >= 1
      };
    })
    .sort((a, b) => a.term - b.term);
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
  // «Λοιποί ιδιοκτήτες» is a read-only placeholder for an un-named co-owner
  // remainder — it has no real owner row, so it is NOT payable (the server also
  // rejects a payment for it). Hide the pay affordance; the remainder is settled
  // by naming the co-owner (add name+ΑΦΜ on the unit), not by paying ΛΟΙΠΟΙ.
  const isLoipoi = String(ownerKey).startsWith('loipoi:');

  return (
    <Page loading={isLoading} dataCy="ownerDetailPage">
      {owner && (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pt-2">
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
              {!isLoipoi && (
                <Button
                  onClick={() => setPayOpen(true)}
                  className="gap-2"
                  disabled={Number(owner.totalOutstanding) <= 0.005}
                >
                  <LuWallet className="size-4" />
                  {t('Record an owner payment')}
                </Button>
              )}
              {/* ΛΟΙΠΟΙ is not payable — it is settled by NAMING the co-owner on
                  the unit. Give the landlord a direct path there instead of a
                  dead-end (previously no button, no hint where to go). */}
              {isLoipoi && owner.loipoiTarget && (
                <Button
                  onClick={() =>
                    router.push(
                      `/${router.query.organization}/buildings/${owner.loipoiTarget.buildingId}?tab=units`
                    )
                  }
                  className="gap-2"
                >
                  <LuBuilding2 className="size-4" />
                  {t('Name the co-owner')}
                </Button>
              )}
            </div>
          </div>

          {/* Contact info — read from the API (phone/email from units[].owners[]).
              Editable on the unit co-owner editor (building → units tab). */}
          {!isLoipoi && (owner.phone || owner.email) && (
            <Card className="px-5 py-3">
              <div className="flex items-center gap-6 text-sm text-ink-soft">
                {owner.phone && (
                  <span className="flex items-center gap-1.5">
                    📞 {owner.phone}
                  </span>
                )}
                {owner.email && (
                  <span className="flex items-center gap-1.5">
                    ✉ {owner.email}
                  </span>
                )}
              </div>
            </Card>
          )}

          {/* ΛΟΙΠΟΙ explainer: tell the landlord WHAT this placeholder is and
              HOW to resolve it (name the co-owner) — the row is otherwise a
              confusing unpayable balance with no path forward. */}
          {isLoipoi && (
            <Card className="p-4 border-sea/30 bg-sea/5">
              <p className="text-body text-ink">
                {t(
                  'This is the un-named co-owner share of {{unit}}. Record the real owner by adding their name and Α.Φ.Μ. on the unit; this balance then moves to that owner automatically.',
                  {
                    unit: owner.loipoiTarget
                      ? [
                          owner.loipoiTarget.buildingName,
                          owner.loipoiTarget.unitFloor === 0
                            ? t('Ground floor')
                            : typeof owner.loipoiTarget.unitFloor === 'number'
                              ? `${t('Floor')} ${owner.loipoiTarget.unitFloor}`
                              : null
                        ]
                          .filter(Boolean)
                          .join(', ')
                      : t('this unit')
                  }
                )}
              </p>
            </Card>
          )}

          {/* Paid vs total — thin two-tone bar (not the fat near-black blob). */}
          {total > 0 && (
            <Card className="p-5 space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-label text-ink-muted uppercase tracking-wide">
                  {t('Owner expenses paid')}
                </span>
                <span className="font-mono tabular-nums text-body text-ink">
                  {/* OD4: showZero so paid=0 renders "0,00 € / 70,00 €". */}
                  <NumberFormat value={paid} showZero />
                  <span className="text-ink-muted">
                    {' / '}
                    <NumberFormat value={total} showZero />
                  </span>
                </span>
              </div>
              <div className="h-2 rounded-pill bg-stone overflow-hidden">
                <div
                  className="h-full rounded-pill bg-olive"
                  style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                />
              </div>
              <div className="flex justify-between text-label">
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
            <Card className="p-5">
              <div className="text-label text-ink-muted uppercase tracking-wide mb-3 flex items-center gap-2">
                <LuBuilding2 className="size-4" />
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
          <Card className="p-5">
            <div className="text-label text-ink-muted uppercase tracking-wide mb-3">
              {t('Charges')}
            </div>
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
                        // Step-7 BROKEN 6: when the group's co-owned lines have
                        // DIFFERENT splits, the header split is suppressed and
                        // each co-owned line shows its OWN split inline instead.
                        const perLineSplit =
                          g.showSplitPerLine &&
                          Array.isArray(c.coOwners) &&
                          c.coOwners.length > 1
                            ? c.coOwners
                                .map(
                                  (o) =>
                                    `${o.isRest ? t('others') : o.name} ${o.percentage}%`
                                )
                                .join(' · ')
                            : '';
                        return (
                          <div
                            key={c.ownerExpenseId}
                            className="flex items-baseline justify-between gap-2 text-sm py-0.5"
                          >
                            <span className="truncate text-muted-foreground">
                              {ownerChargeLabel(t, c)}
                              {scopeLabel ? ` — ${scopeLabel}` : ''}
                              {perLineSplit ? (
                                <span className="text-muted-foreground/60">
                                  {' '}
                                  ({perLineSplit})
                                </span>
                              ) : null}
                            </span>
                            {/* Money column. Three states, no redundant
                                repeat of the same number (user: when unpaid the
                                amount and «Οφειλές» were identical pills):
                                  • fully paid  → amount (olive) + «Πληρωμένο»
                                  • partially   → amount + «X πληρωμένο / Y οφειλή»
                                  • unpaid      → amount (oxide) ONLY, no pill
                                «paidAmount»/«outstanding» are server-computed. */}
                            {(() => {
                              const partiallyPaid =
                                !c.paid &&
                                Number(c.paidAmount) > 0.005 &&
                                Number(c.outstanding) > 0.005;
                              return (
                                <span className="flex items-center gap-3 shrink-0 tabular-nums">
                                  <span
                                    className={
                                      c.paid ? 'text-olive' : 'text-oxide'
                                    }
                                  >
                                    <NumberFormat value={c.amount} />
                                  </span>
                                  {c.paid && (
                                    <Badge variant="success" className="font-normal">
                                      {t('Charge settled')}
                                    </Badge>
                                  )}
                                  {partiallyPaid && (
                                    <Badge
                                      variant="outline"
                                      className="font-normal border-oxide/40 text-oxide gap-1"
                                    >
                                      <span className="text-olive">
                                        <NumberFormat value={c.paidAmount} />
                                      </span>
                                      <span className="text-muted-foreground">
                                        {t('paid')}
                                      </span>
                                      <span>·</span>
                                      <NumberFormat value={c.outstanding} />
                                      <span className="text-muted-foreground">
                                        {t('owed')}
                                      </span>
                                    </Badge>
                                  )}
                                </span>
                              );
                            })()}
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

          {/* Έγγραφα — compact inline section (not a full-blown Card tile). */}
          {!isLoipoi && (
            <DocumentsPanel
              entity={{ ownerKey }}
              folder={`owners/${owner?.name || ownerKey}`}
              className="border-0 shadow-none p-0"
            />
          )}

          {!isLoipoi && (
            <OwnerPaymentDialog open={payOpen} setOpen={setPayOpen} owner={owner} />
          )}
        </div>
      )}
    </Page>
  );
}

export default withAuthentication(OwnerDetail);
