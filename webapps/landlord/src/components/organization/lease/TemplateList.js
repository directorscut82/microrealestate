import { useCallback, useMemo, useState } from 'react';
import {
  createTemplate,
  deleteTemplate,
  fetchTemplates,
  QueryKeys,
  updateTemplate
} from '../../../utils/restcalls';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../ui/button';
import ConfirmDialog from '../../ConfirmDialog';
import DocumentList from '../../DocumentList';
import FileDescriptorDialog from './FileDescriptorDialog';
import { LuPlusCircle } from 'react-icons/lu';
import RichTextEditorDialog from '../../RichTextEditor/RichTextEditorDialog';
import { apiFetcher } from '../../../utils/fetch';
import useTranslation from 'next-translate/useTranslation';

function TemplateList({ leaseId }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [openConfirmRemoveTemplate, setOpenConfirmRemoveTemplate] = useState(false);
  const [selectedTemplateToRemove, setSelectedTemplateToRemove] = useState(null);
  const [openTemplate, setOpenTemplate] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [openFileDescriptor, setOpenFileDescriptor] = useState(false);
  const [selectedFileDescriptor, setSelectedFileDescriptor] = useState(null);

  const { data: allTemplates = [] } = useQuery({
    queryKey: [QueryKeys.TEMPLATES],
    queryFn: fetchTemplates,
    refetchOnMount: 'always',
    staleTime: 0
  });

  const { data: fields = [] } = useQuery({
    queryKey: [QueryKeys.TEMPLATES, 'fields'],
    queryFn: async () => {
      const response = await apiFetcher().get('/templates/fields');
      return response.data;
    },
    staleTime: Infinity
  });

  const templates = useMemo(
    () => {
      if (!leaseId) return allTemplates;
      return allTemplates.filter(({ linkedResourceIds = [] }) =>
        linkedResourceIds.map(String).includes(String(leaseId))
      );
    },
    [allTemplates, leaseId]
  );

  const saveMutation = useMutation({
    mutationFn: (tmpl) => tmpl._id ? updateTemplate(tmpl) : createTemplate(tmpl),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKeys.TEMPLATES] })
  });

  const removeMutation = useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKeys.TEMPLATES] })
  });

  const handleLoadTemplate = useCallback(async () => {
    if (!selectedTemplate?._id) return '';
    const tmpl = allTemplates.find(({ _id }) => _id === selectedTemplate._id);
    return tmpl?.contents || '';
  }, [selectedTemplate?._id, allTemplates]);

  const onSaveTemplate = useCallback(async (template) => {
    try {
      const data = await saveMutation.mutateAsync(template);
      if (!template._id) {
        if (data.type === 'text') selectedTemplate._id = data._id;
        else if (data.type === 'fileDescriptor') selectedFileDescriptor._id = data._id;
      }
    } catch (error) { console.error(error); }
  }, [saveMutation, selectedFileDescriptor, selectedTemplate]);

  const handleSaveTextTemplate = useCallback(async (title, contents, html) => {
    await onSaveTemplate({ _id: selectedTemplate?._id, name: title, type: 'text', contents, html, linkedResourceIds: leaseId ? [String(leaseId)] : [] });
  }, [onSaveTemplate, selectedTemplate?._id, leaseId]);

  const handleSaveFileDescriptor = useCallback(async (template) => {
    await onSaveTemplate({ ...template, _id: selectedFileDescriptor?._id, type: 'fileDescriptor', linkedResourceIds: leaseId ? [String(leaseId)] : [] });
  }, [onSaveTemplate, selectedFileDescriptor?._id, leaseId]);

  const handleDeleteTemplate = useCallback((template) => {
    setSelectedTemplateToRemove(template);
    setOpenConfirmRemoveTemplate(true);
  }, []);

  const handleConfirmDeleteTemplate = useCallback(async () => {
    if (!selectedTemplateToRemove) return;
    try {
      if (selectedTemplateToRemove.linkedResourceIds?.length <= 1) {
        await removeMutation.mutateAsync([selectedTemplateToRemove._id]);
      } else {
        await saveMutation.mutateAsync({
          ...selectedTemplateToRemove,
          linkedResourceIds: leaseId ? selectedTemplateToRemove.linkedResourceIds.filter((_id) => leaseId !== _id) : selectedTemplateToRemove.linkedResourceIds
        });
      }
    } catch (error) { console.error(error); }
  }, [selectedTemplateToRemove, removeMutation, saveMutation, leaseId]);

  const handleClickEdit = useCallback((template) => {
    if (template.type === 'text') { setSelectedTemplate(template); setOpenTemplate(true); }
    else if (template.type === 'fileDescriptor') { setSelectedFileDescriptor(template); setOpenFileDescriptor(template); }
  }, []);

  const handleClickAddFileDescriptor = useCallback(() => { setSelectedFileDescriptor({}); setOpenFileDescriptor(true); }, []);
  const handleClickAddText = useCallback(() => { setSelectedTemplate({}); setOpenTemplate(true); }, []);

  return (
    <>
      <div className="flex flex-wrap gap-4 mb-4">
        <Button variant="secondary" onClick={handleClickAddFileDescriptor} data-cy="addFileDescriptor" className="w-full justify-start sm:justify-normal sm:w-fit gap-2">
          <LuPlusCircle className="size-4" />{t('Upload template')}
        </Button>
        <Button variant="secondary" onClick={handleClickAddText} data-cy="addTextDocument" className="w-full justify-start sm:justify-normal sm:w-fit gap-2">
          <LuPlusCircle className="size-4" />{t('Text template')}
        </Button>
      </div>
      <DocumentList documents={templates} onEdit={handleClickEdit} onDelete={handleDeleteTemplate} />
      <RichTextEditorDialog open={openTemplate} setOpen={setOpenTemplate} onLoad={handleLoadTemplate} onSave={handleSaveTextTemplate} title={selectedTemplate?.name} fields={fields} />
      <FileDescriptorDialog open={openFileDescriptor} setOpen={setOpenFileDescriptor} data={selectedFileDescriptor} onSave={handleSaveFileDescriptor} />
      <ConfirmDialog title={t('Are you sure to remove this template document?')} subTitle={selectedTemplateToRemove?.name} open={openConfirmRemoveTemplate} setOpen={setOpenConfirmRemoveTemplate} data={selectedTemplateToRemove} onConfirm={handleConfirmDeleteTemplate} />
    </>
  );
}

export default TemplateList;
