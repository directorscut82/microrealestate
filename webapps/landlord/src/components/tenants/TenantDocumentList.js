import {
  BlankDocumentIllustration,
  TermsDocumentIllustration
} from '../Illustrations';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '../ui/drawer';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import ConfirmDialog from '../ConfirmDialog';
import DocumentList from '../DocumentList';
import Loading from '../Loading';
import { LuPlusCircle } from 'react-icons/lu';
import { QueryKeys } from '../../utils/restcalls';
import RichTextEditorDialog from '../RichTextEditor/RichTextEditorDialog';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetcher } from '../../utils/fetch';
import useTranslation from 'next-translate/useTranslation';

function TenantDocumentList({ tenant, templates = [], documents = [], disabled = false }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [openDocumentCreatorDialog, setOpenDocumentCreatorDialog] = useState(false);
  const [openDocumentToRemoveDialog, setOpenDocumentToRemoveDialog] = useState(false);
  const [selectedDocumentToRemove, setSelectedDocumentToRemove] = useState(null);
  const [openTextDocumentDialog, setOpenTextDocumentDialog] = useState(false);
  const [selectedTextDocument, setSelectedTextDocument] = useState(null);

  const createDocMutation = useMutation({
    mutationFn: async (doc) => {
      const response = await apiFetcher().post('/documents', doc);
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKeys.DOCUMENTS] })
  });

  const updateDocMutation = useMutation({
    mutationFn: async (doc) => {
      const response = await apiFetcher().patch('/documents', doc);
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

  const textDocuments = useMemo(() =>
    documents.filter(({ tenantId, type }) => tenant?._id === tenantId && type === 'text'),
    [documents, tenant?._id]
  );

  const menuItems = useMemo(() => {
    const filteredTemplates = templates.filter(
      ({ type, linkedResourceIds = [] }) =>
        type === 'text' && linkedResourceIds.includes(tenant?.leaseId)
    );
    return [
      { key: 'blank', label: t('Blank document'), illustration: <BlankDocumentIllustration />, value: {} },
      ...filteredTemplates.map((template) => ({
        key: template._id, label: template.name,
        illustration: <TermsDocumentIllustration />, value: template
      }))
    ];
  }, [t, templates, tenant?.leaseId]);

  const handleClickEdit = useCallback((doc) => {
    setSelectedTextDocument(doc);
    setOpenTextDocumentDialog(true);
  }, []);

  const handleClickAddText = useCallback(async (template) => {
    try {
      setCreatingDocument(true);
      const data = await createDocMutation.mutateAsync({
        name: template.name || t('Untitled document'),
        type: 'text', templateId: template._id,
        tenantId: tenant?._id, leaseId: tenant?.leaseId
      });
      setSelectedTextDocument(data);
      setOpenDocumentCreatorDialog(false);
      setOpenTextDocumentDialog(true);
    } catch {
      toast.error(t('Something went wrong'));
    } finally {
      setCreatingDocument(false);
    }
  }, [createDocMutation, tenant, t]);

  const handleLoadTextDocument = useCallback(async () => {
    if (!selectedTextDocument?._id) {
      toast.error(t('Something went wrong'));
      return '';
    }
    return selectedTextDocument.contents;
  }, [selectedTextDocument, t]);

  const handleSaveTextDocument = useCallback(async (title, contents, html) => {
    try {
      await updateDocMutation.mutateAsync({ ...selectedTextDocument, name: title, contents, html });
    } catch {
      toast.error(t('Something went wrong'));
    }
  }, [selectedTextDocument, updateDocMutation, t]);

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
      <Button
        variant="secondary"
        onClick={() => setOpenDocumentCreatorDialog(true)}
        disabled={disabled}
        className="mb-2 gap-2"
        data-cy="addTenantTextDocument"
      >
        <LuPlusCircle className="size-4" />
        {t('Create a document')}
      </Button>
      <Drawer open={openDocumentCreatorDialog} onOpenChange={setOpenDocumentCreatorDialog} dismissible={!creatingDocument}>
        <DrawerContent className="w-full h-full p-4">
          <DrawerHeader className="flex items-center justify-between p-0">
            <DrawerTitle>{t('Create a document')}</DrawerTitle>
            <Button variant="secondary" onClick={() => setOpenDocumentCreatorDialog(false)}>{t('Close')}</Button>
          </DrawerHeader>
          <div className="flex flex-wrap mx-auto lg:mx-0 gap-4 mt-10">
            {menuItems.map((item) => (
              <Card key={item.key} onClick={() => handleClickAddText(item.value)} className="w-96 cursor-pointer" data-cy={`template-${item.label.replace(/\s/g, '')}`}>
                <CardHeader><CardTitle className="h-12"><Button variant="link" className="text-xl">{item.label}</Button></CardTitle></CardHeader>
                <CardContent>{item.illustration}</CardContent>
              </Card>
            ))}
          </div>
          {creatingDocument ? <Loading fullScreen={false} className="absolute top-0 left-0 right-0 bottom-0 bg-secondary/50" /> : null}
        </DrawerContent>
      </Drawer>

      <DocumentList documents={textDocuments} onEdit={handleClickEdit} onDelete={(docToRemove) => { setSelectedDocumentToRemove(docToRemove); setOpenDocumentToRemoveDialog(true); }} disabled={disabled} />

      <RichTextEditorDialog open={openTextDocumentDialog} setOpen={setOpenTextDocumentDialog} onLoad={handleLoadTextDocument} onSave={handleSaveTextDocument} title={selectedTextDocument?.name} editable={!disabled} />

      <ConfirmDialog title={t('Are you sure to remove this document?')} subTitle={selectedDocumentToRemove?.name} open={openDocumentToRemoveDialog} setOpen={setOpenDocumentToRemoveDialog} data={selectedDocumentToRemove} onConfirm={handleDeleteDocument} />
    </>
  );
}

export default TenantDocumentList;
