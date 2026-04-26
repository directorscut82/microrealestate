import {
  addBuildingRepair,
  QueryKeys,
  removeBuildingRepair,
  updateBuildingRepair
} from '../../utils/restcalls';
import { LuPencil, LuPlusCircle, LuTrash2 } from 'react-icons/lu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import ConfirmDialog from '../ConfirmDialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import NumberFormat from '../NumberFormat';
import ResponsiveDialog from '../ResponsiveDialog';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const repairCategories = [
  'plumbing',
  'electrical',
  'elevator',
  'roof',
  'facade',
  'heating',
  'doors_windows',
  'painting',
  'flooring',
  'general',
  'other'
];

const repairStatuses = ['scheduled', 'in_progress', 'completed', 'cancelled'];

const repairUrgencies = ['emergency', 'normal', 'low'];

const schema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1),
  status: z.string().min(1),
  urgency: z.string().min(1),
  estimatedCost: z.coerce.number().min(0).optional(),
  actualCost: z.coerce.number().min(0).optional(),
  notes: z.string().optional()
});

function getStatusBadgeVariant(status) {
  switch (status) {
    case 'scheduled':
      return 'secondary';
    case 'in_progress':
      return 'default';
    case 'completed':
      return 'success';
    case 'cancelled':
      return 'destructive';
    default:
      return 'secondary';
  }
}

export default function RepairList({ building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [openDialog, setOpenDialog] = useState(false);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [selectedRepair, setSelectedRepair] = useState(null);

  const repairs = building?.repairs || [];

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingRepair(building._id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
      toast.success(t('Repair added'));
    }
  });

  const updateMutation = useMutation({
    mutationFn: (data) => updateBuildingRepair(building._id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
      toast.success(t('Repair updated'));
    }
  });

  const removeMutation = useMutation({
    mutationFn: (repairId) => removeBuildingRepair(building._id, repairId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
      toast.success(t('Repair removed'));
    }
  });

  const initialValues = useMemo(
    () => ({
      title: selectedRepair?.title || '',
      description: selectedRepair?.description || '',
      category: selectedRepair?.category || 'general',
      status: selectedRepair?.status || 'scheduled',
      urgency: selectedRepair?.urgency || 'normal',
      estimatedCost: selectedRepair?.estimatedCost || '',
      actualCost: selectedRepair?.actualCost || '',
      notes: selectedRepair?.notes || ''
    }),
    [selectedRepair]
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    values: initialValues
  });

  const category = watch('category');
  const status = watch('status');
  const urgency = watch('urgency');

  const handleAdd = useCallback(() => {
    setSelectedRepair(null);
    reset();
    setOpenDialog(true);
  }, [reset]);

  const handleEdit = useCallback((repair) => {
    setSelectedRepair(repair);
    setOpenDialog(true);
  }, []);

  const handleDelete = useCallback((repair) => {
    setSelectedRepair(repair);
    setOpenConfirmDelete(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    try {
      await removeMutation.mutateAsync(selectedRepair._id);
    } catch (error) {
      toast.error(t('Failed to remove repair'));
    }
  }, [selectedRepair, removeMutation, t]);

  const handleClose = useCallback(() => {
    setOpenDialog(false);
    setSelectedRepair(null);
    reset();
  }, [reset]);

  const onSubmit = useCallback(
    async (data) => {
      try {
        if (selectedRepair?._id) {
          await updateMutation.mutateAsync({
            ...data,
            _id: selectedRepair._id
          });
        } else {
          await addMutation.mutateAsync(data);
        }
        handleClose();
      } catch (error) {
        toast.error(t('Something went wrong'));
      }
    },
    [selectedRepair, addMutation, updateMutation, handleClose, t]
  );

  return (
    <>
      <div className="flex justify-end mb-4">
        <Button
          variant="secondary"
          onClick={handleAdd}
          className="gap-2"
          data-cy="addRepair"
        >
          <LuPlusCircle className="size-4" />
          {t('Add repair')}
        </Button>
      </div>

      {repairs.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Title')}</TableHead>
              <TableHead>{t('Category')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead>{t('Urgency')}</TableHead>
              <TableHead className="text-right">
                {t('Estimated Cost')}
              </TableHead>
              <TableHead className="text-right">{t('Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repairs.map((repair) => (
              <TableRow key={repair._id}>
                <TableCell className="font-medium">{repair.title}</TableCell>
                <TableCell>{t(repair.category)}</TableCell>
                <TableCell>
                  <Badge variant={getStatusBadgeVariant(repair.status)}>
                    {t(repair.status)}
                  </Badge>
                </TableCell>
                <TableCell>{t(repair.urgency)}</TableCell>
                <TableCell className="text-right">
                  <NumberFormat value={repair.estimatedCost || 0} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(repair)}
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(repair)}
                    >
                      <LuTrash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          {t('No repairs found')}
        </div>
      )}

      <ResponsiveDialog
        open={openDialog}
        setOpen={setOpenDialog}
        renderHeader={() =>
          selectedRepair ? t('Edit repair') : t('Add repair')
        }
        renderContent={() => (
          <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">{t('Title')}</Label>
                <Input id="title" {...register('title')} />
                {errors.title && (
                  <p className="text-sm text-destructive">
                    {errors.title.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">{t('Description')}</Label>
                <Textarea
                  id="description"
                  {...register('description')}
                  rows={3}
                />
              </div>

              <div className="sm:flex sm:gap-2">
                <div className="space-y-2 flex-1">
                  <Label>{t('Category')}</Label>
                  <Select
                    value={category}
                    onValueChange={(val) => setValue('category', val)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {repairCategories.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {t(cat)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.category && (
                    <p className="text-sm text-destructive">
                      {errors.category.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2 flex-1">
                  <Label>{t('Status')}</Label>
                  <Select
                    value={status}
                    onValueChange={(val) => setValue('status', val)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {repairStatuses.map((st) => (
                        <SelectItem key={st} value={st}>
                          {t(st)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2 flex-1">
                  <Label>{t('Urgency')}</Label>
                  <Select
                    value={urgency}
                    onValueChange={(val) => setValue('urgency', val)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {repairUrgencies.map((urg) => (
                        <SelectItem key={urg} value={urg}>
                          {t(urg)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="sm:flex sm:gap-2">
                <div className="space-y-2 flex-1">
                  <Label htmlFor="estimatedCost">{t('Estimated Cost')}</Label>
                  <Input
                    id="estimatedCost"
                    type="number"
                    {...register('estimatedCost')}
                  />
                </div>

                <div className="space-y-2 flex-1">
                  <Label htmlFor="actualCost">{t('Actual Cost')}</Label>
                  <Input
                    id="actualCost"
                    type="number"
                    {...register('actualCost')}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">{t('Notes')}</Label>
                <Textarea id="notes" {...register('notes')} rows={3} />
              </div>
            </div>
          </form>
        )}
        renderFooter={() => (
          <>
            <Button variant="outline" onClick={handleClose}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleSubmit(onSubmit)}
              disabled={isSubmitting}
              data-cy="submitRepair"
            >
              {selectedRepair ? t('Update') : t('Add')}
            </Button>
          </>
        )}
      />

      <ConfirmDialog
        title={t('Are you sure to remove this repair?')}
        subTitle={selectedRepair?.title}
        open={openConfirmDelete}
        setOpen={setOpenConfirmDelete}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
