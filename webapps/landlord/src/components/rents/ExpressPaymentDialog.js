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
        // Wave-26 round-3r: r.totalAmount = grandTotal which already
        // includes the balance carry. r.totalWithoutBalanceAmount is
        // the THIS-MONTH bill alone (rent + charges + extras).
        // For tenants in arrears (balance < 0), totalAmount - balance
        // would DOUBLE the carry — wrong direction. Use the explicit
        // pre-balance field directly.
        const monthlyOwed = Math.max(
          0,
          Number(r.totalWithoutBalanceAmount) || 0
        );
        const carryOwed = Math.max(0, -(Number(r.balance) || 0));
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
      toast.success(
        t('Recorded {{count}} payments', { count: totals.count })
      );
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
          full-height, fixed width on >=sm. The drag-handle div inside
          DrawerContent (top mx-auto bar) is harmless visually. */}
      <DrawerContent className="!inset-y-0 !right-0 !left-auto !mt-0 !rounded-none h-full w-full sm:w-[440px] sm:max-w-[440px] flex flex-col">
        <DrawerHeader>
          <DrawerTitle>{t('Express settlement')}</DrawerTitle>
          <div className="text-xs text-ink-muted">
            {t(
              'Today · Bank transfer · auto-spreads to the monthly categories'
            )}
          </div>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto scrollbar-branded px-4 py-2 space-y-2">
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
                      checked={tenantTicked}
                      onCheckedChange={() => _toggleTenant(row.tenantId, row)}
                    />
                    <span className="font-medium text-ink">{row.name}</span>
                  </label>
                  <div className="mt-2 ml-6 space-y-1 text-sm bg-marble-tint/30 rounded-md px-3 py-2 border-l-2 border-stone-line/60">
                    {row.monthly > 0.005 ? (
                      <label className="flex items-center justify-between gap-2 cursor-pointer">
                        <div className="flex items-center gap-2">
                          <Checkbox
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
                      <label className="flex items-center justify-between gap-2 cursor-pointer">
                        <div className="flex items-center gap-2">
                          <Checkbox
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
