import {
  addBuildingRepair,
  deleteDocumentByKey,
  fetchProperties,
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
import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { apiFetcher, uploadDocument } from '../../utils/fetch';
import FileDownload from 'js-file-download';
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

const repairStatuses = ['planned', 'in_progress', 'completed', 'cancelled'];

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
  // Tier I-3.c: subdocument _ids of building.units that this repair is
  // scoped to. Empty = applies to all units (legacy default).
  affectedUnitIds: z.array(z.string()).optional(),
  reportedDate: z.string().optional(),
  startDate: z.string().optional(),
  completionDate: z.string().optional(),
  isPaidFromRepairsFund: z.boolean().optional(),
  invoiceReference: z.string().optional(),
  // Tier I-3.d: storage key returned by /documents/upload after the
  // landlord attaches an invoice scan.
  invoiceDocumentId: z.string().nullable().optional(),
  notes: z.string().optional()
}).superRefine((data, ctx) => {
  // A COMPLETED repair that is meant to be charged must carry both a
  // charge month AND a cost — otherwise _distributeRepairCharge silently
  // returns (no chargeTerm / cost<=0) and the repair bills NOBODY, showing
  // up nowhere in rents, the apartment tile, or the breakdown. Planned /
  // in-progress repairs may legitimately lack a final cost/term, and a
  // reserve-funded repair intentionally doesn't bill, so scope the guard
  // to completed + not-reserve-funded.
  const isChargeable =
    data.status === 'completed' && !data.isPaidFromRepairsFund;
  if (!isChargeable) return;
  const cost =
    (Number(data.actualCost) || 0) || (Number(data.estimatedCost) || 0);
  if (cost <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A completed repair needs a cost to be charged',
      path: ['actualCost']
    });
  }
  if (!data.chargeTerm) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Pick the month this repair is charged',
      path: ['chargeTerm']
    });
  }
});

