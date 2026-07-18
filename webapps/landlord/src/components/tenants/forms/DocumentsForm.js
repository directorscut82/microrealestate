import { Button } from '../../ui/button';
import { Separator } from '../../ui/separator';
import { fetchDocuments, fetchTemplates, QueryKeys } from '../../../utils/restcalls';
import DocumentsPanel from '../../documents/DocumentsPanel';
import TenantDocumentList from '../TenantDocumentList';
import UploadFileList from '../UploadFileList';
import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

function Section({ label, children }) {
  return (
    <div className="pb-10">
      <div className="text-xl">{label}</div>
      <Separator className="mt-1 mb-2" />
      {children}
    </div>
  );
}

export default function DocumentsForm({ tenant, onSubmit, readOnly }) {
  const { t } = useTranslation('common');

  const { data: templates = [] } = useQuery({
    queryKey: [QueryKeys.TEMPLATES],
    queryFn: fetchTemplates
  });

  const { data: documents = [] } = useQuery({
    queryKey: [QueryKeys.DOCUMENTS],
    queryFn: fetchDocuments
  });

  const handleNext = useCallback(() => {
    onSubmit();
  }, [onSubmit]);

  return (
    <>
      {/* Generic per-tenant uploads (any file, no template slot needed).
          The template-slot list below stays — it is the surface for
          REQUIRED/compulsory documents; before this panel existed the tab
          rendered completely empty (no upload affordance, no hint) unless
          fileDescriptor templates had been configured in Settings. */}
      {tenant?._id && tenant?.leaseId ? (
        <div className="pb-10">
          <DocumentsPanel
            entity={{ tenantId: tenant._id, leaseId: tenant.leaseId }}
            folder={`${tenant.name || tenant._id}/contract_scanned_documents`}
          />
        </div>
      ) : null}

      <Section label={t('Required documents')}>
        <UploadFileList tenant={tenant} templates={templates} documents={documents} disabled={readOnly} mb={4} />
      </Section>

      <Section label={t('Documents from templates')}>
        <TenantDocumentList tenant={tenant} templates={templates} documents={documents} disabled={readOnly} />
      </Section>

      {!readOnly && (
        <Button onClick={handleNext} data-cy="submit">
          {t('Save')}
        </Button>
      )}
    </>
  );
}
