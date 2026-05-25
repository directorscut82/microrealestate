'use client';
import { Button, ButtonProps } from '@/components/ui/button';
import { Download } from 'lucide-react';
import fileDownload from 'js-file-download';
import { Invoice } from '@/types';
import useApiFetcher from '@/utils/fetch/client';
import useTranslation from '@/utils/i18n/client/useTranslation';

export function DownLoadButton({
  tenant,
  invoice
}: {
  tenant: { id: string; name: string };
  invoice: Invoice;
} & ButtonProps) {
  const apiFetcher = useApiFetcher();
  const { t } = useTranslation();

  const sanitizeForFilename = (value: string, fallback: string) => {
    // Strip path separators, control chars, and characters that are unsafe on
    // common filesystems. Collapse whitespace, trim, and clamp to 64 chars.
    const cleaned = String(value || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 64);
    return cleaned || fallback;
  };

  const handleClick = async () => {
    const response = await apiFetcher.get(
      `/api/v2/documents/invoice/${tenant.id}/${invoice.term}`,
      {
        responseType: 'blob'
      }
    );
    const safeTenant = sanitizeForFilename(tenant.name, 'tenant');
    const safeLabel = sanitizeForFilename(t('invoice'), 'invoice');
    fileDownload(
      response.data,
      `${safeTenant}-${invoice.term}-${safeLabel}.pdf`
    );
  };

  return (
    <Button variant="ghost" onClick={handleClick}>
      <Download className="h-4 w-4" />
    </Button>
  );
}
