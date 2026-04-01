import React, { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { createLease, QueryKeys } from '../../../utils/restcalls';
import ResponsiveDialog from '../../ResponsiveDialog';
import { StoreContext } from '../../../store';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  name: z.string().min(1)
});

export default function NewLeaseDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);

  const createMutation = useMutation({
    mutationFn: createLease,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKeys.LEASES] })
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: '' }
  });

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (leasePart) => {
      try {
        setIsLoading(true);
        const data = await createMutation.mutateAsync({
          ...leasePart,
          stepperMode: true
        });
        handleClose();
        await router.push(
          `/${router.query.organization}/settings/contracts/${data._id}`,
          undefined,
          { locale: store.organization.selected?.locale }
        );
      } catch (error) {
        const status = error?.response?.status;
        switch (status) {
          case 422:
            return toast.error(t('Contract name is missing'));
          case 403:
            return toast.error(t('You are not allowed to create a contract'));
          case 409:
            return toast.error(t('The contract already exists'));
          default:
            return toast.error(t('Something went wrong'));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [createMutation, handleClose, router, t]
  );

  const formRef = useRef();

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Create a contract')}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(_onSubmit)}
          autoComplete="off"
        >
          <div className="space-y-2">
            <Label htmlFor="name">{t('Name')}</Label>
            <Input id="name" {...register('name')} />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={() => formRef.current?.requestSubmit()}
            data-cy="submitContract"
          >
            {t('Create')}
          </Button>
        </>
      )}
    />
  );
}
