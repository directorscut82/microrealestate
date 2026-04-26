import {
  addBuildingUnit,
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
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import ConfirmDialog from '../ConfirmDialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import ResponsiveDialog from '../ResponsiveDialog';
import { Switch } from '../ui/switch';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const unitSchema = z.object({
  atakNumber: z.string().min(1),
  floor: z.union([z.string(), z.number()]).optional(),
  unitLabel: z.string().optional(),
  surface: z.union([z.string(), z.number()]).optional(),
  generalThousandths: z.union([z.string(), z.number()]).optional(),
  heatingThousandths: z.union([z.string(), z.number()]).optional(),
  elevatorThousandths: z.union([z.string(), z.number()]).optional(),
  isManaged: z.boolean(),
  propertyId: z.string().optional()
});

function UnitFormDialog({ open, setOpen, unit, buildingId }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingUnit(buildingId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    }
  });

  const updateMutation = useMutation({
    mutationFn: (data) =>
      updateBuildingUnit(buildingId, { ...data, _id: unit._id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    }
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
      atakNumber: unit?.atakNumber || '',
      floor: unit?.floor || '',
      unitLabel: unit?.unitLabel || '',
      surface: unit?.surface || '',
      generalThousandths: unit?.generalThousandths || '',
      heatingThousandths: unit?.heatingThousandths || '',
      elevatorThousandths: unit?.elevatorThousandths || '',
      isManaged: unit?.isManaged ?? true,
      propertyId: unit?.propertyId || ''
    }
  });

  const isManaged = watch('isManaged');

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
        console.error(error);
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
              <Label htmlFor="propertyId">{t('Property ID (optional)')}</Label>
              <Input id="propertyId" {...register('propertyId')} />
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
      console.error(error);
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
                <TableCell>{unit.atakNumber}</TableCell>
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
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteUnit(unit)}
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
