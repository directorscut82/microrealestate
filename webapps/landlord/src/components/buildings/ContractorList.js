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

// Must stay a subset of VALID_CONTRACTOR_SPECIALTIES (buildingmanager.ts) and
// of the schema enum (services/common/src/collections/building.ts). The two
// legacy values that enum still accepts — 'plumbing' / 'electrical' — are
// deliberately NOT offered here because they duplicate 'plumber' /
// 'electrician'; a contractor already stored with one is appended to the
// option list at edit time (specialtyOptions below) so the Select shows the
// stored value instead of rendering blank.
const contractorSpecialties = [
  'plumber',
  'electrician',
  'elevator',
  'painter',
  'locksmith',
  'hvac',
  'carpenter',
  'mason',
  'gardener',
  'cleaner',
  'general',
  'other'
];

const baseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  company: z.string().trim().max(200).optional(),
  specialty: z.string().trim().min(1).max(60),
  phone: z.string().trim().max(60).optional(),
  email: z
    .string()
    .trim()
    .email()
    .max(200)
    .or(z.literal(''))
    .optional(),
  taxId: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(2000).optional()
});

export default function ContractorList({ building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [openDialog, setOpenDialog] = useState(false);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [selectedContractor, setSelectedContractor] = useState(null);

  const contractors = useMemo(
    () => building?.contractors || [],
    [building?.contractors]
  );

  // Two contractors with the SAME name+specialty render two literally
  // identical options in the repair-assignment dropdown, so the landlord
  // cannot tell which one a repair's cost lands on. Reject the duplicate at
  // entry rather than after the fact. The company disambiguates, so a genuine
  // second contractor of the same name and trade is still recordable by
  // filling it in — only name+specialty+company matching is a true duplicate.
  // taxId, when present, must be unique on its own: one ΑΦΜ is one legal
  // contractor.
  const duplicateSchema = useMemo(
    () =>
      baseSchema.superRefine((data, ctx) => {
        const _norm = (v) => String(v || '').trim().toLowerCase();
        const others = contractors.filter(
          (c) => c._id !== selectedContractor?._id
        );
        const sameIdentity = others.some(
          (c) =>
            _norm(c.name) === _norm(data.name) &&
            _norm(c.specialty) === _norm(data.specialty) &&
            _norm(c.company) === _norm(data.company)
        );
        if (sameIdentity) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['name'],
            message: t(
              'A contractor with this name and specialty already exists on this building'
            )
          });
        }
        if (_norm(data.taxId)) {
          const sameTaxId = others.some(
            (c) => _norm(c.taxId) === _norm(data.taxId)
          );
          if (sameTaxId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['taxId'],
              message: t('A contractor with this Tax ID already exists')
            });
          }
        }
      }),
    [contractors, selectedContractor?._id, t]
  );

  // Contractors are linked to repairs, which can roll into the building's
  // recurring expense ledger (e.g. repairs_fund). Invalidate the rent stack
  // so any payment dialog reflects updated allocations after a contractor
  // edit. Mirrors the building / repair / expense pattern.
  const _invalidateAllContractorDependents = () => {
    queryClient.invalidateQueries({
      queryKey: [QueryKeys.BUILDINGS, building._id]
    });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
  };

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingContractor(building._id, data),
    onSuccess: () => {
      _invalidateAllContractorDependents();
      toast.success(t('Contractor added'));
    }
  });

  const updateMutation = useMutation({
    mutationFn: (data) => updateBuildingContractor(building._id, data),
    onSuccess: () => {
      _invalidateAllContractorDependents();
      toast.success(t('Contractor updated'));
    }
  });

  const removeMutation = useMutation({
    mutationFn: (contractorId) =>
      removeBuildingContractor(building._id, contractorId),
    onSuccess: () => {
      _invalidateAllContractorDependents();
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
    resolver: zodResolver(duplicateSchema),
    defaultValues: initialValues,
    values: initialValues
  });

  const specialty = watch('specialty');

  // A contractor stored with a value the picker does not offer (a legacy
  // 'plumbing'/'electrical' import) must still show its own value — Radix
  // renders an EMPTY trigger when no SelectItem matches, which reads as "no
  // specialty" and silently rewrites the field on the next save. Append the
  // stored value so it is always selectable.
  const specialtyOptions = useMemo(() => {
    if (specialty && !contractorSpecialties.includes(specialty)) {
      return [...contractorSpecialties, specialty];
    }
    return contractorSpecialties;
  }, [specialty]);

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
        // The server repeats the duplicate check (every endpoint is callable
        // directly, and a second tab can create the twin between this form's
        // render and its save). Surface its 422 instead of the generic toast,
        // otherwise the user cannot tell a duplicate from a network failure.
        if (error?.response?.status === 422) {
          toast.error(
            t(
              'A contractor with this name and specialty already exists on this building'
            )
          );
        } else {
          toast.error(t('Something went wrong'));
        }
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
                    aria-label={t('Edit')}
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(contractor)}
                    aria-label={t('Delete')}
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
                    <SelectValue placeholder={t('Select a specialty')} />
                  </SelectTrigger>
                  <SelectContent>
                    {specialtyOptions.map((spec) => (
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
                {errors.taxId && (
                  <p className="text-sm text-destructive">
                    {errors.taxId.message}
                  </p>
                )}
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
