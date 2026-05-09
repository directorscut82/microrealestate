import {
  confirmBills,
  parseBillPdfs,
  QueryKeys
} from '../../utils/restcalls';
import {
  LuAlertTriangle,
  LuCheckCircle,
  LuFileWarning,
  LuReceipt
} from 'react-icons/lu';
import React, { useCallback, useEffect, useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import FileDropZone from '../ui/file-drop-zone';
import NumberFormat from '../NumberFormat';
import ResponsiveDialog from '../ResponsiveDialog';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

function ResultCard({ result, onToggleReplace, replaceFlags }) {
  const { t } = useTranslation('common');

  if (!result.success) {
    return (
      <div className="border rounded-md p-4 space-y-2 border-destructive/30 bg-destructive/5">
        <div className="flex items-start gap-2">
          <LuFileWarning className="size-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-sm">{result.filename}</div>
            <div className="text-sm text-destructive">{result.error}</div>
          </div>
        </div>
      </div>
    );
  }

  const { parsed, match, existingAmount } = result;

  return (
    <div className="border rounded-md p-4 space-y-3">
      <div className="flex items-start gap-2">
        <LuReceipt className="size-5 text-primary shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{result.filename}</div>
          <div className="text-xs text-muted-foreground uppercase">
            {parsed.provider}
          </div>
        </div>
        {match && (
          <Badge variant="outline" className="shrink-0">
            {match.expenseName}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div className="text-muted-foreground">{t('Billing ID')}</div>
        <div className="font-mono text-xs">{parsed.billingId}</div>

        <div className="text-muted-foreground">{t('Amount')}</div>
        <div className="font-medium">
          <NumberFormat value={parsed.totalAmount} />
        </div>

        <div className="text-muted-foreground">{t('Period')}</div>
        <div>
          {new Date(parsed.periodStart).toLocaleDateString()} –{' '}
          {new Date(parsed.periodEnd).toLocaleDateString()}
        </div>

        {parsed.dueDate && (
          <>
            <div className="text-muted-foreground">{t('Due Date')}</div>
            <div>{new Date(parsed.dueDate).toLocaleDateString()}</div>
          </>
        )}

        {parsed.rfCode && (
          <>
            <div className="text-muted-foreground">{t('RF Code')}</div>
            <div className="font-mono text-xs">{parsed.rfCode}</div>
          </>
        )}
      </div>

      {!match && (
        <div className="flex items-center gap-2 text-sm text-warning">
          <LuAlertTriangle className="size-4" />
          {t('No matching expense found. Add a Billing ID to an expense first.')}
        </div>
      )}

      {match && existingAmount !== undefined && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 dark:bg-amber-950/30 dark:border-amber-800">
          <div className="flex items-start gap-2">
            <LuAlertTriangle className="size-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                {t('A bill already exists for this period')}
              </p>
              <p className="text-amber-700/80 dark:text-amber-300/80 text-xs mt-0.5">
                {t('Existing amount')}: <NumberFormat value={existingAmount} />
              </p>
              <button
                type="button"
                className="mt-2 text-xs font-medium underline text-amber-800 dark:text-amber-200"
                onClick={() => onToggleReplace(result.filename)}
              >
                {replaceFlags[result.filename]
                  ? t('Keep existing (cancel replace)')
                  : t('Replace existing bill')}
              </button>
            </div>
          </div>
        </div>
      )}

      {parsed.irisCodeBase64 && (
        <div className="flex justify-center pt-2">
          <img
            src={`data:image/png;base64,${parsed.irisCodeBase64}`}
            alt="IRIS QR"
            className="w-24 h-24"
          />
        </div>
      )}
    </div>
  );
}

export default function BillImportDialog({ open, setOpen, building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [replaceFlags, setReplaceFlags] = useState({});

  useEffect(() => {
    if (!open) {
      setState('idle');
      setFiles([]);
      setResults([]);
      setReplaceFlags({});
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleParse = useCallback(async () => {
    if (files.length === 0) return;
    setState('loading');

    try {
      const data = await parseBillPdfs(files);
      setResults(data);
      setState('preview');
    } catch (error) {
      console.error('Bill parse error:', error);
      toast.error(t('Failed to parse bill PDFs'));
      setState('idle');
    }
  }, [files, t]);

  const handleConfirm = useCallback(async () => {
    const confirmable = results.filter((r) => r.success && r.match);
    if (confirmable.length === 0) return;

    setState('confirming');

    try {
      const billsToConfirm = confirmable.map((r) => ({
        buildingId: r.match.buildingId,
        expenseId: r.match.expenseId,
        provider: r.parsed.provider,
        billingId: r.parsed.billingId,
        totalAmount: r.parsed.totalAmount,
        periodStart: r.parsed.periodStart,
        periodEnd: r.parsed.periodEnd,
        issueDate: r.parsed.issueDate,
        dueDate: r.parsed.dueDate,
        term: r.parsed.proposedTerm,
        rfCode: r.parsed.rfCode,
        irisCodeBase64: r.parsed.irisCodeBase64,
        replaceExisting: !!replaceFlags[r.filename]
      }));

      await confirmBills(billsToConfirm);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BILLS] });
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building?._id]
      });
      toast.success(
        t('{{count}} bill(s) imported successfully', {
          count: billsToConfirm.length
        })
      );
      handleClose();
    } catch (error) {
      console.error('Bill confirm error:', error);
      toast.error(t('Failed to save bills'));
      setState('preview');
    }
  }, [results, replaceFlags, building, handleClose, queryClient, t]);

  const handleToggleReplace = useCallback((filename) => {
    setReplaceFlags((prev) => ({
      ...prev,
      [filename]: !prev[filename]
    }));
  }, []);

  const confirmableCount = results.filter((r) => r.success && r.match).length;
  const failedCount = results.filter((r) => !r.success).length;
  const unmatchedCount = results.filter(
    (r) => r.success && !r.match
  ).length;
  const isLoading = state === 'loading' || state === 'confirming';

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Import Bills')}
      renderContent={() => (
        <div className="pt-4 space-y-4">
          {(state === 'idle' || state === 'loading') && (
            <FileDropZone
              multiple
              files={files}
              onFilesChange={setFiles}
              disabled={isLoading}
              description={t(
                'Upload utility bill PDFs (DEH). Bills are matched to expenses by Billing ID.'
              )}
            />
          )}

          {state === 'preview' && results.length > 0 && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              <div className="flex gap-2 flex-wrap">
                {confirmableCount > 0 && (
                  <Badge variant="default" className="gap-1">
                    <LuCheckCircle className="size-3" />
                    {confirmableCount} {t('ready')}
                  </Badge>
                )}
                {unmatchedCount > 0 && (
                  <Badge variant="secondary" className="gap-1">
                    <LuAlertTriangle className="size-3" />
                    {unmatchedCount} {t('unmatched')}
                  </Badge>
                )}
                {failedCount > 0 && (
                  <Badge variant="destructive" className="gap-1">
                    <LuFileWarning className="size-3" />
                    {failedCount} {t('failed')}
                  </Badge>
                )}
              </div>

              {results.map((result, idx) => (
                <ResultCard
                  key={idx}
                  result={result}
                  onToggleReplace={handleToggleReplace}
                  replaceFlags={replaceFlags}
                />
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
            <Button onClick={handleParse} data-cy="parseBills">
              {t('Continue')}
            </Button>
          )}
          {state === 'preview' && confirmableCount > 0 && (
            <Button onClick={handleConfirm} data-cy="confirmBills">
              {t('Confirm Import')} ({confirmableCount})
            </Button>
          )}
        </>
      )}
    />
  );
}
