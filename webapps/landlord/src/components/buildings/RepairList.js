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
import { Separator } from '../ui/separator';
import { Switch } from '../ui/switch';
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

const chargeableToOptions = ['owners', 'tenants', 'split'];

const allocationMethods = [
  { id: 'general_thousandths', labelId: 'General Thousandths' },
  { id: 'heating_thousandths', labelId: 'Heating Thousandths' },
  { id: 'elevator_thousandths', labelId: 'Elevator Thousandths' },
  { id: 'equal', labelId: 'Equal' },
  { id: 'by_surface', labelId: 'By Surface' },
  { id: 'custom_ratio', labelId: 'Custom Ratio' },
  { id: 'custom_percentage', labelId: 'Custom Percentage' }
];

const schema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1),
  status: z.string().min(1),
  urgency: z.string().min(1),
  estimatedCost: z.coerce.number().min(0).optional(),
  actualCost: z.coerce.number().min(0).optional(),
  chargeableTo: z.string().min(1),
  tenantSharePercentage: z.coerce.number().min(0).max(100).optional(),
  allocationMethod: z.string().optional(),
  chargeTerm: z.string().optional(),
  contractorId: z.string().optional(),
  reportedDate: z.string().optional(),
  startDate: z.string().optional(),
  completionDate: z.string().optional(),
  isPaidFromRepairsFund: z.boolean().optional(),
  invoiceReference: z.string().optional(),
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

function getChargeableToBadge(chargeableTo) {
  switch (chargeableTo) {
    case 'tenants':
      return 'default';
    case 'owners':
      return 'secondary';
    case 'split':
      return 'outline';
    default:
      return 'secondary';
  }
}

function formatTerm(term) {
  if (!term) return '-';
  const str = String(term);
  if (str.length >= 8) {
    const year = str.substring(0, 4);
    const month = str.substring(4, 6);
    return `${month}/${year}`;
  }
  return str;
}

