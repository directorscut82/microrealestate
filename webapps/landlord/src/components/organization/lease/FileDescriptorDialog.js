import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import ResponsiveDialog from '../../ResponsiveDialog';
import useTranslation from 'next-translate/useTranslation';

const schema = z.object({
  _id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  hasExpiryDate: z.boolean(),
  required: z.string()
});

export default function FileDescriptorDialog({
  open,
  setOpen,
  onSave,
  data: fileDescriptor
}) {
  const { t } = useTranslation('common');
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const formData = useMemo(() => {
    if (!fileDescriptor) {
      return {
        name: '',
        description: '',
        hasExpiryDate: false,
        required: 'notRequired'
      };
    }
    return {
      _id: fileDescriptor._id,
      name: fileDescriptor.name || '',
      description: fileDescriptor.description || '',
      hasExpiryDate: fileDescriptor.hasExpiryDate || false,
      required: fileDescriptor.required
        ? 'required'
        : fileDescriptor.requiredOnceContractTerminated
          ? 'requiredOnceContractTerminated'
          : 'notRequired'
    };
  }, [fileDescriptor]);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: formData,
    values: formData
  });

  const hasExpiryDate = watch('hasExpiryDate');
  const requiredValue = watch('required');

  const handleClose = useCallback(() => setOpen(false), [setOpen]);

  const _onSubmit = useCallback(
    async (data) => {
      try {
        setIsLoading(true);
        await onSave({
          ...data,
          required: data.required === 'required',
          requiredOnceContractTerminated:
            data.required === 'requiredOnceContractTerminated'
        });
        handleClose();
      } finally {
        setIsLoading(false);
      }
    },
    [handleClose, onSave]
  );

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => (
        <>
          <div>{t('Template document to upload')}</div>
          <div className="text-base text-muted-foreground font-normal">
            {t(
              'Describe the document that will be uploaded when creating the lease'
            )}
          </div>
        </>
      )}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(_onSubmit)}
          autoComplete="off"
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('Name')}</Label>
              <Input id="name" {...register('name')} />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t('Description')}</Label>
              <Input id="description" {...register('description')} />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="hasExpiryDate"
                checked={hasExpiryDate}
                onCheckedChange={(checked) =>
                  setValue('hasExpiryDate', checked)
                }
              />
              <Label htmlFor="hasExpiryDate">
                {t('An expiry date must be provided')}
              </Label>
            </div>
            <div className="space-y-2">
              <Label>{t('The document is')}</Label>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer" data-cy="fileOptional">
                  <input
                    type="radio"
                    value="notRequired"
                    checked={requiredValue === 'notRequired'}
                    onChange={() => setValue('required', 'notRequired')}
                    className="accent-primary"
                  />
                  {t('Optional')}
                </label>
                <label className="flex items-center gap-2 cursor-pointer" data-cy="fileRequired">
                  <input
                    type="radio"
                    value="required"
                    checked={requiredValue === 'required'}
                    onChange={() => setValue('required', 'required')}
                    className="accent-primary"
                  />
                  {t('Mandatory')}
                </label>
                <label className="flex items-center gap-2 cursor-pointer" data-cy="fileRequiredOnceContractTerminated">
                  <input
                    type="radio"
                    value="requiredOnceContractTerminated"
                    checked={requiredValue === 'requiredOnceContractTerminated'}
                    onChange={() =>
                      setValue('required', 'requiredOnceContractTerminated')
                    }
                    className="accent-primary"
                  />
                  {t('Mandatory only when contract is terminated')}
                </label>
              </div>
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
            data-cy="submitFileDescriptor"
          >
            {formData?._id ? t('Update') : t('Add')}
          </Button>
        </>
      )}
    />
  );
}
