import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import moment from 'moment';
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
// time. This keeps the schema definition free of t() while still not leaking
// English to the UI.
const FILE_REQUIRED = 'file_required';
const FILE_TOO_BIG = 'file_too_big';
const FILE_TYPE_INVALID = 'file_type_invalid';
const FILE_EMPTY = 'file_empty';
const TEMPLATE_REQUIRED = 'template_required';
const EXPIRY_REQUIRED = 'expiry_required';

// `requiresExpiry` comes from the selected template's hasExpiryDate. It cannot
// be baked into a module-level schema, so the schema is rebuilt when the
// selected template changes (react-hook-form re-reads options every render).
function buildSchema(requiresExpiry) {
  return z.object({
    templateId: z.string().min(1, { message: TEMPLATE_REQUIRED }),
    expiryDate: z.string().optional(),
    file: z.any()
      .refine((f) => f instanceof File, { message: FILE_REQUIRED })
      // A 0-byte file passes `size <= MAX` and, because the browser derives the
      // MIME from the extension, passes the type check too — so the request
      // went out and came back as an opaque 415 from the server's magic-byte
      // sniff. Reject it here with its own message.
      .refine((f) => !(f instanceof File) || f.size > 0, { message: FILE_EMPTY })
      .refine((f) => f instanceof File && f.size <= UPLOAD_MAX_SIZE, { message: FILE_TOO_BIG })
      .refine((f) => f instanceof File && SUPPORTED_MIMETYPES.includes(f.type), { message: FILE_TYPE_INVALID })
  }).superRefine((data, ctx) => {
    // A document the landlord declared as expiring, saved with NO expiry, is
    // counted as permanently satisfying the requirement (occupantmanager treats
    // a missing expiryDate as never-expires), so the expired scan never
    // resurfaces as missing. Require the date the template asked for.
    if (requiresExpiry && !data.expiryDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiryDate'],
        message: EXPIRY_REQUIRED
      });
    }
  });
}

function translateFormError(t, message) {
  switch (message) {
    case FILE_REQUIRED:
      return t('File is required');
    case FILE_TOO_BIG:
      return t('File is too big. Maximum size is 2Go.');
    case FILE_TYPE_INVALID:
      return t('Only images or pdf are accepted.');
    case FILE_EMPTY:
      return t('The file is empty');
    case TEMPLATE_REQUIRED:
      return t('Select the document type');
    case EXPIRY_REQUIRED:
      return t('Expiry date is required for this document');
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

  // Whether the SELECTED template declares an expiry date is only knowable
  // after the form exists (it derives from watch('templateId')), so the
  // resolver reads it from a ref instead of being rebuilt. The ref is synced in
  // an effect below; effects flush before the next user event, so a submit
  // always validates against the currently selected template.
  const requiresExpiryRef = useRef(false);
  const resolver = useCallback(
    (values, context, options) =>
      zodResolver(buildSchema(requiresExpiryRef.current))(
        values,
        context,
        options
      ),
    []
  );

  // `selectedTemplate` (the row the user clicked Upload on) arrives as null on
  // first mount — UploadFileList renders this dialog unconditionally and only
  // sets `data` when a row's Upload button is pressed. useForm captures
  // defaultValues ONCE, so templateId stayed '' forever, zod's min(1) rejected
  // every submit, and the Upload button did nothing with no error shown.
  // Seeding the form when the dialog opens (the reset effect below) is what
  // makes the submit reach _onSubmit at all. Do not drop it.
  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm({
    resolver,
    defaultValues: { templateId: selectedTemplate?._id || '', expiryDate: '', file: undefined }
  });

  const templateId = watch('templateId');
  const selectedTpl = useMemo(
    () => templates.find((t) => t.id === templateId)?.template || selectedTemplate,
    [templateId, templates, selectedTemplate]
  );

  const requiresExpiry = !!selectedTpl?.hasExpiryDate;
  useEffect(() => {
    requiresExpiryRef.current = requiresExpiry;
  }, [requiresExpiry]);

  const expiryDate = watch('expiryDate');
  // Both sides UTC so the comparison cannot flip a calendar day on Athens time
  // (the codebase's most-bitten gotcha).
  const expiryIsNotFuture = useMemo(() => {
    if (!expiryDate) return false;
    const parsed = moment.utc(expiryDate, 'YYYY-MM-DD', true);
    if (!parsed.isValid()) return false;
    return !parsed.isAfter(moment.utc().startOf('day'));
  }, [expiryDate]);

  useEffect(() => {
    if (open) {
      reset({
        templateId: selectedTemplate?._id || '',
        expiryDate: '',
        file: undefined
      });
    }
  }, [open, selectedTemplate?._id, reset]);

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
        // The server sniffs magic bytes and answers 415 when the content does
        // not match the extension. The generic toast hid that, so a renamed or
        // truncated file looked like a network failure.
        if (error?.response?.status === 415) {
          toast.error(t('The file content does not match its extension'));
        } else {
          toast.error(t('Cannot upload document'));
        }
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
                <Select value={templateId} onValueChange={(val) => setValue('templateId', val, { shouldValidate: true })}>
                  <SelectTrigger><SelectValue placeholder={t('Select a document')} /></SelectTrigger>
                  <SelectContent>
                    {templates.map((tpl) => (<SelectItem key={tpl.id} value={tpl.value}>{tpl.label}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {/* Rendered OUTSIDE the else branch on purpose: when the dialog is
                opened from a template row the Select is not shown, so an error
                rendered only in that branch made a blocked submit completely
                silent — the Upload button appeared to do nothing. */}
            {errors.templateId && (
              <p className="text-sm text-destructive">
                {translateFormError(t, errors.templateId.message)}
              </p>
            )}
            {requiresExpiry && (
              <div className="space-y-2">
                <Label htmlFor="expiryDate">{t('Expiry date')}</Label>
                <Input id="expiryDate" type="date" {...register('expiryDate')} />
                {errors.expiryDate && (
                  <p className="text-sm text-destructive">
                    {translateFormError(t, errors.expiryDate.message)}
                  </p>
                )}
                {/* WARN, not block: back-filing an already-expired scan for the
                    record is legitimate. But the row flips straight to «Το
                    έγγραφο έχει λήξει» and reports the file missing again, so
                    say so BEFORE the upload rather than after. UploadFileItem
                    uses isSameOrAfter, so today counts as expired too — keep
                    this bound identical. */}
                {!errors.expiryDate && expiryIsNotFuture && (
                  <p className="text-sm text-warning">
                    {t('Expiry date must be after today')}
                  </p>
                )}
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
              {errors.file && <p className="text-sm text-destructive">{translateFormError(t, errors.file.message)}</p>}
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
