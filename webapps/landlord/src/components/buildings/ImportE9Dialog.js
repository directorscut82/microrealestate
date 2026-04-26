import { importBuildingPdf, QueryKeys } from '../../utils/restcalls';
import { LuAlertTriangle, LuBuilding2, LuCheckCircle } from 'react-icons/lu';
import React, { useCallback, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import ResponsiveDialog from '../ResponsiveDialog';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

export default function ImportE9Dialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const [preview, setPreview] = useState(null);
  const fileInputRef = useRef();
  const selectedFileRef = useRef(null);

  const handleClose = useCallback(() => {
    setOpen(false);
    setState('idle');
    setPreview(null);
    selectedFileRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [setOpen]);

  const handleFileSelect = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      selectedFileRef.current = file;
      setState('loading');

      try {
        const result = await importBuildingPdf(file, false);
        setPreview(result);
        setState('preview');
      } catch (error) {
        console.error(error);
        toast.error(t('Failed to parse E9 PDF'));
        setState('idle');
        selectedFileRef.current = null;
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [t]
  );

  const handleConfirm = useCallback(async () => {
    if (!selectedFileRef.current) return;

    setState('confirming');

    try {
      await importBuildingPdf(selectedFileRef.current, true);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      toast.success(t('Buildings imported successfully'));
      handleClose();
    } catch (error) {
      console.error(error);
      toast.error(t('Failed to import buildings'));
      setState('preview');
    }
  }, [handleClose, queryClient, t]);

  const isLoading = state === 'loading' || state === 'confirming';

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Import from E9 PDF')}
      renderContent={() => (
        <div className="pt-6 space-y-4">
          {state === 'idle' && (
            <div className="space-y-2">
              <Label htmlFor="e9file">{t('E9 PDF File')}</Label>
              <Input
                id="e9file"
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                onChange={handleFileSelect}
              />
            </div>
          )}

          {state === 'preview' && preview && (
            <div className="space-y-4">
              <div className="border rounded-md p-4 space-y-2">
                <div className="font-medium">{t('Owner')}</div>
                <div className="text-sm">
                  {preview.owner?.name}{' '}
                  {preview.owner?.taxId && `(ΑΦΜ: ${preview.owner.taxId})`}
                </div>
              </div>

              <div className="space-y-2">
                <div className="font-medium">{t('Buildings')}</div>
                {preview.buildings?.map((building, idx) => (
                  <div key={idx} className="border rounded-md p-4 space-y-2">
                    <div className="flex items-start gap-2">
                      <LuBuilding2 className="size-5 mt-0.5" />
                      <div className="flex-1">
                        <div className="font-medium">
                          {building.address?.street1}, {building.address?.city}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {t('ATAK Prefix')}: {building.atakPrefix}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {t('{{count}} units', {
                            count: building.units?.length || 0
                          })}
                        </div>
                        {building.existingBuildingId && (
                          <div className="flex items-center gap-1 text-sm text-warning mt-2">
                            <LuAlertTriangle className="size-4" />
                            {t('Will merge into existing building: {{name}}', {
                              name: building.existingBuildingName
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {preview.skippedLandPlots > 0 && (
                <div className="border rounded-md p-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <LuCheckCircle className="size-4" />
                  {t('{{count}} land plots skipped', {
                    count: preview.skippedLandPlots
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          {state === 'preview' && (
            <Button onClick={handleConfirm} data-cy="confirmImport">
              {t('Confirm Import')}
            </Button>
          )}
        </>
      )}
    />
  );
}
