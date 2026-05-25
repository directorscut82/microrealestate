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
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { cn } from '../../utils';
import { LuBuilding2, LuCar, LuHome, LuUser } from 'react-icons/lu';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

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
  // Eksoda = sum of recurring building expenses (×12) + one-time expenses
  //          + sum of repair actualCost/estimatedCost + sum of all owner
  //          monthly expense entries already recorded.
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

    const recurringMonthlyEksoda = (building?.expenses || [])
      .filter((e) => e.isRecurring && e.amount > 0)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const oneTimeEksoda = (building?.expenses || [])
      .filter((e) => !e.isRecurring && e.amount > 0)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const repairEksoda = (building?.repairs || [])
      .filter((r) => r.status !== 'cancelled')
      .reduce(
        (sum, r) => sum + (Number(r.actualCost) || Number(r.estimatedCost) || 0),
        0
      );
    const ownerEksoda = (building?.ownerMonthlyExpenses || []).reduce(
      (sum, e) => sum + (Number(e.amount) || 0),
      0
    );

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
    building?.repairs,
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
          <div className="grid grid-cols-3 gap-6 text-right font-mono tabular-nums">
            <div>
              <div className="text-label text-muted-foreground uppercase">
                {t('Income')}
              </div>
              <div className="text-xl font-medium text-olive">
                €{finance.annualEsoda.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-label text-muted-foreground uppercase">
                {t('Expenses')}
              </div>
              <div className="text-xl font-medium text-oxide">
                €{finance.annualEksoda.toFixed(2)}
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
                €{finance.net.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
        {finance.annualEksoda > 0 && (
          <div className="mt-3 pt-3 border-t border-stone-line/60 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-muted-foreground">
            <div>
              {t('Recurring')} ×12: €{(finance.recurringMonthlyEksoda * 12).toFixed(2)}
            </div>
            <div>
              {t('One-time')}: €{finance.oneTimeEksoda.toFixed(2)}
            </div>
            <div>
              {t('Repairs')}: €{finance.repairEksoda.toFixed(2)}
            </div>
            <div>
              {t('Owner expenses')}: €{finance.ownerEksoda.toFixed(2)}
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

                // Rent display
                const rentDisplay =
                  effectiveOccupancy === 'rented' && tenantInfo?.rent
                    ? `€${tenantInfo.rent}`
                    : '';

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
