import {
  confirmBillPayment,
  parsePaymentReceipts,
  QueryKeys
} from '../../utils/restcalls';
import {
  LuAlertTriangle,
  LuCheckCircle,
  LuFileWarning,
  LuReceipt
} from 'react-icons/lu';
import React, { useCallback, useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import FileDropZone from '../ui/file-drop-zone';
import NumberFormat from '../NumberFormat';
import ResponsiveDialog from '../ResponsiveDialog';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

export default function PaymentReceiptDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setState('idle');
    setFiles([]);
    setResults([]);
  }, [setOpen]);

  const handleParse = useCallback(async () => {
    if (files.length === 0) return;
    setState('loading');

    try {
      const data = await parsePaymentReceipts(files);
      setResults(data);
      setState('preview');
    } catch (error) {
      toast.error(t('Failed to parse payment receipts'));
      setState('idle');
    }
  }, [files, t]);

  const handleConfirm = useCallback(async () => {
    const matched = results.filter((r) => r.success && r.billId);
    if (matched.length === 0) return;

    setState('confirming');

    try {
      const billIds = matched.map((r) => r.billId);
      await confirmBillPayment(billIds);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BILLS] });
      toast.success(
        t('{{count}} bill(s) marked as paid', { count: billIds.length })
      );
      handleClose();
    } catch (error) {
      toast.error(t('Failed to confirm payment'));
      setState('preview');
    }
  }, [results, handleClose, queryClient, t]);

  const matchedCount = results.filter((r) => r.success && r.billId).length;
  const failedCount = results.filter((r) => !r.success).length;
  const isLoading = state === 'loading' || state === 'confirming';

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Payment Receipts')}
      renderContent={() => (
        <div className="pt-4 space-y-4">
          {(state === 'idle' || state === 'loading') && (
            <FileDropZone
              multiple
              files={files}
              onFilesChange={setFiles}
              disabled={isLoading}
              description={t(
                'Upload payment receipt PDFs. RF codes are matched to pending bills.'
              )}
            />
          )}

          {state === 'preview' && results.length > 0 && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              <div className="flex gap-2 flex-wrap">
                {matchedCount > 0 && (
                  <Badge variant="default" className="gap-1">
                    <LuCheckCircle className="size-3" />
                    {matchedCount} {t('matched')}
                  </Badge>
                )}
                {failedCount > 0 && (
                  <Badge variant="destructive" className="gap-1">
                    <LuFileWarning className="size-3" />
                    {failedCount} {t('not found')}
                  </Badge>
                )}
              </div>

              {results.map((result, idx) => (
                <div
                  key={idx}
                  className={`border rounded-md p-4 space-y-2 ${
                    result.success
                      ? ''
                      : 'border-destructive/30 bg-destructive/5'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {result.success ? (
                      <LuReceipt className="size-5 text-primary shrink-0 mt-0.5" />
                    ) : (
                      <LuFileWarning className="size-5 text-destructive shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">
                        {result.filename}
                      </div>
                      {result.rfCode && (
                        <div className="font-mono text-xs text-muted-foreground">
                          RF: {result.rfCode}
                        </div>
                      )}
                    </div>
                  </div>

                  {result.success ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm ml-7">
                      <div className="text-muted-foreground">
                        {t('Building')}
                      </div>
                      <div>{result.buildingName}</div>
                      <div className="text-muted-foreground">
                        {t('Expense')}
                      </div>
                      <div>{result.expenseName}</div>
                      <div className="text-muted-foreground">
                        {t('Amount')}
                      </div>
                      <div>
                        <NumberFormat value={result.totalAmount} />
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-destructive ml-7">
                      {result.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          {state === 'idle' && files.length > 0 && (
            <Button onClick={handleParse} data-cy="parseReceipts">
              {t('Continue')}
            </Button>
          )}
          {state === 'preview' && matchedCount > 0 && (
            <Button onClick={handleConfirm} data-cy="confirmPayment">
              {t('Confirm Payment')} ({matchedCount})
            </Button>
          )}
        </>
      )}
    />
  );
}
