import {
  createAppCredentials,
  QueryKeys,
  updateOrganization
} from '../../../utils/restcalls';
import { mergeOrganization, updateStoreOrganization } from '../utils';
import { RENTER_ROLE, ROLES } from '../../../store/User';
import { useCallback, useContext, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../ui/select';
import moment from 'moment';
import ResponsiveDialog from '../../ResponsiveDialog';
import { StoreContext } from '../../../store';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

export default function ApplicationFormDialog({
  open,
  setOpen,
  data: organization,
  onClose
}) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const formRef = useRef();
  const queryClient = useQueryClient();
  const { mutateAsync, isLoading, isError } = useMutation({
    mutationFn: updateOrganization,
    onSuccess: (organization) => {
      updateStoreOrganization(store, organization);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ORGANIZATIONS] });
    }
  });
  const { mutateAsync: mutateAppCredzAsync, isError: isAppCredzError } =
    useMutation({ mutationFn: createAppCredentials });

  const existingNames = useMemo(
    () => organization?.applications.map(({ name }) => name) || [],
    [organization?.applications]
  );

  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .min(1)
          .refine((val) => !existingNames.includes(val), {
            message: 'Name already exists'
          }),
        expiryDate: z.string().min(1).refine(
          (val) => moment(val).isValid() && moment(val).isAfter(moment(), 'days'),
          { message: 'Date must be valid and in the future' }
        ),
        role: z.string().min(1)
      }),
    [existingNames]
  );

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: '', expiryDate: '', role: RENTER_ROLE }
  });

  const roleValue = watch('role');

  const roleValues = useMemo(
    () => ROLES.map((role) => ({ id: role, label: t(role), value: role })),
    [t]
  );

  const handleClose = useCallback(
    (appCredz) => {
      setOpen(false);
      reset();
      appCredz && onClose?.(appCredz);
    },
    [onClose, setOpen, reset]
  );

  const handleCancel = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (app) => {
      if (!store.user.isAdministrator) return;
      const appCredz = await mutateAppCredzAsync({
        organization,
        expiryDate: moment(app.expiryDate)
      });
      await mutateAsync(
        mergeOrganization(organization, {
          applications: [...organization.applications, { ...app, ...appCredz }]
        })
      );
      handleClose(appCredz);
    },
    [store, mutateAppCredzAsync, organization, mutateAsync, handleClose]
  );

  if (isError) toast.error(t('Error adding application'));
  if (isAppCredzError) toast.error(t('Error creating application credentials'));

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('New application')}
      renderContent={() => (
        <form ref={formRef} onSubmit={handleSubmit(_onSubmit)} autoComplete="off">
          <div className="pt-6 space-y-4">
            <div>{t('Add an application credential to your organization')}</div>
            <div className="space-y-2">
              <Label htmlFor="name">{t('Name')}</Label>
              <Input id="name" {...register('name')} />
              {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label>{t('Role')}</Label>
              <Select value={roleValue} onValueChange={(val) => setValue('role', val)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleValues.map((r) => (
                    <SelectItem key={r.id} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="expiryDate">{t('Expiry date')}</Label>
              <Input
                id="expiryDate"
                type="date"
                min={moment().add(1, 'day').format('YYYY-MM-DD')}
                {...register('expiryDate')}
              />
              {errors.expiryDate && <p className="text-sm text-destructive">{errors.expiryDate.message}</p>}
            </div>
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleCancel}>{t('Cancel')}</Button>
          <Button onClick={() => formRef.current?.requestSubmit()}>{t('Add')}</Button>
        </>
      )}
    />
  );
}