function getCurrentTerm() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}${month}0100`;
}

function generateTermOptions() {
  const options = [];
  const now = new Date();
  for (let i = -3; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const term = `${year}${month}0100`;
    const label = `${month}/${year}`;
    options.push({ term, label });
  }
  return options;
}

export default function RepairList({ building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [openDialog, setOpenDialog] = useState(false);
  const [openConfirmDelete, setOpenConfirmDelete] = useState(false);
  const [selectedRepair, setSelectedRepair] = useState(null);

  const repairs = building?.repairs || [];
  const contractors = building?.contractors || [];
  const termOptions = useMemo(() => generateTermOptions(), []);

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
      chargeableTo: selectedRepair?.chargeableTo || 'owners',
      tenantSharePercentage: selectedRepair?.tenantSharePercentage ?? 50,
      allocationMethod:
        selectedRepair?.allocationMethod || 'general_thousandths',
      chargeTerm: selectedRepair?.chargeTerm
        ? String(selectedRepair.chargeTerm)
        : getCurrentTerm(),
      contractorId: selectedRepair?.contractorId || '',
      reportedDate: selectedRepair?.reportedDate
        ? selectedRepair.reportedDate.substring(0, 10)
        : new Date().toISOString().substring(0, 10),
      startDate: selectedRepair?.startDate
        ? selectedRepair.startDate.substring(0, 10)
        : '',
      completionDate: selectedRepair?.completionDate
        ? selectedRepair.completionDate.substring(0, 10)
        : '',
      isPaidFromRepairsFund: selectedRepair?.isPaidFromRepairsFund || false,
      invoiceReference: selectedRepair?.invoiceReference || '',
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
  const chargeableTo = watch('chargeableTo');
  const allocationMethod = watch('allocationMethod');
  const chargeTerm = watch('chargeTerm');
  const contractorId = watch('contractorId');
  const isPaidFromRepairsFund = watch('isPaidFromRepairsFund');

  const showTenantFields = chargeableTo === 'tenants' || chargeableTo === 'split';

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
        const payload = {
          ...data,
          chargeTerm: data.chargeTerm ? Number(data.chargeTerm) : undefined,
          tenantSharePercentage:
            data.chargeableTo === 'split'
              ? data.tenantSharePercentage
              : undefined,
          allocationMethod: showTenantFields
            ? data.allocationMethod
            : undefined
        };
        if (selectedRepair?._id) {
          await updateMutation.mutateAsync({
            ...payload,
            _id: selectedRepair._id
          });
        } else {
          await addMutation.mutateAsync(payload);
        }
        handleClose();
      } catch (error) {
        toast.error(t('Something went wrong'));
      }
    },
    [selectedRepair, addMutation, updateMutation, handleClose, showTenantFields, t]
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
              <TableHead>{t('Charged to')}</TableHead>
              <TableHead className="text-right">{t('Cost')}</TableHead>
              <TableHead>{t('Charge Month')}</TableHead>
              <TableHead className="text-right">{t('Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repairs.map((repair) => (
              <TableRow key={repair._id}>
                <TableCell className="font-medium">
                  <div>
                    {repair.title}
                    {repair.urgency === 'emergency' && (
                      <Badge variant="destructive" className="ml-2 text-xs">
                        {t('emergency')}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>{t(repair.category)}</TableCell>
                <TableCell>
                  <Badge variant={getStatusBadgeVariant(repair.status)}>
                    {t(repair.status)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={getChargeableToBadge(repair.chargeableTo)}>
                    {t(repair.chargeableTo || 'owners')}
                    {repair.chargeableTo === 'split' &&
                      repair.tenantSharePercentage != null &&
                      ` (${repair.tenantSharePercentage}%)`}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <NumberFormat
                    value={repair.actualCost || repair.estimatedCost || 0}
                  />
                </TableCell>
                <TableCell>{formatTerm(repair.chargeTerm)}</TableCell>
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
                  rows={2}
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

              <Separator />

              <div className="sm:flex sm:gap-2">
                <div className="space-y-2 flex-1">
                  <Label htmlFor="estimatedCost">{t('Estimated Cost')}</Label>
                  <Input
                    id="estimatedCost"
                    type="number"
                    step="0.01"
                    {...register('estimatedCost')}
                  />
                </div>

                <div className="space-y-2 flex-1">
                  <Label htmlFor="actualCost">{t('Actual Cost')}</Label>
                  <Input
                    id="actualCost"
                    type="number"
                    step="0.01"
                    {...register('actualCost')}
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>{t('Charged to')}</Label>
                <Select
                  value={chargeableTo}
                  onValueChange={(val) => setValue('chargeableTo', val)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {chargeableToOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {t(opt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {chargeableTo === 'split' && (
                <div className="space-y-2">
                  <Label htmlFor="tenantSharePercentage">
                    {t('Tenant share')} (%)
                  </Label>
                  <Input
                    id="tenantSharePercentage"
                    type="number"
                    min="0"
                    max="100"
                    {...register('tenantSharePercentage')}
                  />
                </div>
              )}

              {showTenantFields && (
                <>
                  <div className="sm:flex sm:gap-2">
                    <div className="space-y-2 flex-1">
                      <Label>{t('Allocation method')}</Label>
                      <Select
                        value={allocationMethod}
                        onValueChange={(val) =>
                          setValue('allocationMethod', val)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {allocationMethods.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {t(m.labelId)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2 flex-1">
                      <Label>{t('Charge Month')}</Label>
                      <Select
                        value={chargeTerm}
                        onValueChange={(val) => setValue('chargeTerm', val)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {termOptions.map((opt) => (
                            <SelectItem key={opt.term} value={opt.term}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </>
              )}

              <Separator />

              <div className="sm:flex sm:gap-2">
                <div className="space-y-2 flex-1">
                  <Label htmlFor="reportedDate">{t('Reported date')}</Label>
                  <Input
                    id="reportedDate"
                    type="date"
                    {...register('reportedDate')}
                  />
                </div>

                <div className="space-y-2 flex-1">
                  <Label htmlFor="startDate">{t('Start date')}</Label>
                  <Input
                    id="startDate"
                    type="date"
                    {...register('startDate')}
                  />
                </div>

                <div className="space-y-2 flex-1">
                  <Label htmlFor="completionDate">
                    {t('Completion date')}
                  </Label>
                  <Input
                    id="completionDate"
                    type="date"
                    {...register('completionDate')}
                  />
                </div>
              </div>

              {contractors.length > 0 && (
                <div className="space-y-2">
                  <Label>{t('Contractor')}</Label>
                  <Select
                    value={contractorId}
                    onValueChange={(val) => setValue('contractorId', val)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select contractor')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{t('None')}</SelectItem>
                      {contractors.map((c) => (
                        <SelectItem key={c._id} value={c._id}>
                          {c.name} ({t(c.specialty)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Switch
                  checked={isPaidFromRepairsFund}
                  onCheckedChange={(val) =>
                    setValue('isPaidFromRepairsFund', val)
                  }
                />
                <Label>{t('Paid from repairs fund')}</Label>
              </div>

              <div className="space-y-2">
                <Label htmlFor="invoiceReference">
                  {t('Invoice reference')}
                </Label>
                <Input
                  id="invoiceReference"
                  {...register('invoiceReference')}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">{t('Notes')}</Label>
                <Textarea id="notes" {...register('notes')} rows={2} />
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
