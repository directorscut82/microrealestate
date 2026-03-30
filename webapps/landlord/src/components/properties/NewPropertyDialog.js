import React, { useCallback, useContext, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../ui/button';
import { createProperty, fetchProperties, QueryKeys } from '../../utils/restcalls';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import PropertyIcon from './PropertyIcon';
import ResponsiveDialog from '../ResponsiveDialog';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

const schema = z
  .object({
    name: z.string().min(1),
    isCopyFrom: z.boolean(),
    copyFrom: z.string()
  })
  .refine(
    (data) => !data.isCopyFrom || data.copyFrom.length > 0,
    { message: 'Required', path: ['copyFrom'] }
  );

export default function NewPropertyDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const { data: propertyItems = [] } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties
  });

  const createMutation = useMutation({
    mutationFn: createProperty,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] })
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: '', copyFrom: '', isCopyFrom: false }
  });

  const isCopyFrom = watch('isCopyFrom');

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (propertyPart) => {
      try {
        setIsLoading(true);
        let property = { ...propertyPart };

        if (propertyPart.isCopyFrom) {
          const { _id, ...originalProperty } =
            propertyItems.find(({ _id }) => propertyPart.copyFrom === _id) || {};
          property = { ...originalProperty, ...property };
        }

        const data = await createMutation.mutateAsync(property);
        handleClose();
        store.appHistory.setPreviousPath(router.asPath);
        await router.push(
          `/${store.organization.selected.name}/properties/${data._id}`
        );
      } catch (error) {
        const status = error?.response?.status;
        switch (status) {
          case 422:
            return toast.error(t('Property name is missing'));
          case 403:
            return toast.error(t('You are not allowed to add a property'));
          case 409:
            return toast.error(t('The property already exists'));
          default:
            return toast.error(t('Something went wrong'));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [createMutation, propertyItems, handleClose, router, store, t]
  );

  const properties = propertyItems.map(({ _id, name, type }) => ({
    id: _id,
    label: name,
    value: _id,
    type
  }));

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Add a property')}
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
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>
            {properties?.length ? (
              <>
                <div className="flex items-center gap-2">
                  <Switch
                    id="isCopyFrom"
                    checked={isCopyFrom}
                    onCheckedChange={(checked) =>
                      setValue('isCopyFrom', checked)
                    }
                  />
                  <Label htmlFor="isCopyFrom">
                    {t('Copy from an existing property')}
                  </Label>
                </div>
                <div className="space-y-2">
                  <Label>{t('Property')}</Label>
                  <Select
                    disabled={!isCopyFrom}
                    onValueChange={(val) => setValue('copyFrom', val)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select a property')} />
                    </SelectTrigger>
                    <SelectContent>
                      {properties.map((p) => (
                        <SelectItem key={p.id} value={p.value}>
                          <div className="flex items-center gap-2">
                            <PropertyIcon type={p.type} />
                            {p.label}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.copyFrom && (
                    <p className="text-sm text-destructive">
                      {errors.copyFrom.message}
                    </p>
                  )}
                </div>
              </>
            ) : null}
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
            data-cy="submitProperty"
          >
            {t('Add')}
          </Button>
        </>
      )}
    />
  );
}
