import { mergeOrganization, updateStoreOrganization } from '../utils';
import { QueryKeys, updateOrganization } from '../../../utils/restcalls';
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
import ResponsiveDialog from '../../ResponsiveDialog';
import { StoreContext } from '../../../store';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

export default function MemberFormDialog({
  open,
  setOpen,
  data: organization
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

  const existingEmails = useMemo(
    () => organization?.members.map(({ email }) => email) || [],
    [organization?.members]
  );

  const schema = useMemo(
    () =>
      z.object({
        email: z
          .string()
          .email()
          .min(1)
          .refine((val) => !existingEmails.includes(val), {
            message: 'Email already exists'
          }),
        role: z.string().min(1)
      }),
    [existingEmails]
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
    defaultValues: { email: '', role: RENTER_ROLE }
  });

  const roleValue = watch('role');

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (member) => {
      await mutateAsync(
        mergeOrganization(organization, {
          members: [...organization.members, member]
        })
      );
      handleClose();
    },
    [mutateAsync, organization, handleClose]
  );

  const roleValues = useMemo(
    () => ROLES.map((role) => ({ id: role, label: t(role), value: role })),
    [t]
  );

  if (isError) {
    toast.error(t('Error adding member'));
  }

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('New collaborator')}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(_onSubmit)}
          autoComplete="off"
        >
          <div className="pt-6 space-y-4">
            <div>{t('Add a collaborator to your organization')}</div>
            <div className="space-y-2">
              <Label htmlFor="email">{t('Email')}</Label>
              <Input id="email" {...register('email')} />
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('Role')}</Label>
              <Select
                value={roleValue}
                onValueChange={(val) => setValue('role', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleValues.map((r) => (
                    <SelectItem key={r.id} value={r.value}>
                      {r.label}
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
            {t('Add')}
          </Button>
        </>
      )}
    />
  );
}
