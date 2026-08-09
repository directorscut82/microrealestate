import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../ui/card';
import {
  createDocument,
  deleteDocuments,
  fetchDocuments,
  QueryKeys,
  updateDocument,
  deleteDocumentByKey
} from '../../utils/restcalls';
import { downloadDocument, uploadDocument } from '../../utils/fetch';
import {
  LuDownload,
  LuFile,
  LuFileText,
  LuImage,
  LuPencil,
  LuTrash,
  LuUpload
} from 'react-icons/lu';
import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import ConfirmDialog from '../ConfirmDialog';
import { Input } from '../ui/input';
import moment from 'moment';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

/**
 * DocumentsPanel — ONE generic upload/list/download/rename/delete surface,
 * mounted per entity:
 *   <DocumentsPanel entity={{ tenantId, leaseId }} folder="..."/>
 *   <DocumentsPanel entity={{ buildingId }} folder="..."/>
 *   <DocumentsPanel entity={{ ownerKey }} folder="..."/>
 *
 * Storage: POST /documents/upload (B2 when configured) then POST /documents
 * with the entity id — the same two-step pipeline the tenant compulsory-docs
 * feature uses. Distinct from the template-slot list (UploadFileList), which
 * remains the surface for REQUIRED documents.
 */
export default function DocumentsPanel({
  entity,
  folder,
  title,
  description,
  className
}) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const queryClient = useQueryClient();
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [toDelete, setToDelete] = useState(null);

  const entityFilter = useMemo(() => {
    if (entity?.tenantId) return { tenantId: entity.tenantId };
    if (entity?.buildingId) return { buildingId: entity.buildingId };
    if (entity?.ownerKey) return { ownerKey: entity.ownerKey };
    return null;
  }, [entity]);

  const { data: documents = [], isLoading } = useQuery({
    queryKey: [QueryKeys.DOCUMENTS, entityFilter],
    queryFn: () => fetchDocuments(entityFilter),
    enabled: !!entityFilter
  });

  const files = useMemo(
    () =>
      (documents || [])
        .filter((d) => d.type === 'file')
        .sort(
          (a, b) => new Date(b.createdDate || 0) - new Date(a.createdDate || 0)
        ),
    [documents]
  );

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: [QueryKeys.DOCUMENTS] }),
    [queryClient]
  );

  const canUpload = store.organization?.canUploadDocumentsInCloud;

  const handlePick = useCallback(() => fileInputRef.current?.click(), []);

  const handleFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      setUploading(true);
      // Two calls with no rollback: the bytes land in storage first, then the
      // Document record is created. If the second fails the file is orphaned —
      // paid-for storage holding a file the app can never show or delete. Track
      // the key so the catch can clean up, the same way RepairList does for a
      // repair invoice (RepairList.js:636).
      let uploadedKey = null;
      try {
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const response = await uploadDocument({
          endpoint: '/documents/upload',
          documentName: baseName,
          file,
          folder
        });
        uploadedKey = response?.data?.key || null;
        await createDocument({
          ...entity,
          type: 'file',
          name: file.name,
          description: '',
          mimeType: file.type,
          url: response.data.key,
          versionId: response.data.versionId
        });
        invalidate();
        toast.success(t('Document uploaded'));
      } catch (error) {
        console.error(error);
        // The upload succeeded but the record did not — remove the orphaned file
        // rather than leave bytes nothing references.
        if (uploadedKey) {
          deleteDocumentByKey(uploadedKey).catch(() => {});
        }
        // Say WHICH step failed. «Something went wrong» gave the landlord no way
        // to tell a rejected file from a lost record, so they re-tried an upload
        // that had already stored its bytes.
        const status = error?.response?.status;
        toast.error(
          status === 413
            ? t('This file is too large to upload')
            : uploadedKey
              ? t('The file uploaded but could not be saved — please try again')
              : t('The file could not be uploaded')
        );
      } finally {
        setUploading(false);
      }
    },
    [entity, folder, invalidate, t]
  );

  const renameMutation = useMutation({
    mutationFn: updateDocument,
    onSuccess: () => {
      invalidate();
      setRenamingId(null);
    },
    onError: () => toast.error(t('Something went wrong'))
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDocuments,
    onSuccess: () => {
      invalidate();
      toast.success(t('Document deleted'));
    },
    onError: () => toast.error(t('Something went wrong'))
  });

  const iconFor = (doc) => {
    const mime = String(doc.mimeType || '');
    if (mime.startsWith('image/')) return LuImage;
    if (mime === 'application/pdf') return LuFileText;
    return LuFile;
  };

  return (
    <Card className={cn('', className)}>
      <ConfirmDialog
        title={t('Are you sure to remove this document?')}
        subTitle={toDelete?.name}
        open={!!toDelete}
        setOpen={(v) => !v && setToDelete(null)}
        onConfirm={() => {
          if (toDelete) deleteMutation.mutate([toDelete._id]);
          setToDelete(null);
        }}
      />
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <CardTitle className="font-sans text-title font-semibold text-ink">
              {title || t('Uploaded documents')}
            </CardTitle>
            {description ? (
              <CardDescription>{description}</CardDescription>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/gif"
            className="hidden"
            onChange={handleFile}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!canUpload || uploading}
            onClick={handlePick}
          >
            <LuUpload className="mr-1.5 size-4" />
            {uploading ? t('Uploading...') : t('Upload document')}
          </Button>
        </div>
        {!canUpload ? (
          <p className="text-label text-oxide">
            {t(
              'Configure the cloud storage (Backblaze B2) in Settings to upload documents'
            )}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? null : files.length === 0 ? (
          <div className="text-ink-muted text-sm py-4 px-1">
            {t('No documents uploaded yet')}
          </div>
        ) : (
          <ul className="divide-y divide-stone-line">
            {files.map((doc) => {
              const Icon = iconFor(doc);
              return (
                <li
                  key={doc._id}
                  className="flex items-center gap-3 py-2.5 px-1"
                >
                  <Icon
                    className="size-4 shrink-0 text-ink-muted"
                    aria-hidden="true"
                  />
                  <div className="flex-1 min-w-0">
                    {renamingId === doc._id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (renameValue.trim()) {
                            renameMutation.mutate({
                              _id: doc._id,
                              __v: doc.__v,
                              name: renameValue.trim()
                            });
                          }
                        }}
                      >
                        <Input
                          autoFocus
                          className="h-8"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                        />
                        <Button type="submit" size="sm" variant="secondary">
                          {t('Save')}
                        </Button>
                      </form>
                    ) : (
                      <>
                        <div className="text-sm font-medium text-ink truncate">
                          {doc.name}
                        </div>
                        <div className="text-label text-ink-muted">
                          {doc.createdDate
                            ? moment(doc.createdDate).format('DD/MM/YYYY')
                            : ''}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('Download')}
                      onClick={() =>
                        downloadDocument({
                          endpoint: `/documents/${doc._id}`,
                          documentName: doc.name
                        })
                      }
                    >
                      <LuDownload className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('Rename')}
                      onClick={() => {
                        setRenamingId(doc._id);
                        setRenameValue(doc.name || '');
                      }}
                    >
                      <LuPencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('Delete')}
                      onClick={() => setToDelete(doc)}
                    >
                      <LuTrash className="size-4 text-oxide" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
