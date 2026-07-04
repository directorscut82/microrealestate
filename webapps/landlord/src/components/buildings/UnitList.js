import {
  addBuildingUnit,
  fetchProperties,
  fetchTenants,
  QueryKeys,
  removeBuildingUnit,
  updateBuildingUnit
} from '../../utils/restcalls';
import { LuPencil, LuPlusCircle, LuTrash } from 'react-icons/lu';
import { useRouter } from 'next/router';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import ConfirmDialog from '../ConfirmDialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import ResponsiveDialog from '../ResponsiveDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Switch } from '../ui/switch';
import { toast } from 'sonner';
import { useFieldArray, useForm } from 'react-hook-form';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const optionalNumber = (min, max) =>
  z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().min(min).max(max).optional()
  );

const unitSchema = z.object({
  atakNumber: z.string().trim().min(1).max(60),
  // Wave-24 A15: align with API min/max (-5..200). The previous UI cap of
  // 50 floors meant edits at higher floors silently failed validation
  // server-side; the basement min was outside the API range entirely.
  floor: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().int().min(-5).max(200).optional()
  ),
  unitLabel: z.string().trim().max(120).optional(),
  surface: optionalNumber(0, 1000000),
  generalThousandths: optionalNumber(0, 1000),
  heatingThousandths: optionalNumber(0, 1000),
  elevatorThousandths: optionalNumber(0, 1000),
  isManaged: z.boolean(),
  occupancyType: z
    .enum(['rented', 'owner_occupied', 'vacant', 'parking'])
    .optional(),
  propertyId: z.string().trim().max(60).optional(),
  // Manual co-owner editor — name (required) + optional ΑΦΜ + % (0..100). The
  // E9 import only carries the filer's own share, so the landlord adds the
  // co-owner here. Sum is validated server-side (≤ 100); the UI shows a hint.
  owners: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Name is required').max(120),
        taxId: z.string().trim().max(20).optional().or(z.literal('')),
        percentage: z.coerce.number().min(0).max(100)
      })
    )
    .optional()
});

// Wave-24 B4: turn propertyId from a free-text 24-hex input into a Select
// over the realm's properties. The previous UX required the user to paste
// an ObjectId which they had no way to find from the UI.
const UNLINKED_VALUE = '__unlinked__';

