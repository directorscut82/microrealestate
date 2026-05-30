import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '../ui/collapsible';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '../ui/drawer';
import { LuChevronDown, LuChevronsUpDown, LuPencil } from 'react-icons/lu';
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { cn, getPeriod } from '../../utils';
import { fetchTenantRents } from '../../utils/restcalls';
import Loading from '../Loading';
import moment from 'moment';
import NewPaymentDialog from '../payment/NewPaymentDialog';
import NumberFormat from '../NumberFormat';
import RentDetails from './RentDetails';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

function _termRelation(term) {
  // Compares a YYYYMMDDHH term to the current month.
  // Returns 'past' / 'current' / 'future'.
  const currentTerm = Number(moment.utc().startOf('month').format('YYYYMMDDHH'));
  const t = Number(term);
  if (t < currentTerm) return 'past';
  if (t > currentTerm) return 'future';
  return 'current';
}

function RentListItem({ rent, tenant, onClick }) {
  const { t } = useTranslation('common');
  const relation = _termRelation(rent.term);
  // Three apparent visual states so the landlord can tell at a glance which
  // months are settled history, which is now, and which are projections:
  //   - past:    muted bg, normal border (completed)
  //   - current: 2px primary ring + stronger bg + "Current" badge
  //   - future:  reduced opacity + dashed border + bold "(estimate)" label
  // Wave-26 (4): current month uses a primary tint (subtle but obvious)
  // instead of the ring outline. Past stays muted, future stays dashed +
  // faded. The "Τρέχων" badge in the header makes the state explicit too.
  const cardClass = cn(
    'p-2 cursor-pointer transition-shadow',
    relation === 'past' && 'bg-marble-tint/40 border-stone-line',
    relation === 'current' && 'bg-primary/10 border-primary/40',
    relation === 'future' &&
      'border-dashed border-stone-line/70 opacity-60 hover:opacity-90'
  );

  const handleClick = useCallback(
    (event) => {
      event.stopPropagation();
      onClick?.(event);
    },
    [onClick]
  );

  return (
    <Card
      className={cardClass}
      onClick={handleClick}
      data-current-tile={relation === 'current' ? 'true' : undefined}
    >
      <CardHeader className="flex flex-row justify-between items-center">
        <div className="text-xl flex items-baseline gap-2">
          <span>{getPeriod(t, rent.term, tenant.occupant.frequency)}</span>
          {relation === 'current' && (
            <span className="text-label font-semibold text-primary uppercase tracking-wide">
              {t('Current')}
            </span>
          )}
          {relation === 'future' && (
            <span className="text-label font-semibold text-ink-muted italic">
              ({t('estimate')})
            </span>
          )}
        </div>
        <div>
          <Button variant="ghost" size="icon" onClick={handleClick}>
            <LuPencil className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <RentDetails rent={rent} />
      </CardContent>
    </Card>
  );
}

// Wave-26 round-3n: per-year totals shown next to the year in the
// accordion header. Two figures: collected (sum of rent.total.payment
// for terms in this year, but capped at grandTotal so a credit
// carry-forward doesn't inflate the number) and remaining-owed
// (sum of max(0, grandTotal - payment) for past + current terms only).
//
// For future years no figures are shown — the rent grandTotal is a
// projection at that point and quoting "owed" before the term lands
// would be misleading.
function YearTotals({ tenant, year }) {
  const { t } = useTranslation('common');
  const totals = useMemo(() => {
    const currentTermNum = Number(
      moment.utc().startOf('month').format('YYYYMMDDHH')
    );
    const yearStr = String(year);
    const yearRents = (tenant?.rents || []).filter(
      (r) => String(r.term).slice(0, 4) === yearStr
    );
    if (yearRents.length === 0) return null;

    // Year vs. today: future years suppress numbers.
    const yearStartTerm = Number(`${yearStr}010100`);
    if (yearStartTerm > currentTermNum) {
      return { future: true };
    }

    let collected = 0;
    let owed = 0;
    yearRents.forEach((r) => {
      // Wave-26 round-3q: frontdata.toRentData flattens rent.total.*
      // onto rentToReturn (totalAmount = grandTotal, payment, etc.).
      // Reading r.total.grandTotal directly returned undefined for the
      // entire API response — the prior implementation silently summed
      // 0,00 € for every year. Use the flattened fields instead.
      const grand = Number(r?.totalAmount) || 0;
      const paid = Number(r?.payment) || 0;
      collected += Math.min(paid, Math.max(grand, 0));
      // Only past + current terms contribute to owed; future months
      // within the current year have not "matured" as debt yet.
      const termNum = Number(r.term);
      if (termNum <= currentTermNum) {
        owed += Math.max(0, grand - paid);
      }
    });
    return { future: false, collected, owed };
    // Wave-26 round-3o: depend on the rents array specifically, not on
    // the tenant object reference. If a parent ever memoises `tenant`
    // (a routine perf optimisation), shallow [tenant, year] would go
    // stale even when tenant.rents updates with new payment data.
  }, [tenant?.rents, year]);

  if (!totals || totals.future) return null;

  return (
    <span className="ml-auto flex items-baseline gap-3 text-xs font-normal tabular-nums">
      <span className="text-olive">
        {t('Collected')}:{' '}
        {/* Wave-26 round-3o: showZero is REQUIRED here. Without it
            NumberFormat renders '—' for 0, which is confusing on a
            year that has tenants with all rents fully owed-but-not-
            paid (collected=0) or all rents past-paid-and-zero-owed.
            We want explicit '0,00 €' so the landlord knows the
            number rendered, not a missing-data placeholder. */}
        <NumberFormat value={totals.collected} showZero />
      </span>
      <span className={totals.owed > 0.005 ? 'text-oxide' : 'text-ink-muted'}>
        {t('Owed')}: <NumberFormat value={totals.owed} showZero />
      </span>
    </span>
  );
}

