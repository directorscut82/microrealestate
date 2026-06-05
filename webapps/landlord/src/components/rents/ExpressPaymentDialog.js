import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from '../ui/drawer';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import NumberFormat from '../NumberFormat';
import { QueryKeys } from '../../utils/restcalls';
import { apiFetcher } from '../../utils/fetch';
import moment from 'moment';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

/**
 * Wave-26 round-3r: Express payment drawer.
 *
 * Right-side Vaul drawer triggered from the legend row. Lists tenants
 * with non-zero μηνιαίο owed OR non-zero προηγ. υπόλοιπο. Per row:
 * tenant checkbox + two sub-checkboxes (Μηνιαίο, Προηγ. υπόλοιπο).
 * Each sub-checkbox shows the resolved amount.
 *
 * Submit posts to POST /api/v2/rents/express; server resolves real
 * amounts from the live rent doc and applies one transfer per tenant
 * dated today, allocated by the rent computation pipeline's auto-spread
 * for the monthly portion plus an explicit `previousBalance` entry for
 * the carry-in portion.
 */
export default function ExpressPaymentDialog({ open, setOpen, rents }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  // Only tenants with something owed appear. Computed once from the
  // rents prop; stable across dialog re-renders unless the rents data
  // refetches behind us.
  const eligible = useMemo(() => {
    return (rents || [])
      .map((r) => {
        // Wave-26 round-3s: convention in this codebase is
        // `rent.balance > 0` means tenant has carry-in DEBT (arrears).
        // Round-3r had this inverted; carryOwed was always 0 so the
        // dialog never offered prior-balance rows.
        const monthlyOwed = Math.max(
          0,
          Number(r.totalWithoutBalanceAmount) || 0
        );
        const carryOwed = Math.max(0, Number(r.balance) || 0);
        // Subtract what's already been paid against monthly first.
        // payment is the lump paid sum; allocate it conceptually:
        // first to carry-in, then to monthly. Keeps the dialog from
        // offering already-paid amounts.
        let monthlyOwedRemaining = monthlyOwed;
        let carryOwedRemaining = carryOwed;
        let paid = Number(r.payment) || 0;
        if (paid > 0 && carryOwedRemaining > 0) {
          const used = Math.min(paid, carryOwedRemaining);
          carryOwedRemaining -= used;
          paid -= used;
        }
        if (paid > 0 && monthlyOwedRemaining > 0) {
          const used = Math.min(paid, monthlyOwedRemaining);
          monthlyOwedRemaining -= used;
        }
        return {
          tenantId: r._id,
          term: r.term,
          name: r.occupant?.name || '',
          monthly: Math.round(monthlyOwedRemaining * 100) / 100,
          carry: Math.round(carryOwedRemaining * 100) / 100
        };
      })
      .filter((row) => row.monthly > 0.005 || row.carry > 0.005);
  }, [rents]);

  // Selection state: { [tenantId]: { monthly: bool, carry: bool } }.
  const [selection, setSelection] = useState({});
  const _toggle = (tenantId, key) =>
    setSelection((s) => {
      const prev = s[tenantId] || { monthly: false, carry: false };
      return { ...s, [tenantId]: { ...prev, [key]: !prev[key] } };
    });
  const _toggleTenant = (tenantId, row) =>
    setSelection((s) => {
      const prev = s[tenantId] || { monthly: false, carry: false };
      const allOff = !prev.monthly && !prev.carry;
      // Tenant master = "tick everything that has a non-zero amount".
      return {
        ...s,
        [tenantId]: allOff
          ? { monthly: row.monthly > 0.005, carry: row.carry > 0.005 }
          : { monthly: false, carry: false }
      };
    });

  const totals = useMemo(() => {
    let total = 0;
    let count = 0;
    eligible.forEach((row) => {
      const sel = selection[row.tenantId];
      if (!sel) return;
      let any = false;
      if (sel.monthly && row.monthly > 0.005) {
        total += row.monthly;
        any = true;
      }
      if (sel.carry && row.carry > 0.005) {
        total += row.carry;
        any = true;
      }
      if (any) count += 1;
    });
    return { total: Math.round(total * 100) / 100, count };
  }, [eligible, selection]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const items = eligible
        .map((row) => {
          const sel = selection[row.tenantId];
          if (!sel) return null;
          const monthly = !!(sel.monthly && row.monthly > 0.005);
          const carry = !!(sel.carry && row.carry > 0.005);
          if (!monthly && !carry) return null;
          return {
            tenantId: row.tenantId,
            term: String(row.term),
            monthly,
            previousBalance: carry
          };
        })
        .filter(Boolean);
      if (items.length === 0) {
        throw new Error('nothing selected');
      }
      const r = await apiFetcher().post('/rents/express', { items });
      return r.data;
    },
    onSuccess: async (data) => {
      // Await the rents refetch before closing the drawer. Without this,
      // the drawer closes while the page-level useQuery is still mid-
      // refetch and the rent rows render stale Payment cells for several
      // hundred ms — users assume the click failed, re-click, double-pay.
      // ExpressPaymentDialog and PaymentTabs use the same pattern.
      await queryClient.refetchQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
      // Server returns { results: [{ skipped, tenantId, term, amount }] }.
      // Toast the count of ACTUAL writes, not selections — a tenant whose
      // owed amount became 0 between the dialog render and the click is
      // skipped server-side. The old code reported totals.count (the
      // selection count) and silently misled the user when skips happened.
      const results = Array.isArray(data?.results) ? data.results : [];
      const failed = results.filter((r) => r.failed).length;
      const recorded = results.filter((r) => !r.skipped && !r.failed).length;
      const skipped = results.filter((r) => r.skipped).length;
      // E18: server now returns per-item outcomes from Promise.allSettled
      // — surface failures as a warning toast distinct from the
      // already-settled skips so the user knows to retry the failed
      // rows. Without this branch, partial-write failures landed
      // silently as "Recorded N payments" with N being only the
      // successes.
      if (failed > 0) {
        toast.warning(
          t(
            'Recorded {{recorded}} of {{total}} payments ({{failed}} failed)',
            { recorded, total: totals.count, failed }
          )
        );
      } else if (skipped > 0) {
        toast.success(
          t(
            'Recorded {{recorded}} of {{total}} payments ({{skipped}} already settled)',
            { recorded, total: totals.count, skipped }
          )
        );
      } else {
        toast.success(
          t('Recorded {{count}} payments', { count: recorded || totals.count })
        );
      }
      setSelection({});
      setOpen(false);
    },
    onError: (err) => {
      const msg =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        err?.message ||
        'Something went wrong';
      toast.error(String(msg));
    }
  });

  const handleClose = useCallback(() => setOpen(false), [setOpen]);

  return (
    <Drawer open={open} onOpenChange={setOpen} direction="right">
      {/* Override the default bottom-anchored geometry: right-anchored,
          full-height, fixed width on >=sm. hideHandle drops the
          bottom-anchored drag bar that would otherwise appear at the
          top of the right-side panel. */}
      <DrawerContent
        hideHandle
        className="!inset-y-0 !right-0 !left-auto !mt-0 !rounded-none h-full w-full sm:w-[440px] sm:max-w-[440px] flex flex-col"
      >
        {/* Wave-26 round-3t: header gets a literal date in the
            subtitle so the user knows exactly when this batch will be
            recorded, plus extra vertical breathing room (px-5 pt-5
            pb-3, gap before list). */}
        <DrawerHeader className="px-5 pt-5 pb-3">
          <DrawerTitle>{t('Express settlement')}</DrawerTitle>
          <div className="text-xs text-ink-muted leading-relaxed">
            {t(
              'Auto-spread settlement via bank transfer (date: {{date}})',
              { date: moment().format('DD/MM/YYYY') }
            )}
          </div>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto scrollbar-branded px-5 py-3 space-y-3">
          {eligible.length === 0 ? (
            <div className="text-center text-sm text-ink-muted py-8">
              {t('All tenants are up to date for this month.')}
            </div>
          ) : (
            eligible.map((row) => {
              const sel = selection[row.tenantId] || {
                monthly: false,
                carry: false
              };
              const tenantTicked = sel.monthly || sel.carry;
              return (
                <div
                  key={row.tenantId}
                  className="border rounded-md p-3 border-stone-line"
                >
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      className="h-3.5 w-3.5"
                      checked={tenantTicked}
                      onCheckedChange={() => _toggleTenant(row.tenantId, row)}
                    />
                    <span className="font-medium text-ink">{row.name}</span>
                  </label>
                  {/* Wave-26 round-3t: sub-options no longer use the
                      left-accent-bar which read as "weird" in review.
                      Each sub-row gets its own indent + soft cream
                      background, separated by a 2px gap from the
                      tenant master row. Smaller checkboxes match. */}
                  <div className="mt-2 ml-5 space-y-1 text-sm">
                    {row.monthly > 0.005 ? (
                      <label className="flex items-center justify-between gap-2 cursor-pointer rounded px-2 py-1 hover:bg-cream/60">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            className="h-3.5 w-3.5"
                            checked={!!sel.monthly}
                            onCheckedChange={() =>
                              _toggle(row.tenantId, 'monthly')
                            }
                          />
                          <span className="text-ink-soft">
                            {t('Monthly')}
                          </span>
                        </div>
                        <NumberFormat value={row.monthly} />
                      </label>
                    ) : null}
                    {row.carry > 0.005 ? (
                      <label className="flex items-center justify-between gap-2 cursor-pointer rounded px-2 py-1 hover:bg-cream/60">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            className="h-3.5 w-3.5"
                            checked={!!sel.carry}
                            onCheckedChange={() =>
                              _toggle(row.tenantId, 'carry')
                            }
                          />
                          <span className="text-ink-soft">
                            {t('Prior balance')}
                          </span>
                        </div>
                        <NumberFormat value={row.carry} />
                      </label>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <DrawerFooter>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-ink-muted">
              {t('{{count}} tenants', { count: totals.count })}
            </span>
            <span className="font-mono tabular-nums font-semibold text-ink">
              <NumberFormat value={totals.total} />
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose}>
              {t('Cancel')}
            </Button>
            <Button
              disabled={
                totals.count === 0 || submitMutation.isPending
              }
              onClick={() => submitMutation.mutate()}
            >
              {submitMutation.isPending ? t('Saving') : t('Record')}
            </Button>
          </div>
        </DrawerFooter>
        {/* Today's date is shown in the header subtitle so the user
            knows the dialog uses moment() at submit. */}
        <div className="hidden">
          {moment().format('DD/MM/YYYY')}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
