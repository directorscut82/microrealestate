import {
  fetchProperties,
  fetchTenants,
  QueryKeys
} from '../../utils/restcalls';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { cn } from '../../utils';
import { LuBuilding2, LuCar, LuHome, LuUser } from 'react-icons/lu';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

// Mirror services/api/src/businesslogic/tasks/1_base.ts :: isExpenseActiveForTerm —
// must agree with the rent-pipeline check so the dashboard headline matches what
// is actually being billed. Recurring expenses honor [startTerm, endTerm];
// one-time expenses match by YYYYMM (Wave-18 B1).
function isExpenseActiveForTerm(expense, term) {
  if (!(expense.isRecurring ?? expense.recurring)) {
    if (!expense.startTerm) return false;
    if (Math.floor(expense.startTerm / 10000) !== Math.floor(term / 10000)) {
      return false;
    }
    return true;
  }
  if (expense.startTerm && term < expense.startTerm) return false;
  if (expense.endTerm && term > expense.endTerm) return false;
  return true;
}

const OCCUPANCY_CONFIG = {
  rented: {
    label: 'Rented',
    color: 'bg-green-500',
    textColor: 'text-green-700',
    bgColor: 'bg-green-50',
    icon: LuUser
  },
  owner_occupied: {
    label: 'Owner occupied',
    color: 'bg-blue-500',
    textColor: 'text-blue-700',
    bgColor: 'bg-blue-50',
    icon: LuHome
  },
  vacant: {
    label: 'Vacant',
    color: 'bg-muted-foreground',
    textColor: 'text-muted-foreground',
    bgColor: 'bg-muted/30',
    icon: LuBuilding2
  },
  parking: {
    label: 'Parking',
    color: 'bg-amber-500',
    textColor: 'text-amber-700',
    bgColor: 'bg-amber-50',
    icon: LuCar
  }
};

function OccupancyBadge({ type }) {
  const { t } = useTranslation('common');
  const config = OCCUPANCY_CONFIG[type] || OCCUPANCY_CONFIG.vacant;
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 font-normal', config.textColor, config.bgColor)}
    >
      <span className={cn('h-2 w-2 rounded-full', config.color)} />
      {t(config.label)}
    </Badge>
  );
}

function FloorLabel({ floor }) {
  const { t } = useTranslation('common');
  if (floor === -1 || floor === null || floor === undefined) {
    return <span className="text-muted-foreground">{t('Basement')}</span>;
  }
  if (floor === 0) {
    return <span>{t('Ground floor')}</span>;
  }
  return (
    <span>
      {t('Floor')} {floor}
    </span>
  );
}