function YearRentList({ tenant, year, onClick }) {
  const rents =
    tenant.rents?.filter(({ term }) => String(term).slice(0, 4) === year) || [];

  const handleClick = useCallback(
    ({ occupant }, rent) =>
      () => {
        onClick({ _id: occupant._id, ...rent, occupant });
      },
    [onClick]
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 w-full">
      {rents?.map((rent) => {
        return (
          <RentListItem
            key={rent.term}
            rent={rent}
            tenant={tenant}
            onClick={handleClick(tenant, rent)}
          />
        );
      })}
    </div>
  );
}

function RentHistory({ tenantId }) {
  const { t } = useTranslation('common');
  const [loading, setLoading] = useState(true);
  const [tenant, setTenant] = useState();
  const [rentYears, setRentYears] = useState([]);
  const [expandedYear, setExpandedYear] = useState(
    moment().startOf('month').format('YYYYMMDDHH').slice(0, 4)
  );
  const [openNewPaymentDialog, setOpenNewPaymentDialog] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState(null);

  const fetchRents = useCallback(
    async (showLoadingAnimation = true) => {
      showLoadingAnimation && setLoading(true);
      try {
        const tenant = await fetchTenantRents(tenantId);
        setTenant(tenant);
        setRentYears(
          Array.from(
            tenant.rents.reduce((acc, { term }) => {
              acc.add(String(term).slice(0, 4));
              return acc;
            }, new Set())
          )
        );
      } catch {
        toast.error(t('Cannot get tenant information'));
      }
      showLoadingAnimation && setLoading(false);
    },
    [t, tenantId]
  );

  useEffect(() => {
    fetchRents();
  }, [fetchRents]);

  // Wave-26 (3): when the dialog opens (or new rent data loads), scroll
  // the current-month tile into view so the landlord doesn't have to
  // hunt for it. The tile carries data-current-tile="true"; we find it
  // inside the scroll container and center it.
  const scrollContainerRef = useRef(null);
  useEffect(() => {
    if (!tenant || loading) return;
    // Wait one frame for the rendered DOM to include the marked tile.
    const id = requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const target = container.querySelector('[data-current-tile="true"]');
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [tenant, loading]);

  const handleAccordionChange = (year) => () => {
    setExpandedYear(expandedYear === year ? false : year);
  };

  const handleClick = useCallback(
    (rent) => {
      setSelectedPayment(rent);
      setOpenNewPaymentDialog(true);
    },

    [setOpenNewPaymentDialog, setSelectedPayment]
  );

  const handleClose = useCallback(() => {
    fetchRents(false);
  }, [fetchRents]);

  return (
    <>
      <NewPaymentDialog
        open={openNewPaymentDialog}
        setOpen={setOpenNewPaymentDialog}
        data={selectedPayment}
        onClose={handleClose}
      />
      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="pb-4">
            <div className="text-xl font-semibold">{tenant.occupant.name}</div>
            {tenant.occupant.beginDate && tenant.occupant.endDate && (
              <div className="text-muted-foreground text-xs">
                {t('Contract from {{beginDate}} to {{endDate}}', {
                  beginDate: moment(
                    tenant.occupant.beginDate,
                    'DD/MM/YYYY'
                  ).format('L'),
                  endDate: moment(tenant.occupant.endDate, 'DD/MM/YYYY').format(
                    'L'
                  )
                })}
              </div>
            )}
          </div>
          <div ref={scrollContainerRef} className="overflow-y-auto p-4">
            {rentYears.map((year) => {
              return (
                <Collapsible
                  key={year}
                  open={expandedYear === year}
                  onOpenChange={handleAccordionChange(year)}
                >
                  <CollapsibleTrigger className="flex items-center justify-between w-full p-4 font-medium hover:bg-muted rounded-md gap-3">
                    <span>{year}</span>
                    <YearTotals tenant={tenant} year={year} />
                    <LuChevronDown className={`size-4 transition-transform shrink-0 ${expandedYear === year ? 'rotate-180' : ''}`} />
                  </CollapsibleTrigger>
                  {expandedYear === year ? (
                    <CollapsibleContent className="p-4">
                      <YearRentList
                        tenant={tenant}
                        year={year}
                        onClick={handleClick}
                      />
                    </CollapsibleContent>
                  ) : null}
                </Collapsible>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

export default function RentHistoryDialog({ open, setOpen, data: tenant }) {
  const { t } = useTranslation('common');
  const handleClose = useCallback(() => setOpen(false), [setOpen]);

  return (
    <Drawer open={open} onOpenChange={setOpen} dismissible={false}>
      <DrawerContent className="w-full h-full p-4">
        <DrawerHeader className="flex justify-between p-0">
          <DrawerTitle className="hidden">{t('Rent schedule')}</DrawerTitle>
          <span className="text-xl font-semibold">{t('Rent schedule')}</span>
          <Button variant="secondary" onClick={handleClose}>
            {t('Close')}
          </Button>
        </DrawerHeader>
        {tenant ? <RentHistory tenantId={tenant._id} /> : null}
      </DrawerContent>
    </Drawer>
  );
}
