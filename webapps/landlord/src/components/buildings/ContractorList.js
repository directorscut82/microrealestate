import {
  addBuildingContractor,
  QueryKeys,
  removeBuildingContractor,
  updateBuildingContractor
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
import { Button } from '../ui/button';
import ConfirmDialog from '../ConfirmDialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import ResponsiveDialog from '../ResponsiveDialog';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const contractorSpecialties = [
  'plumber',
  'electrician',
  'elevator',
  'painter',
  'locksmith',
  'hvac',
  'general',
  'other'
];

const schema = z.object({
  name: z.string().min(1),
  company: z.string().optional(),
  specialty: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().optional(),
  taxId: z.string().optional(),
  notes: z.string().optional()
});

export default function ContractorList({ building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [openDialog, setOpenDialog] = useState(false);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [selectedContractor, setSelectedContractor] = useState(null);

  const contractors = building?.contractors || [];

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingContractor(building._id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
      toast.success(t('Contractor added'));
    }
  });

  const updateMutation = useMutation({
    mutationFn: (data) => updateBuildingContractor(building._id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
      toast.success(t('Contractor updated'));
    }
  });

  const removeMutation = useMutation({
    mutationFn: (contractorId) =>
      removeBuildingContractor(building._id, contractorId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building._id]
      });
      toast.success(t('Contractor removed'));
    }
  });

  const initialValues = useMemo(
    () => ({
      name: selectedContractor?.name || '',
      company: selectedContractor?.company || '',
      specialty: selectedContractor?.specialty || 'general',
      phone: selectedContractor?.phone || '',
      email: selectedContractor?.email || '',
      taxId: selectedContractor?.taxId || '',
      notes: selectedContractor?.notes || ''
    }),
    [selectedContractor]
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

  const specialty = watch('specialty');

  const handleAdd = useCallback(() => {
    setSelectedContractor(null);
    reset();
    setOpenDialog(true);
  }, [reset]);

  const handleEdit = useCallback((contractor) => {
    setSelectedContractor(contractor);
    setOpenDialog(true);
  }, []);

  const handleDelete = useCallback((contractor) => {
    setSelectedContractor(contractor);
    setOpenConfirmDelete(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    try {
      await removeMutation.mutateAsync(selectedContractor._id);
    } catch (error) {
      const status = error?.response?.status;
      if (status === 422) {
        toast.error(
          t('Contractor cannot be removed because they are linked to repairs')
        );
      } else {
        toast.error(t('Failed to remove contractor'));
      }
    }
  }, [selectedContractor, removeMutation, t]);

  const handleClose = useCallback(() => {
    setOpenDialog(false);
    setSelectedContractor(null);
    reset();
  }, [reset]);

  const onSubmit = useCallback(
    async (data) => {
      try {
        if (selectedContractor?._id) {
          await updateMutation.mutateAsync({
            ...data,
            _id: selectedContractor._id
          });
        } else {
          await addMutation.mutateAsync(data);
        }
        handleClose();
      } catch (error) {
        toast.error(t('Something went wrong'));
      }
    },
    [selectedContractor, addMutation, updateMutation, handleClose, t]
  );

  return (
    <>
      <div className="flex justify-end mb-4">
        <Button
          variant="secondary"
          onClick={handleAdd}
          className="gap-2"
          data-cy="addContractor"
        >
          <LuPlusCircle className="size-4" />
          {t('Add contractor')}
        </Button>
      </div>

      {contractors.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Name')}</TableHead>
              <TableHead>{t('Company')}</TableHead>
              <TableHead>{t('Specialty')}</TableHead>
              <TableHead>{t('Phone')}</TableHead>
              <TableHead>{t('Email')}</TableHead>
              <TableHead className="text-right">{t('Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contractors.map((contractor) => (
              <TableRow key={contractor._id}>
                <TableCell className="font-medium">{contractor.name}</TableCell>
                <TableCell>{contractor.company || '-'}</TableCell>
                <TableCell>{t(contractor.specialty)}</TableCell>
                <TableCell>{contractor.phone || '-'}</TableCell>
                <TableCell>{contractor.email || '-'}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(contractor)}
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(contractor)}
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
          {t('No contractors found')}
        </div>
      )}

      <ResponsiveDialog
        open={openDialog}
        setOpen={setOpenDialog}
        renderHeader={() =>
          selectedContractor ? t('Edit contractor') : t('Add contractor')
        }
        renderContent={() => (
          <form onSubmit={handleSubmit(onSubmit)} autoComplete="off">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">{t('Name')}</Label>
                <Input id="name" {...register('name')} />
                {errors.name && (
                  <p className="text-sm text-destructive">
                    {errors.name.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="company">{t('Company')}</Label>
                <Input id="company" {...register('company')} />
              </div>

              <div className="space-y-2">
                <Label>{t('Specialty')}</Label>
                <Select
                  value={specialty}
                  onValueChange={(val) => setValue('specialty', val)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {contractorSpecialties.map((spec) => (
                      <SelectItem key={spec} value={spec}>
                        {t(spec)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.specialty && (
                  <p className="text-sm text-destructive">
                    {errors.specialty.message}
                  </p>
                )}
              </div>

              <div className="sm:flex sm:gap-2">
                <div className="space-y-2 flex-1">
                  <Label htmlFor="phone">{t('Phone')}</Label>
                  <Input id="phone" {...register('phone')} />
                </div>

                <div className="space-y-2 flex-1">
                  <Label htmlFor="email">{t('Email')}</Label>
                  <Input id="email" type="email" {...register('email')} />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="taxId">{t('Tax ID')}</Label>
                <Input id="taxId" {...register('taxId')} />
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
              data-cy="submitContractor"
            >
              {selectedContractor ? t('Update') : t('Add')}
            </Button>
          </>
        )}
      />

      <ConfirmDialog
        title={t('Are you sure to remove this contractor?')}
        subTitle={selectedContractor?.name}
        open={openConfirmDelete}
        setOpen={setOpenConfirmDelete}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
