import {
  addBuildingUnit,
  fetchProperties,
  QueryKeys,
  removeBuildingUnit,
  updateBuildingUnit
} from '../../utils/restcalls';
import { LuPencil, LuPlusCircle, LuTrash } from 'react-icons/lu';
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
import { useForm } from 'react-hook-form';
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
  propertyId: z.string().trim().max(60).optional()
});

const OCCUPANCY_TYPES = [
  { value: 'rented', labelKey: 'rented' },
  { value: 'owner_occupied', labelKey: 'owner_occupied' },
  { value: 'vacant', labelKey: 'vacant' },
  { value: 'parking', labelKey: 'parking' }
];

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
      propertyId: ''
    },
    values: unit
      ? {
          ...unit,
          isManaged: unit.isManaged ?? true,
          occupancyType: unit.occupancyType || 'vacant'
        }
      : undefined
  });

  const isManaged = watch('isManaged');
  const occupancyType = watch('occupancyType');
  const propertyIdValue = watch('propertyId');

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
            <div className="space-y-2">
              <Label htmlFor="occupancyType">{t('Occupancy type')}</Label>
              <Select
                value={occupancyType}
                onValueChange={(val) => setValue('occupancyType', val)}
              >
                <SelectTrigger id="occupancyType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OCCUPANCY_TYPES.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {t(opt.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-label text-ink-muted">
                {t(
                  'Mark a unit as owner-occupied to track owner expenses and exclude from occupancy rate.'
                )}
              </p>
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
  const queryClient = useQueryClient();
  const [openUnitDialog, setOpenUnitDialog] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [unitToDelete, setUnitToDelete] = useState(null);

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
            {units.map((unit) => (
              <TableRow key={unit._id}>
                <TableCell>
                  {[unit.atakNumber, ...(unit.altAtakNumbers || [])]
                    .join(', ')}
                </TableCell>
                <TableCell>{unit.floor ?? '-'}</TableCell>
                <TableCell>{unit.surface || '-'}</TableCell>
                <TableCell>{unit.generalThousandths || 0}</TableCell>
                <TableCell>
                  {unit.property?.name || unit.propertyId || '-'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEditUnit(unit)}
                    aria-label={t('Edit')}
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteUnit(unit)}
                    aria-label={t('Delete')}
                    >
                      <LuTrash className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
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