function getStatusBadgeVariant(status) {
  switch (status) {
    case 'planned':
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
  // Wave-24 B13: widen the visible window from -3..+12 to -12..+24 so a
  // landlord can backdate a repair charge up to a year (legitimate after
  // late vendor invoices) and pre-schedule almost two years out.
  const options = [];
  const now = new Date();
  for (let i = -12; i <= 24; i++) {
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

  // Charge-month options are a fixed relative window (now-12..now+24). A
  // repair can legitimately carry a chargeTerm OUTSIDE that window (a
  // backdated late invoice, or drift as wall-clock advances). When editing
  // such a repair the controlled Select had no matching SelectItem and
  // rendered BLANK — looking broken and tempting the user to pick a wrong
  // in-window month. Union the selected repair's stored term into the list
  // so it always has a labeled option. Keyed on selectedRepair so it
  // refreshes when switching between repairs.
  const termOptions = useMemo(() => {
    const opts = generateTermOptions();
    const stored = selectedRepair?.chargeTerm;
    if (stored && !opts.some((o) => o.term === String(stored))) {
      opts.unshift({ term: String(stored), label: formatTerm(stored) });
    }
    return opts;
  }, [selectedRepair]);

  // Repairs that distribute charges to tenant rents change rent ledgers
  // — the next payment dialog or rent listing must see the updated state.
  // Invalidate building + RENTS + DASHBOARD + TENANTS like ExpenseList.
  const _invalidateAllRepairDependents = () => {
    queryClient.invalidateQueries({
      queryKey: [QueryKeys.BUILDINGS, building._id]
    });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
  };

  const addMutation = useMutation({
    mutationFn: (data) => addBuildingRepair(building._id, data),
    onSuccess: () => {
      _invalidateAllRepairDependents();
      toast.success(t('Repair added'));
    }
  });

  const updateMutation = useMutation({
    mutationFn: (data) => updateBuildingRepair(building._id, data),
    onSuccess: () => {
      _invalidateAllRepairDependents();
      toast.success(t('Repair updated'));
    }
  });

  const removeMutation = useMutation({
    mutationFn: (repairId) => removeBuildingRepair(building._id, repairId),
    onSuccess: () => {
      _invalidateAllRepairDependents();
      toast.success(t('Repair removed'));
    }
  });

  const initialValues = useMemo(
    () => ({
      title: selectedRepair?.title ?? '',
      description: selectedRepair?.description ?? '',
      category: selectedRepair?.category ?? 'general',
      status: selectedRepair?.status ?? 'planned',
      urgency: selectedRepair?.urgency ?? 'normal',
      estimatedCost: selectedRepair?.estimatedCost ?? '',
      actualCost: selectedRepair?.actualCost ?? '',
      chargeableTo: selectedRepair?.chargeableTo ?? 'owners',
      tenantSharePercentage: selectedRepair?.tenantSharePercentage ?? 50,
      allocationMethod:
        selectedRepair?.allocationMethod ?? 'general_thousandths',
      chargeTerm: selectedRepair?.chargeTerm
        ? String(selectedRepair.chargeTerm)
        : getCurrentTerm(),
      contractorId: selectedRepair?.contractorId ?? '',
      reportedDate: selectedRepair?.reportedDate
        ? selectedRepair.reportedDate.substring(0, 10)
        : new Date().toISOString().substring(0, 10),
      startDate: selectedRepair?.startDate
        ? selectedRepair.startDate.substring(0, 10)
        : '',
      completionDate: selectedRepair?.completionDate
        ? selectedRepair.completionDate.substring(0, 10)
        : '',
      isPaidFromRepairsFund: selectedRepair?.isPaidFromRepairsFund ?? false,
      invoiceReference: selectedRepair?.invoiceReference ?? '',
      invoiceDocumentId: selectedRepair?.invoiceDocumentId ?? null,
      affectedUnitIds: Array.isArray(selectedRepair?.affectedUnitIds)
        ? selectedRepair.affectedUnitIds
        : [],
      notes: selectedRepair?.notes ?? ''
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
  const affectedUnitIds = watch('affectedUnitIds') || [];
  const invoiceDocumentId = watch('invoiceDocumentId');

  // Tier I-3.b: any chargeableTo value (owners / tenants / split) opens the
  // allocation picker + chargeTerm. Owner-side now persists via
  // ownerMonthlyExpenses[] (see buildingmanager._distributeRepairCharge).
  const showAllocationFields = chargeableTo !== undefined;
  // The tenant share input remains split-only (it's meaningless for the
  // pure tenants/owners cases).
  const showTenantSharePercentage = chargeableTo === 'split';

  // Resolve unit.propertyId → property.name so the picker shows
  // human-readable labels instead of bare ObjectIds. The properties index
  // is shared across the app — react-query dedupes the request so this
  // is free if any other surface already loaded it this session.
  const { data: allPropertiesPage } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties,
    staleTime: 60_000
  });
  const allProperties = useMemo(() => {
    if (Array.isArray(allPropertiesPage)) return allPropertiesPage;
    return allPropertiesPage?.items || [];
  }, [allPropertiesPage]);
  const propertyNameById = useMemo(() => {
    const map = new Map();
    for (const p of allProperties) {
      if (p?._id) map.set(String(p._id), p.name || '');
    }
    return map;
  }, [allProperties]);

  const buildingUnits = useMemo(() => {
    return (building?.units || []).map((u) => ({
      ...u,
      // Backfill propertyName + a friendly label even when the source
      // unit doc lacks them. Floor "0" is meaningful (ground floor) so
      // we surface it explicitly. The picker reads `propertyName` and
      // `unitLabel` so this object stays drop-in compatible with the
      // existing JSX below.
      propertyName:
        u.propertyName ||
        propertyNameById.get(String(u.propertyId)) ||
        '',
      unitLabel:
        u.unitLabel ||
        u.name ||
        (typeof u.floor === 'number'
          ? `Όροφος ${u.floor}`
          : '')
    }));
  }, [building?.units, propertyNameById]);

  // Tier I-3.f upload state: tracks the in-flight invoice upload so we can
  // disable the submit button + show progress in the helper text.
  const [invoiceUploading, setInvoiceUploading] = useState(false);
  // Ref to the file input so we can reset it after upload+remove (F6-repair).
  // Without this, the same file cannot be re-picked after Remove because the
  // input retains the prior selection and onChange does not fire for the
  // same value.
  const invoiceFileInputRef = useRef(null);
  // Track keys uploaded BUT not yet committed to a saved repair so we can
  // best-effort delete them when the dialog is cancelled (F4-repair).
  const pendingInvoiceKeyRef = useRef(null);

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
      // F4-repair: clean up the invoice file BEFORE removing the
      // repair record so a network failure between the two doesn't
      // orphan the file. Best-effort — server endpoint is idempotent
      // and the repair delete is the user-visible primary action.
      const orphanInvoiceKey = selectedRepair?.invoiceDocumentId;
      if (orphanInvoiceKey) {
        await deleteDocumentByKey(orphanInvoiceKey).catch(() => {});
      }
      await removeMutation.mutateAsync(selectedRepair._id);
    } catch (error) {
      toast.error(t('Failed to remove repair'));
    }
  }, [selectedRepair, removeMutation, t]);

  // View an attached invoice. A raw <a href> navigation to the gateway
  // sends only cookies — never the in-memory Authorization / organizationId
  // headers — so the document endpoint (needAccessToken) always 401s and
  // the invoice was unviewable. Fetch the blob through apiFetcher (which
  // carries both headers) and open it in a new tab. Open the tab
  // synchronously before the await so the popup blocker treats it as a
  // user-gesture, then point it at the blob URL once it resolves.
  const handleViewInvoice = useCallback(
    async (key) => {
      if (!key) return;
      const win = window.open('', '_blank');
      try {
        const res = await apiFetcher().get(
          `/documents/by-key?key=${encodeURIComponent(key)}`,
          { responseType: 'blob' }
        );
        const url = URL.createObjectURL(res.data);
        if (win) {
          win.location = url;
        } else {
          // Popup blocked — fall back to a download.
          FileDownload(res.data, key.split('/').pop() || 'invoice');
        }
        // Revoke after a delay so the new tab has time to load the blob.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (e) {
        if (win) win.close();
        toast.error(t('Something went wrong'));
      }
    },
    [t]
  );

  const handleClose = useCallback(() => {
    // F4-repair: if the user uploaded an invoice in this session but is
    // closing the dialog WITHOUT saving (Cancel / Esc / outside-click),
    // delete the orphaned file. Skip if the upload happened on an
    // already-saved repair (we'd be deleting the saved invoice — only
    // discard NEW uploads that never reached the database).
    const pending = pendingInvoiceKeyRef.current;
    const wasOnExistingRepair = !!selectedRepair?.invoiceDocumentId;
    if (
      pending &&
      (!wasOnExistingRepair || pending !== selectedRepair.invoiceDocumentId)
    ) {
      deleteDocumentByKey(pending).catch(() => {});
    }
    pendingInvoiceKeyRef.current = null;
    setOpenDialog(false);
    setSelectedRepair(null);
    reset();
  }, [reset, selectedRepair]);

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
          // Tier I-3.b: allocation method matters for any chargeableTo value
          // because ownerMonthlyExpenses now also reads it (the owner-side
          // entry uses the same method to size the per-unit owner share if
          // we ever expand to per-unit owner billing). Preserve it across
          // owner / tenants / split so an edit doesn't reset to default.
          allocationMethod: data.chargeableTo
            ? data.allocationMethod
            : undefined,
          affectedUnitIds: Array.isArray(data.affectedUnitIds)
            ? data.affectedUnitIds.filter(Boolean)
            : [],
          invoiceDocumentId: data.invoiceDocumentId ?? null
        };
        if (selectedRepair?._id) {
          // Thread the building's __v so the server can detect
          // concurrent repair edits (two tabs racing).
          await updateMutation.mutateAsync({
            ...payload,
            _id: selectedRepair._id,
            ...(typeof building?.__v === 'number'
              ? { __v: building.__v }
              : {})
          });
        } else {
          await addMutation.mutateAsync(payload);
        }
        // The invoice is now committed; clear the pending-upload ref so
        // handleClose doesn't try to delete the freshly-saved file.
        pendingInvoiceKeyRef.current = null;
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
                    aria-label={t('Edit')}
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(repair)}
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
          {t('No repairs found')}
        </div>
      )}

      <ResponsiveDialog
        open={openDialog}
        // Route ALL close paths (Esc, the X button, programmatic) through
        // handleClose so the orphan-invoice cleanup + form reset always
        // run. Wiring the bare setOpenDialog here let Esc/X dismiss the
        // dialog without deleting a freshly-uploaded-but-unsaved invoice,
        // leaking the file in storage.
        setOpen={(v) => (v ? setOpenDialog(true) : handleClose())}
        className="sm:max-w-3xl md:max-w-4xl"
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
                  {errors.actualCost && (
                    <p className="text-label text-oxide">
                      {t(errors.actualCost.message)}
                    </p>
                  )}
                </div>
              </div>

              {/* Tier I-3.g: clarify which of (estimated, actual) drives
                  the rent/owner ledger so users don't second-guess the
                  field after entering both. */}
              <p className="text-label text-ink-muted">
                {t(
                  'While pending, the estimated cost drives billing. Once an actual cost is entered, it replaces the estimate.'
                )}
              </p>
              <p className="text-label text-ink-muted">
                {t(
                  'When you change the cost, the charge for the chosen month is recomputed (delta = new − old). If tenants already paid, the difference appears as a debt or credit on the next rent statement for that month.'
                )}
              </p>

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

              {showTenantSharePercentage && (
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

              {showAllocationFields && (
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
                      {errors.chargeTerm && (
                        <p className="text-label text-oxide">
                          {t(errors.chargeTerm.message)}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Tier I-3.c: per-unit scoping. Empty = all units, which
                      preserves the legacy default. We list each unit by its
                      most descriptive label (atak + label/name + property).
                      A multi-select dropdown would obscure how many units
                      are checked, so a checkbox list is preferred even at
                      30+ units. */}
                  {buildingUnits.length > 0 && (
                    <div className="space-y-2">
                      <Label>{t('Affected units')}</Label>
                      <p className="text-label text-ink-muted">
                        {t(
                          'Affected units (optional — leave empty to charge all units)'
                        )}
                      </p>
                      <div className="grid sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-stone-line rounded-md p-2">
                        {buildingUnits.map((u) => {
                          const uid = String(u._id);
                          const checked = affectedUnitIds.includes(uid);
                          // The property name already encodes the floor
                          // ("ΑΓ. ΑΝΑΡΓΥΡΩΝ 28 - Υπόγειο" / "- Όροφος 1"),
                          // so appending floor + unitLabel repeated it up
                          // to 3×. Only add a floor/unit suffix when the
                          // name doesn't already carry one. ATAK stays as
                          // the tiebreaker for units sharing a floor.
                          const nameHasFloor =
                            /Υπόγειο|Ισόγειο|Όροφος|Floor|Étage|Piso|Andar|Stockwerk/i.test(
                              u.propertyName || ''
                            );
                          const floorPart =
                            !nameHasFloor && typeof u.floor === 'number'
                              ? t('Floor {{n}}', { n: u.floor })
                              : '';
                          const labelParts = [
                            u.propertyName,
                            floorPart,
                            !nameHasFloor ? u.unitLabel : '',
                            u.atakNumber ? `ATAK ${u.atakNumber}` : ''
                          ].filter(Boolean);
                          return (
                            <label
                              key={uid}
                              className="flex items-center gap-2 text-sm cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...affectedUnitIds, uid]
                                    : affectedUnitIds.filter((x) => x !== uid);
                                  setValue('affectedUnitIds', next, {
                                    shouldDirty: true
                                  });
                                }}
                              />
                              <span>{labelParts.join(' — ')}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
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
                  {/* Tier I-3.e: keep the schema field name (startDate) but
                      surface "Scheduled date" so the timeline reads
                      reported -> scheduled -> completed. The Greek
                      translation of "Start date" was clinically worse:
                      "Ημερομηνία έναρξης" suggests work began, not that
                      it was planned. */}
                  <Label htmlFor="startDate">{t('Scheduled date')}</Label>
                  <Input
                    id="startDate"
                    type="date"
                    {...register('startDate')}
                  />
                </div>

                <div className="space-y-2 flex-1">
                  <Label htmlFor="completionDate">
                    {t('Completed date')}
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
                    // Radix Select forbids empty-string SelectItem values
                    // (it crashes the dialog on open). Map the schema's
                    // empty/null contractorId to a __none__ sentinel for
                    // the UI, and translate back on change.
                    value={contractorId || '__none__'}
                    onValueChange={(val) =>
                      setValue('contractorId', val === '__none__' ? '' : val, {
                        shouldDirty: true
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select contractor')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t('None')}</SelectItem>
                      {contractors.map((c) => (
                        <SelectItem key={c._id} value={c._id}>
                          {c.name} ({t(c.specialty)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={isPaidFromRepairsFund}
                    onCheckedChange={(val) =>
                      setValue('isPaidFromRepairsFund', val)
                    }
                  />
                  <Label>{t('Paid from repairs fund')}</Label>
                </div>
                <p className="text-label text-ink-muted">
                  {t(
                    'Informational only — marks the repair as covered by an accumulated reserve outside this app. Does not affect tenant bills or building totals.'
                  )}
                </p>
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

              {/* Tier I-3.d: optional invoice scan. Uploads to the same
                  /documents/upload endpoint as the lease document attach
                  flow; the returned storage key is persisted on the repair
                  via invoiceDocumentId. We don't open a Document record —
                  the repair owns the file lifecycle. */}
              <div className="space-y-2">
                <Label htmlFor="invoiceFile">{t('Invoice file')}</Label>
                <Input
                  id="invoiceFile"
                  ref={invoiceFileInputRef}
                  type="file"
                  accept=".gif,.png,.jpg,.jpeg,.jpe,.pdf"
                  disabled={invoiceUploading}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    // If there's already a pending (unsaved) upload, delete
                    // it before replacing so the old file doesn't orphan
                    // (F4-repair edit-replace path).
                    if (
                      pendingInvoiceKeyRef.current &&
                      pendingInvoiceKeyRef.current !== invoiceDocumentId
                    ) {
                      deleteDocumentByKey(pendingInvoiceKeyRef.current).catch(
                        () => {}
                      );
                    }
                    try {
                      setInvoiceUploading(true);
                      const folder = [
                        building?.name?.replace(/[/\\]/g, '_') || 'building',
                        'repair_invoices'
                      ].join('/');
                      const response = await uploadDocument({
                        endpoint: '/documents/upload',
                        documentName: f.name,
                        file: f,
                        folder
                      });
                      const newKey = response.data?.key || null;
                      // If we are REPLACING an already-saved invoice (the
                      // form has invoiceDocumentId AND the user picked a
                      // new file), the OLD key is now orphaned. Best-effort
                      // delete (F4-repair edit-replace).
                      if (
                        invoiceDocumentId &&
                        invoiceDocumentId !== newKey
                      ) {
                        deleteDocumentByKey(invoiceDocumentId).catch(
                          () => {}
                        );
                      }
                      pendingInvoiceKeyRef.current = newKey;
                      setValue('invoiceDocumentId', newKey, {
                        shouldDirty: true
                      });
                      toast.success(t('Invoice file uploaded'));
                    } catch (err) {
                      console.error(err);
                      toast.error(t('Cannot upload document'));
                    } finally {
                      setInvoiceUploading(false);
                      // F6-repair: clear input value so the same file can
                      // be re-picked after Remove. onChange does not fire
                      // when the user selects the same file twice.
                      if (invoiceFileInputRef.current) {
                        invoiceFileInputRef.current.value = '';
                      }
                    }
                  }}
                />
                {invoiceDocumentId ? (
                  <div className="flex items-center justify-between gap-2 text-label">
                    <span className="text-ink-muted truncate">
                      {invoiceDocumentId.split('/').pop()}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        className="text-ink underline underline-offset-2 hover:no-underline"
                        onClick={() => handleViewInvoice(invoiceDocumentId)}
                      >
                        {t('View invoice')}
                      </button>
                      <button
                        type="button"
                        className="text-oxide hover:underline"
                        onClick={() => {
                          // F4-repair: best-effort delete the orphaned
                          // file from storage so we don't leak. The
                          // server endpoint is idempotent (204 even when
                          // file is gone) so a network blip doesn't
                          // matter.
                          if (invoiceDocumentId) {
                            deleteDocumentByKey(invoiceDocumentId).catch(
                              () => {}
                            );
                          }
                          pendingInvoiceKeyRef.current = null;
                          setValue('invoiceDocumentId', null, {
                            shouldDirty: true
                          });
                          if (invoiceFileInputRef.current) {
                            invoiceFileInputRef.current.value = '';
                          }
                        }}
                      >
                        {t('Remove')}
                      </button>
                    </div>
                  </div>
                ) : null}
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
              disabled={isSubmitting || invoiceUploading}
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
