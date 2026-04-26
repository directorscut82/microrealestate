import { createBuilding, QueryKeys } from '../../utils/restcalls';
import React, { useCallback, useContext, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import ResponsiveDialog from '../ResponsiveDialog';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const schema = z.object({
  name: z.string().min(1),
  atakPrefix: z.string().min(1)
});

export default function NewBuildingDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const createMutation = useMutation({
    mutationFn: createBuilding,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] })
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: '', atakPrefix: '' }
  });

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (buildingPart) => {
      try {
        setIsLoading(true);
        const data = await createMutation.mutateAsync(buildingPart);
        handleClose();
        const orgName =
          store.organization.selected?.name || router.query.organization;
        await router.push(`/${orgName}/buildings/${data._id}`, undefined, {
          locale: store.organization.selected?.locale
        });
      } catch (error) {
        const status = error?.response?.status;
        switch (status) {
          case 422:
            return toast.error(t('Building name or ATAK prefix is missing'));
          case 403:
            return toast.error(t('You are not allowed to add a building'));
          default:
            return toast.error(t('Something went wrong'));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [createMutation, handleClose, router, store.organization.selected, t]
  );

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Add a building')}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(_onSubmit)}
          autoComplete="off"
        >
          <div className="pt-6 space-y-4">
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
              <Label htmlFor="atakPrefix">{t('ATAK Prefix')}</Label>
              <Input id="atakPrefix" {...register('atakPrefix')} />
              {errors.atakPrefix && (
                <p className="text-sm text-destructive">
                  {errors.atakPrefix.message}
                </p>
              )}
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
            onClick={() => formRef.current?.requestSubmit()}
            data-cy="submitBuilding"
          >
            {t('Add')}
          </Button>
        </>
      )}
    />
  );
}
