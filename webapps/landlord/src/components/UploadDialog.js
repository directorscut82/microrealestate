import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from './ui/select';
import ResponsiveDialog from './ResponsiveDialog';
import { toast } from 'sonner';
import { uploadDocument } from '../utils/fetch';
import useTranslation from 'next-translate/useTranslation';

const UPLOAD_MAX_SIZE = 2_000_000_000;
const SUPPORTED_MIMETYPES = [
  'image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'image/jpe', 'application/pdf'
];

// Error messages use stable keys; the form translates them via t() at render
// time. This keeps the schema module-level (no t() in scope) without leaking
// English to the UI.
const FILE_REQUIRED = 'file_required';
const FILE_TOO_BIG = 'file_too_big';
const FILE_TYPE_INVALID = 'file_type_invalid';

const schema = z.object({
  templateId: z.string().min(1),
  expiryDate: z.string().optional(),
  file: z.any()
    .refine((f) => f instanceof File, { message: FILE_REQUIRED })
    .refine((f) => f instanceof File && f.size <= UPLOAD_MAX_SIZE, { message: FILE_TOO_BIG })
    .refine((f) => f instanceof File && SUPPORTED_MIMETYPES.includes(f.type), { message: FILE_TYPE_INVALID })
});

function translateFileError(t, message) {
  switch (message) {
    case FILE_REQUIRED:
      return t('File is required');
    case FILE_TOO_BIG:
      return t('File is too big. Maximum size is 2Go.');
    case FILE_TYPE_INVALID:
      return t('Only images or pdf are accepted.');
    default:
      return message;
  }
}

export default function UploadDialog({ open, setOpen, data: selectedTemplate, onSave, tenant, templates: allTemplates = [] }) {
  const { t } = useTranslation('common');
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();
  const fileInputRef = useRef();

  const templates = useMemo(() =>
    allTemplates
      .filter((tpl) => tpl.type === 'fileDescriptor' && tpl.linkedResourceIds?.includes(tenant?.leaseId))
      .map((tpl) => ({ id: tpl._id, label: tpl.name, value: tpl._id, template: tpl })),
    [allTemplates, tenant?.leaseId]
  );

  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { templateId: selectedTemplate?._id || '', expiryDate: '', file: undefined }
  });

  const templateId = watch('templateId');
  const selectedTpl = useMemo(
    () => templates.find((t) => t.id === templateId)?.template || selectedTemplate,
    [templateId, templates, selectedTemplate]
  );

  const handleClose = useCallback(() => { setOpen(false); reset(); }, [setOpen, reset]);

  const _onSubmit = useCallback(async (data) => {
    try {
      setIsLoading(true);
      const template = selectedTpl;
      const doc = {
        template, name: template.name, description: template.description,
        mimeType: data.file.type, expiryDate: data.expiryDate || null
      };
      try {
        const response = await uploadDocument({
          endpoint: '/documents/upload', documentName: template.name, file: data.file,
          folder: [tenant?.name?.replace(/[/\\]/g, '_'), 'contract_scanned_documents'].join('/')
        });
        doc.url = response.data.key;
        doc.versionId = response.data.versionId;
      } catch (error) {
        console.error(error);
        toast.error(t('Cannot upload document'));
        return;
      }
      handleClose();
      try { await onSave(doc); } catch (error) { console.error(error); toast.error(t('Cannot save document')); }
    } finally { setIsLoading(false); }
  }, [handleClose, t, onSave, tenant, selectedTpl]);

  return (
    <ResponsiveDialog
      open={open} setOpen={setOpen} isLoading={isLoading}
      renderHeader={() => t('Document to upload')}
      renderContent={() => (
        <form ref={formRef} onSubmit={handleSubmit(_onSubmit)} autoComplete="off">
          <div className="space-y-4">
            {selectedTemplate ? (
              <div className="font-medium">{selectedTemplate.name}</div>
            ) : (
              <div className="space-y-2">
                <Label>{t('Document')}</Label>
                <Select value={templateId} onValueChange={(val) => setValue('templateId', val)}>
                  <SelectTrigger><SelectValue placeholder={t('Select a document')} /></SelectTrigger>
                  <SelectContent>
                    {templates.map((tpl) => (<SelectItem key={tpl.id} value={tpl.value}>{tpl.label}</SelectItem>))}
                  </SelectContent>
                </Select>
                {errors.templateId && <p className="text-sm text-destructive">{errors.templateId.message}</p>}
              </div>
            )}
            {selectedTpl?.hasExpiryDate && (
              <div className="space-y-2">
                <Label htmlFor="expiryDate">{t('Expiry date')}</Label>
                <Input id="expiryDate" type="date" {...register('expiryDate')} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="file">{t('File')}</Label>
              {/* Native file input's button is browser-rendered ('Browse')
                  and untranslatable → showed English on the Greek realm.
                  Hide it, drive from a translated Button. */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t('Choose file')}
                </Button>
                <span className="text-label text-ink-muted truncate">
                  {watch('file')?.name || t('No file selected')}
                </span>
              </div>
              <Input id="file" ref={fileInputRef} type="file" className="hidden" accept=".gif,.png,.jpg,.jpeg,.jpe,.pdf" onChange={(e) => setValue('file', e.target.files?.[0], { shouldValidate: true })} />
              {errors.file && <p className="text-sm text-destructive">{translateFileError(t, errors.file.message)}</p>}
            </div>
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>{t('Cancel')}</Button>
          <Button onClick={() => formRef.current?.requestSubmit()}>{t('Upload')}</Button>
        </>
      )}
    />
  );
}
