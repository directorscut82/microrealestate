import { Card, CardContent } from '../ui/card';
import { useCallback, useContext, useMemo, useState } from 'react';
import { Alert } from '../ui/alert';
import ConfirmDialog from '../ConfirmDialog';
import { downloadDocument } from '../../utils/fetch';
import { QueryKeys } from '../../utils/restcalls';
import ImageViewer from '../ImageViewer/ImageViewer';
import { LuAlertTriangle } from 'react-icons/lu';
import PdfViewer from '../PdfViewer/PdfViewer';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import UploadDialog from '../UploadDialog';
import UploadFileItem from './UploadFileItem';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetcher } from '../../utils/fetch';
import useTranslation from 'next-translate/useTranslation';

function UploadFileList({ tenant, templates = [], documents = [], disabled }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const queryClient = useQueryClient();
  const [openDocumentToRemoveConfirmDialog, setOpenDocumentToRemoveConfirmDialog] = useState(false);
  const [selectedDocumentToRemove, setSelectedDocumentToRemove] = useState(null);
  const [openUploadDocumentDialog, setOpenUploadDocumentDialog] = useState(false);
  const [selectedUploadDocument, setSelectedUploadDocument] = useState(null);
  const [openImageViewer, setOpenImageViewer] = useState(false);
  const [pdfDoc, setPdfDoc] = useState();
  const [openPdfViewer, setOpenPdfViewer] = useState(false);

  const files = useMemo(() => {
    const existingDocuments = documents
      .filter(({ tenantId, type }) => tenant?._id === tenantId && type === 'file')
      .reduce((acc, doc) => {
        acc[doc.templateId] = {
          _id: doc._id, url: doc.url, versionId: doc.versionId,
          mimeType: doc.mimeType, expiryDate: doc.expiryDate,
          createdDate: doc.createdDate, updatedDate: doc.updatedDate
        };
        return acc;
      }, {});

    return templates
      .filter((template) => {
        if (tenant?.terminated) {
          return template.type === 'fileDescriptor' && template.linkedResourceIds?.includes(tenant?.leaseId);
        }
        return template.type === 'fileDescriptor' && template.linkedResourceIds?.includes(tenant?.leaseId) && !template.requiredOnceContractTerminated;
      })
      .map((template) => ({ template, document: existingDocuments[template._id] }));
  }, [documents, templates, tenant?._id, tenant?.leaseId, tenant?.terminated]);

  const createDocMutation = useMutation({
    mutationFn: async (doc) => {
      const response = await apiFetcher().post('/documents', doc);
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKeys.DOCUMENTS] })
  });

  const deleteDocMutation = useMutation({
    mutationFn: async (ids) => {
      await apiFetcher().delete(`/documents/${ids.join(',')}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKeys.DOCUMENTS] })
  });

  const handleView = useCallback((doc, template) => {
    if (doc.mimeType.indexOf('image/') !== -1) {
      setOpenImageViewer({ url: `/documents/${doc._id}`, title: doc.name });
    } else if (doc.mimeType.indexOf('application/pdf') !== -1) {
      setPdfDoc({ url: `/documents/${doc._id}`, title: template.name });
      setOpenPdfViewer(true);
    } else {
      downloadDocument({ endpoint: `/documents/${doc._id}`, documentName: doc.name });
    }
  }, []);

  const handleUpload = useCallback((template) => {
    setSelectedUploadDocument(template);
    setOpenUploadDocumentDialog(true);
  }, []);

  const handleDelete = useCallback((doc) => {
    setSelectedDocumentToRemove(doc);
    setOpenDocumentToRemoveConfirmDialog(true);
  }, []);

  const handleSaveUploadDocument = useCallback(async (doc) => {
    try {
      await createDocMutation.mutateAsync({
        tenantId: tenant?._id, leaseId: tenant?.leaseId,
        templateId: doc.template._id, type: 'file',
        name: doc.name || t('Untitled document'), description: doc.description || '',
        mimeType: doc.mimeType || '', expiryDate: doc.expiryDate || '',
        url: doc.url || '', versionId: doc.versionId
      });
    } catch {
      toast.error(t('Something went wrong'));
    }
  }, [createDocMutation, tenant, t]);

  const handleDeleteDocument = useCallback(async () => {
    if (!selectedDocumentToRemove) return;
    try {
      await deleteDocMutation.mutateAsync([selectedDocumentToRemove._id]);
    } catch {
      toast.error(t('Something went wrong'));
    }
  }, [selectedDocumentToRemove, deleteDocMutation, t]);

  return (
    <>
      {!store.organization.canUploadDocumentsInCloud ? (
        <Alert variant="warning" className="mb-2">
          <div className="flex items-center gap-4">
            <LuAlertTriangle className="size-6" />
            <div className="text-sm">
              {t('Unable to upload documents without configuring the cloud storage service in Settings page')}
            </div>
          </div>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="p-0 h-72 overflow-y-auto">
          {files.map(({ template, document }) => (
            <UploadFileItem
              key={template._id}
              template={template}
              document={document}
              disabled={disabled || !store.organization.canUploadDocumentsInCloud}
              onView={handleView}
              onUpload={handleUpload}
              onDelete={handleDelete}
            />
          ))}
        </CardContent>
      </Card>

      <UploadDialog
        open={openUploadDocumentDialog}
        setOpen={setOpenUploadDocumentDialog}
        data={selectedUploadDocument}
        onSave={handleSaveUploadDocument}
        tenant={tenant}
        templates={templates}
      />

      <ConfirmDialog
        title={t('Are you sure to remove this document?')}
        subTitle={selectedDocumentToRemove?.name}
        open={openDocumentToRemoveConfirmDialog}
        setOpen={setOpenDocumentToRemoveConfirmDialog}
        data={selectedDocumentToRemove}
        onConfirm={handleDeleteDocument}
      />

      <ImageViewer open={openImageViewer} setOpen={setOpenImageViewer} />
      <PdfViewer open={openPdfViewer} setOpen={setOpenPdfViewer} pdfDoc={pdfDoc} />
    </>
  );
}

export default UploadFileList;