export default function BuildingDashboard({ building }) {
  const { t } = useTranslation('common');

  const { data: properties } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties
  });

  const { data: tenants } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: () => fetchTenants()
  });

  // Build lookup maps
  const propertyMap = useMemo(() => {
    const map = new Map();
    if (properties) {
      properties.forEach((p) => map.set(p._id, p));
    }
    return map;
  }, [properties]);

  const tenantByPropertyId = useMemo(() => {
    const map = new Map();
    if (tenants) {
      tenants.forEach((tenant) => {
        // E22: skip terminated / archived tenants so the building view's
        // "Tenant / Occupant" column doesn't keep showing a person who
        // has already moved out. Without this filter the dashboard
        // claimed a unit was rented even after termination, masking the
        // vacancy from the operator until they navigated to the tenant
        // record itself.
        if (tenant.terminated || tenant.archived) return;
        if (tenant.properties) {
          tenant.properties.forEach((tp) => {
            map.set(tp.propertyId, {
              name: tenant.name,
              rent: tp.rent,
              tenantId: tenant._id
            });
          });
        }
      });
    }
    return map;
  }, [tenants]);

  const tenantById = useMemo(() => {
    const map = new Map();
    if (tenants) {
      tenants.forEach((tenant) => map.set(tenant._id, tenant));
    }
    return map;
  }, [tenants]);

  // Sort units by floor, then by surface
  const sortedUnits = useMemo(() => {
    if (!building?.units) return [];
    return [...building.units].sort((a, b) => {
      const fa = a.floor ?? -99;
      const fb = b.floor ?? -99;
      if (fa !== fb) return fa - fb;
      return (b.surface || 0) - (a.surface || 0);
    });
  }, [building?.units]);

  // Group by floor for summary
  const floorSummary = useMemo(() => {
    const floors = new Map();
    sortedUnits.forEach((unit) => {
      const floor = unit.floor ?? -1;
      if (!floors.has(floor)) floors.set(floor, []);
      floors.get(floor).push(unit);
    });
    return floors;
  }, [sortedUnits]);

  // Stats
  const stats = useMemo(() => {
    const s = { total: 0, rented: 0, ownerOccupied: 0, vacant: 0, parking: 0 };
    sortedUnits.forEach((unit) => {
      s.total++;
      const occ = unit.occupancyType || 'vacant';
      if (occ === 'rented') s.rented++;
      else if (occ === 'owner_occupied') s.ownerOccupied++;
      else if (occ === 'parking') s.parking++;
      else s.vacant++;
    });
    return s;
  }, [sortedUnits]);

  // Annual esoda / eksoda summary for this building.
  // Esoda  = sum of monthly rent across all currently-rented units × 12.
  // Eksoda = recurring building expenses ×12 + one-time expenses
  //          + tenant-distributed portion of repairs (from unit.monthlyCharges
  //            with repairId set — owner-portion already lands in
  //            ownerMonthlyExpenses via Stage 1 I-3.f, so we must NOT also
  //            count repair.actualCost/estimatedCost wholesale)
  //          + owner expenses (ownerMonthlyExpenses entries +
  //            sum(BuildingExpense.ownerAmount) ×12 for recurring fixed
  //            owner-tracked expenses active for the current period).
  // Owner-occupied + parking units contribute zero esoda but still incur
  // their share of any owner-tracked expenses.
  const finance = useMemo(() => {
    const monthlyEsoda = sortedUnits.reduce((sum, unit) => {
      if (!unit.propertyId) return sum;
      const property = propertyMap.get(
        typeof unit.propertyId === 'string' ? unit.propertyId : unit.propertyId?._id
      );
      const tenantInfo = property ? tenantByPropertyId.get(property._id) : null;
      if (!tenantInfo) return sum;
      return sum + (Number(tenantInfo.rent) || 0);
    }, 0);

    // Current term in YYYYMMDDHH so we can ask isExpenseActiveForTerm whether
    // an expense's [startTerm, endTerm] window covers "now". Using local
    // moment matches the rent-pipeline projection in 1_base.ts (which
    // operates on rent.term).
    const currentTerm = Number(
      moment().startOf('month').format('YYYYMMDDHH')
    );

    // The headline reads "Annual projection". Every additive stream below
    // MUST be scoped to either (a) the current term (for the ×12 monthly
    // streams) or (b) the current calendar year (for the lifetime
    // ledgers). Without this scoping the figure becomes a hidden
    // lifetime sum and inflates monotonically for multi-year buildings —
    // a class of regression caught in the F1/F2/F3 dashboard audit.
    // Term shape is YYYYMMDDHH; floor by 1e6 yields the year.
    const currentYear = Math.floor(currentTerm / 1000000);

    // Wave-24 A13: legacy seed data persists this flag as `recurring`
    // (without the is- prefix). Read both so existing buildings show the
    // correct totals after upgrade — the new schema field shadows the
    // legacy one when both happen to be set.
    //
    // F2-buildingdash: gate recurring on isExpenseActiveForTerm — without
    // this, terminated expenses (endTerm < currentTerm) and not-yet-started
    // expenses (startTerm > currentTerm) inflate the headline.
    const recurringMonthlyEksoda = (building?.expenses || [])
      .filter(
        (e) =>
          (e.isRecurring ?? e.recurring) &&
          e.amount > 0 &&
          isExpenseActiveForTerm(e, currentTerm)
      )
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    // F3-buildingdash: gate one-time expenses on currentYear — a one-time
    // expense saved in 2018 must not appear in the 2026 headline.
    const oneTimeEksoda = (building?.expenses || [])
      .filter(
        (e) =>
          !(e.isRecurring ?? e.recurring) &&
          e.amount > 0 &&
          Math.floor(Number(e.startTerm || 0) / 1000000) === currentYear
      )
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    // Stage 1 I-3.f: tenant share of repairs is materialized as
    // unit.monthlyCharges entries (one per unit per term, repairId set).
    // F1-buildingdash: filter to currentYear charges — without this the
    // sum spans the lifetime per-unit ledger and inflates the headline.
    const repairEksoda = (building?.units || []).reduce((sum, unit) => {
      const charges = unit.monthlyCharges || [];
      return (
        sum +
        charges
          .filter(
            (c) =>
              c.repairId &&
              Math.floor(Number(c.term || 0) / 1000000) === currentYear
          )
          .reduce((s, c) => s + (Number(c.amount) || 0), 0)
      );
    }, 0);
    // Owner expenses comprise three additive streams (no overlap between them):
    //  1. ownerMonthlyExpenses entries — variable owner amounts entered per
    //     term via MonthlyStatement, plus owner-portion of repairs (Stage 1).
    //  2. BuildingExpense.ownerAmount where trackOwnerExpense+isRecurring —
    //     the fixed monthly owner-only portion of a recurring expense, which
    //     is NEVER persisted to ownerMonthlyExpenses (those rows are reserved
    //     for variable amounts). Without this projection the dashboard
    //     undercounts by the entire fixed owner share.
    const recordedOwnerEksoda = (building?.ownerMonthlyExpenses || [])
      .filter((e) => Math.floor(Number(e.term || 0) / 1000000) === currentYear)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const fixedOwnerMonthly = (building?.expenses || [])
      .filter(
        (e) =>
          e.trackOwnerExpense &&
          (e.isRecurring ?? e.recurring) &&
          Number(e.ownerAmount) > 0 &&
          isExpenseActiveForTerm(e, currentTerm)
      )
      .reduce((sum, e) => sum + (Number(e.ownerAmount) || 0), 0);
    const ownerEksoda = recordedOwnerEksoda + fixedOwnerMonthly * 12;

    const annualEsoda = monthlyEsoda * 12;
    const annualEksoda =
      recurringMonthlyEksoda * 12 +
      oneTimeEksoda +
      repairEksoda +
      ownerEksoda;
    const net = annualEsoda - annualEksoda;
    return {
      monthlyEsoda,
      annualEsoda,
      recurringMonthlyEksoda,
      oneTimeEksoda,
      repairEksoda,
      ownerEksoda,
      annualEksoda,
      net
    };
  }, [
    sortedUnits,
    propertyMap,
    tenantByPropertyId,
    building?.expenses,
    building?.units,
    building?.ownerMonthlyExpenses
  ]);

  if (!building) return null;

  return (
    <div className="space-y-6">
      {/* Esoda / Eksoda summary (annual projection) — at the top so the
          landlord sees the headline financial picture before the unit list. */}
      <Card className="p-4">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-label text-muted-foreground uppercase tracking-wide">
              {t('Income vs expenses')}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {t(
                'Annual projection — current monthly rent × 12, recurring expenses × 12, plus all one-time expenses, repairs, and owner-tracked expenses.'
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-6 text-right">
            <div>
              <div className="text-label text-muted-foreground uppercase">
                {t('Income')}
              </div>
              <div className="text-xl font-medium text-olive">
                <NumberFormat value={finance.annualEsoda} showZero />
              </div>
            </div>
            <div>
              <div className="text-label text-muted-foreground uppercase">
                {t('Expenses')}
              </div>
              <div className="text-xl font-medium text-oxide">
                <NumberFormat value={finance.annualEksoda} showZero />
              </div>
            </div>
            <div>
              <div className="text-label text-muted-foreground uppercase">
                {t('Net')}
              </div>
              <div
                className={cn(
                  'text-xl font-semibold',
                  finance.net >= 0 ? 'text-olive' : 'text-oxide'
                )}
              >
                <NumberFormat value={finance.net} showZero />
              </div>
            </div>
          </div>
        </div>
        {finance.annualEksoda > 0 && (
          <div className="mt-3 pt-3 border-t border-stone-line/60 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-muted-foreground">
            <div>
              {t('Recurring')} ×12:{' '}
              <NumberFormat value={finance.recurringMonthlyEksoda * 12} showZero />
            </div>
            <div>
              {t('One-time')}: <NumberFormat value={finance.oneTimeEksoda} showZero />
            </div>
            <div>
              {t('Repairs')}: <NumberFormat value={finance.repairEksoda} showZero />
            </div>
            <div>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="border-b border-dotted border-muted-foreground/50 cursor-help">
                      {t('Owner expenses')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                    {t(
                      'Includes fixed owner-only expenses, owner-portion of repairs, and direct owner monthly entries.'
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              :{' '}
              <NumberFormat value={finance.ownerEksoda} showZero />
            </div>
          </div>
        )}
      </Card>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold">{stats.total}</div>
          <div className="text-sm text-muted-foreground">{t('Total units')}</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold text-green-600">
            {stats.rented}
          </div>
          <div className="text-sm text-muted-foreground">{t('Rented')}</div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">
            {stats.ownerOccupied}
          </div>
          <div className="text-sm text-muted-foreground">
            {t('Owner occupied')}
          </div>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-bold text-muted-foreground">
            {stats.vacant + stats.parking}
          </div>
          <div className="text-sm text-muted-foreground">
            {t('Vacant / Parking')}
          </div>
        </Card>
      </div>

      {/* Floor-by-floor table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">{t('Floor')}</TableHead>
              <TableHead className="w-[80px]">{t('m²')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead>{t('Owner')}</TableHead>
              <TableHead>{t('Tenant / Occupant')}</TableHead>
              <TableHead className="text-right">{t('Rent')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from(floorSummary.entries()).map(([floor, units]) =>
              units.map((unit, idx) => {
                const occupancy = unit.occupancyType || 'vacant';
                const property = unit.propertyId
                  ? propertyMap.get(
                      typeof unit.propertyId === 'string'
                        ? unit.propertyId
                        : unit.propertyId?._id
                    )
                  : null;
                const tenantInfo = property
                  ? tenantByPropertyId.get(property._id)
                  : null;

                // Determine effective occupancy
                let effectiveOccupancy = occupancy;
                if (
                  occupancy === 'vacant' &&
                  tenantInfo
                ) {
                  effectiveOccupancy = 'rented';
                }

                // Owner display
                const ownerName =
                  unit.owners?.length > 0
                    ? unit.owners
                        .map(
                          (o) =>
                            `${o.name || ''} ${o.percentage < 100 ? `(${o.percentage}%)` : ''}`.trim()
                        )
                        .join(', ')
                    : '—';

                // Tenant/occupant display
                let occupantDisplay = '';
                if (effectiveOccupancy === 'rented' && tenantInfo) {
                  occupantDisplay = tenantInfo.name;
                } else if (effectiveOccupancy === 'owner_occupied') {
                  occupantDisplay = ownerName;
                } else if (
                  effectiveOccupancy === 'parking' &&
                  unit.parkingAssignedTo?.length > 0
                ) {
                  occupantDisplay = unit.parkingAssignedTo
                    .map((id) => tenantById.get(id)?.name || id)
                    .join(', ');
                }

                // Rent display — use NumberFormat so currency follows the
                // realm locale (€ in el-GR, $ in en-US, etc.) instead of
                // being hardcoded.
                const rentDisplay =
                  effectiveOccupancy === 'rented' && tenantInfo?.rent ? (
                    <NumberFormat value={Number(tenantInfo.rent)} />
                  ) : (
                    ''
                  );

                return (
                  <TableRow
                    key={unit._id}
                    className={cn(
                      OCCUPANCY_CONFIG[effectiveOccupancy]?.bgColor
                    )}
                  >
                    <TableCell className="font-medium">
                      {idx === 0 ? <FloorLabel floor={floor} /> : ''}
                    </TableCell>
                    <TableCell>{unit.surface || '—'}</TableCell>
                    <TableCell>
                      <OccupancyBadge type={effectiveOccupancy} />
                    </TableCell>
                    <TableCell className="text-sm">{ownerName}</TableCell>
                    <TableCell className="font-medium">
                      {occupantDisplay}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {rentDisplay}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
            {sortedUnits.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  {t('No units registered. Import an E9 or add units manually.')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