function UnitFormDialog({ open, setOpen, unit, buildingId }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const { data: properties } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties
  });
  const propertyOptions = useMemo(
    () =>
      (properties || [])
        .map((p) => ({
          id: p._id,
          label: `${p.name || p.atakNumber || p._id}${p.atakNumber ? ` (${p.atakNumber})` : ''}`
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [properties]
  );

  // Unit thousandths feed expense allocations and rent computation —
  // editing a unit invalidates rent caches, not just the building view.
  const _invalidateAllUnitDependents = () => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS, buildingId] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
    // B-B: changing a unit's occupancyType/thousandths re-routes owner-expense
    // allocation, so the owner ledger, ΧΡΕΩΣΕΙΣ breakdown and accounting/xlsx
    // must refetch too — mirrors ExpenseList/RepairList/BuildingExpensePanel.
    // Without these three, the owner tab / breakdown / Τιμολόγια showed stale
    // money until a hard reload.
    queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
    queryClient.invalidateQueries({ queryKey: ['expense-breakdown'] });
  };

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingUnit(buildingId, data),
    onSuccess: _invalidateAllUnitDependents
  });

  const updateMutation = useMutation({
    mutationFn: (data) =>
      updateBuildingUnit(buildingId, { ...data, _id: unit._id }),
    onSuccess: _invalidateAllUnitDependents
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    control,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(unitSchema),
    defaultValues: {
      atakNumber: '',
      floor: '',
      unitLabel: '',
      surface: '',
      generalThousandths: '',
      heatingThousandths: '',
      elevatorThousandths: '',
      isManaged: true,
      occupancyType: 'vacant',
      propertyId: '',
      owners: []
    },
    values: unit
      ? {
          ...unit,
          isManaged: unit.isManaged ?? true,
          occupancyType: unit.occupancyType || 'vacant',
          // normalise existing owners to the form shape (name/taxId/percentage)
          owners: (unit.owners || []).map((o) => ({
            name: o.name || '',
            taxId: o.taxId || '',
            percentage:
              o.percentage === undefined || o.percentage === null
                ? 100
                : o.percentage
          }))
        }
      : undefined
  });

  const {
    fields: ownerFields,
    append: appendOwner,
    remove: removeOwner
  } = useFieldArray({ control, name: 'owners' });

  const isManaged = watch('isManaged');
  const occupancyType = watch('occupancyType');
  const propertyIdValue = watch('propertyId');
  const ownersValue = watch('owners');

  // Occupancy detection: is THIS unit's property rented by an active tenant?
  // Same rule the dashboard uses (BuildingDashboard tenantByPropertyId): skip
  // terminated / archived tenants so a moved-out tenant doesn't count. Used to
  // DISABLE the «Ιδιοκατοίκηση» switch — an owner cannot occupy a unit a tenant
  // is renting (the server enforces the same guard, this is the UX surface).
  const { data: tenantsForOcc } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: () => fetchTenants()
  });
  const isOccupiedByTenant = useMemo(() => {
    const pid = unit?.propertyId ? String(unit.propertyId) : null;
    if (!pid) return false;
    const list = Array.isArray(tenantsForOcc)
      ? tenantsForOcc
      : tenantsForOcc?.pages?.flatMap((p) => p.data || p) || [];
    return list.some(
      (tn) =>
        !tn?.terminated &&
        !tn?.archived &&
        (tn?.properties || []).some((tp) => String(tp.propertyId) === pid)
    );
  }, [tenantsForOcc, unit?.propertyId]);
  const isOwnerOccupied = occupancyType === 'owner_occupied';
  const ownersPctSum = (ownersValue || []).reduce(
    (s, o) => s + (Number(o?.percentage) || 0),
    0
  );

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const onSubmit = useCallback(
    async (data) => {
      try {
        setIsLoading(true);
        if (unit?._id) {
          await updateMutation.mutateAsync(data);
        } else {
          await addMutation.mutateAsync(data);
        }
        handleClose();
      } catch (error) {
        toast.error(t('Something went wrong'));
      } finally {
        setIsLoading(false);
      }
    },
    [unit, addMutation, updateMutation, handleClose, t]
  );

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => (unit?._id ? t('Edit Unit') : t('Add Unit'))}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(onSubmit)}
          autoComplete="off"
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="atakNumber">{t('ATAK Number')}</Label>
              <Input id="atakNumber" {...register('atakNumber')} />
              {errors.atakNumber && (
                <p className="text-sm text-destructive">
                  {errors.atakNumber.message}
                </p>
              )}
            </div>
            <div className="sm:flex sm:gap-2">
              <div className="space-y-2 flex-1">
                <Label htmlFor="floor">{t('Floor')}</Label>
                <Input id="floor" type="number" {...register('floor')} />
              </div>
              <div className="space-y-2 flex-1">
                <Label htmlFor="unitLabel">{t('Unit Label')}</Label>
                <Input id="unitLabel" {...register('unitLabel')} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="surface">{t('Surface (m²)')}</Label>
              <Input id="surface" type="number" {...register('surface')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="generalThousandths">
                {t('General Thousandths')}
              </Label>
              <Input
                id="generalThousandths"
                type="number"
                step="0.01"
                {...register('generalThousandths')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="heatingThousandths">
                {t('Heating Thousandths')}
              </Label>
              <Input
                id="heatingThousandths"
                type="number"
                step="0.01"
                {...register('heatingThousandths')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="elevatorThousandths">
                {t('Elevator Thousandths')}
              </Label>
              <Input
                id="elevatorThousandths"
                type="number"
                step="0.01"
                {...register('elevatorThousandths')}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="isManaged"
                checked={isManaged}
                onCheckedChange={(checked) => setValue('isManaged', checked)}
              />
              <Label htmlFor="isManaged">{t('Managed Unit')}</Label>
            </div>
            {/* Ιδιοκατοίκηση — a single switch, NOT a status dropdown. rented /
                vacant are DERIVED from tenant links (never hand-set); parking /
                storage are derived from property.type. The only occupancy state
                the landlord sets by hand is "an owner lives here". Disabled when
                the unit is rented — the server enforces the same guard. */}
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <Label htmlFor="ownerOccupied">{t('Owner occupied')}</Label>
                <p className="text-label text-ink-muted">
                  {isOccupiedByTenant
                    ? t('The unit is rented — end the lease first.')
                    : t(
                        'Turn on when an owner lives in this unit (no rent charged; owner pays the building-expense share).'
                      )}
                </p>
              </div>
              <Switch
                id="ownerOccupied"
                checked={isOwnerOccupied}
                disabled={isOccupiedByTenant}
                onCheckedChange={(checked) => {
                  if (checked) {
                    setValue('occupancyType', 'owner_occupied');
                  } else {
                    // Toggle OFF reverts to the derived state. Preserve a
                    // parking unit's type (parking is a space kind, not a status
                    // the switch owns); otherwise fall to 'vacant' (rented is
                    // re-derived server-side when a tenant is linked).
                    const original = unit?.occupancyType;
                    setValue(
                      'occupancyType',
                      original === 'parking' ? 'parking' : 'vacant'
                    );
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="propertyId">{t('Linked property')}</Label>
              <Select
                value={propertyIdValue || UNLINKED_VALUE}
                onValueChange={(val) =>
                  setValue('propertyId', val === UNLINKED_VALUE ? '' : val)
                }
              >
                <SelectTrigger id="propertyId">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNLINKED_VALUE}>
                    {t('(unlinked)')}
                  </SelectItem>
                  {propertyOptions.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Owners (co-owner editor). The E9 import carries only the
                filer's own share; add co-owners here so every owner is
                recorded. Percentages must sum to ≤ 100 (validated server-side;
                a hint shows the running total). */}
            <div className="space-y-2 pt-2 border-t border-stone-line/50">
              <div className="flex items-center justify-between">
                <Label>{t('Owners')}</Label>
                <span
                  className={
                    'text-label tabular-nums ' +
                    (ownersPctSum > 100.5
                      ? 'text-destructive'
                      : 'text-ink-muted')
                  }
                >
                  {t('Total')}: {Math.round(ownersPctSum * 10) / 10}%
                </span>
              </div>
              {ownerFields.length === 0 && (
                <p className="text-label text-ink-muted">
                  {t('No owners recorded yet.')}
                </p>
              )}
              {ownerFields.map((field, idx) => (
                <div key={field.id} className="flex items-start gap-2">
                  <div className="flex-1 space-y-1">
                    <Input
                      placeholder={t('Owner name')}
                      {...register(`owners.${idx}.name`)}
                    />
                    {errors.owners?.[idx]?.name && (
                      <p className="text-sm text-destructive">
                        {errors.owners[idx].name.message}
                      </p>
                    )}
                  </div>
                  <Input
                    className="w-32"
                    placeholder={t('Tax ID')}
                    {...register(`owners.${idx}.taxId`)}
                  />
                  <div className="w-20">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      placeholder="%"
                      {...register(`owners.${idx}.percentage`)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeOwner(idx)}
                    aria-label={t('Remove')}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  appendOwner({ name: '', taxId: '', percentage: 0 })
                }
              >
                + {t('Add co-owner')}
              </Button>
            </div>
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => formRef.current?.requestSubmit()}>
            {unit?._id ? t('Update') : t('Add')}
          </Button>
        </>
      )}
    />
  );
}

export default function UnitList({ building }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [openUnitDialog, setOpenUnitDialog] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [unitToDelete, setUnitToDelete] = useState(null);

  // data-001: the Property column used to fall back to `unit.propertyId`
  // (a raw 24-hex ObjectId) whenever the backend hadn't hydrated
  // `unit.property`. That happens for orphaned references (the linked
  // property was deleted) or any path that returns units without the
  // joined property. Resolve the name client-side from the realm's
  // property list; only when even that lookup fails do we show a clear
  // "deleted property" marker instead of leaking the ObjectId.
  const { data: properties } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties
  });
  const propertyNameById = useMemo(() => {
    const map = new Map();
    (properties || []).forEach((p) => {
      if (p?._id) map.set(String(p._id), p.name || p.atakNumber || null);
    });
    return map;
  }, [properties]);

  // Tier E1 — clicking a unit row navigates to the linked property's
  // detail page (the apartment view with the map). Only fires when the
  // unit is linked to a property; unlinked rows stay inert.
  const navigateToProperty = useCallback(
    (unit) => {
      if (!unit?.propertyId) return;
      router.push(
        `/${router.query.organization}/properties/${unit.propertyId}`
      );
    },
    [router]
  );

  const removeMutation = useMutation({
    mutationFn: (unitId) => removeBuildingUnit(building._id, unitId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
    }
  });

  const handleAddUnit = useCallback(() => {
    setSelectedUnit(null);
    setOpenUnitDialog(true);
  }, []);

  const handleEditUnit = useCallback((unit) => {
    setSelectedUnit(unit);
    setOpenUnitDialog(true);
  }, []);

  const handleDeleteUnit = useCallback((unit) => {
    setUnitToDelete(unit);
    setOpenConfirmDelete(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    try {
      await removeMutation.mutateAsync(unitToDelete._id);
    } catch (error) {
      toast.error(t('Something went wrong'));
    }
  }, [unitToDelete, removeMutation, t]);

  const units = building?.units || [];

  return (
    <div>
      <div className="mb-4">
        <Button
          variant="secondary"
          className="w-full gap-2 sm:w-fit"
          onClick={handleAddUnit}
          data-cy="addUnit"
        >
          <LuPlusCircle className="size-4" />
          {t('Add Unit')}
        </Button>
      </div>

      {units.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('ATAK')}</TableHead>
              <TableHead>{t('Floor')}</TableHead>
              <TableHead>{t('Surface m²')}</TableHead>
              <TableHead>{t('General ‰')}</TableHead>
              <TableHead>{t('Property')}</TableHead>
              <TableHead className="text-right">{t('Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {units.map((unit) => {
              const isLinked = !!unit.propertyId;
              return (
                <TableRow
                  key={unit._id}
                  data-cy="buildingUnitRow"
                  className={isLinked ? 'cursor-pointer hover:bg-muted/50' : undefined}
                  onClick={() => isLinked && navigateToProperty(unit)}
                >
                  <TableCell>
                    {[unit.atakNumber, ...(unit.altAtakNumbers || [])]
                      .join(', ')}
                  </TableCell>
                  <TableCell>{unit.floor ?? '-'}</TableCell>
                  <TableCell>{unit.surface || '-'}</TableCell>
                  <TableCell>{unit.generalThousandths || 0}</TableCell>
                  <TableCell>
                    {(() => {
                      // Prefer the hydrated join, then a client-side
                      // lookup over the realm's properties. Never render
                      // the raw ObjectId: a linked-but-unresolvable id
                      // means the property was deleted out from under the
                      // unit (orphan) — say so plainly.
                      const resolved =
                        unit.property?.name ||
                        (unit.propertyId &&
                          propertyNameById.get(String(unit.propertyId)));
                      if (resolved) return resolved;
                      if (unit.propertyId) {
                        return (
                          <span className="text-oxide italic">
                            {t('Linked property not found')}
                          </span>
                        );
                      }
                      return '-';
                    })()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditUnit(unit);
                        }}
                        aria-label={t('Edit')}
                      >
                        <LuPencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteUnit(unit);
                        }}
                        aria-label={t('Delete')}
                      >
                        <LuTrash className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <div className="text-muted-foreground text-center py-8">
          {t('No units added yet')}
        </div>
      )}

      <UnitFormDialog
        open={openUnitDialog}
        setOpen={setOpenUnitDialog}
        unit={selectedUnit}
        buildingId={building?._id}
      />

      <ConfirmDialog
        title={t('Are you sure to remove this unit?')}
        subTitle={unitToDelete?.atakNumber}
        open={openConfirmDelete}
        setOpen={setOpenConfirmDelete}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
