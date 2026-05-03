import { importBuildingPdf, QueryKeys } from '../../utils/restcalls';
import { LuAlertTriangle, LuBuilding2, LuCheckCircle } from 'react-icons/lu';
import React, { useCallback, useState } from 'react';
import { Button } from '../ui/button';
import FileDropZone from '../ui/file-drop-zone';
import ResponsiveDialog from '../ResponsiveDialog';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

export default function ImportE9Dialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const [files, setFiles] = useState([]);
  const [preview, setPreview] = useState(null);

  const handleClose = useCallback(() => {
    setOpen(false);
    setState('idle');
    setFiles([]);
    setPreview(null);
  }, [setOpen]);

  const handleParse = useCallback(async () => {
    if (files.length === 0) return;

    setState('loading');

    try {
      const allBuildings = [];
      let totalSkipped = 0;
      const owners = [];

      for (const file of files) {
        const result = await importBuildingPdf(file, false);
        if (result.owner) {
          const existing = owners.find(
            (o) => o.taxId === result.owner.taxId
          );
          if (!existing) {
            owners.push(result.owner);
          }
        }
        if (result.buildings) {
          allBuildings.push(...result.buildings);
        }
        totalSkipped += result.skippedLandPlots || 0;
      }

      setPreview({
        owners,
        buildings: allBuildings,
        skippedLandPlots: totalSkipped
      });
      setState('preview');
    } catch (error) {
      toast.error(t('Failed to parse E9 PDF'));
      setState('idle');
    }
  }, [files, t]);

  const handleConfirm = useCallback(async () => {
    if (files.length === 0) return;

    setState('confirming');

    try {
      for (const file of files) {
        await importBuildingPdf(file, true);
      }
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      toast.success(t('Buildings imported successfully'));
      handleClose();
    } catch (error) {
      toast.error(t('Failed to import buildings'));
      setState('preview');
    }
  }, [files, handleClose, queryClient, t]);

  const isLoading = state === 'loading' || state === 'confirming';

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Import from E9 PDF')}
      renderContent={() => (
        <div className="pt-4 space-y-4">
          {(state === 'idle' || state === 'loading') && (
            <FileDropZone
              multiple
              files={files}
              onFilesChange={setFiles}
              disabled={isLoading}
              description={t(
                'Upload one or more E9 PDF files to import buildings and units'
              )}
            />
          )}

          {state === 'preview' && preview && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              {preview.owners.length > 0 && (
                <div className="border rounded-md p-4 space-y-2">
                  <div className="font-medium">
                    {preview.owners.length === 1
                      ? t('Owner')
                      : t('Owners')}
                  </div>
                  {preview.owners.map((owner, idx) => (
                    <div key={idx} className="text-sm">
                      {owner.name}{' '}
                      {owner.taxId && `(ΑΦΜ: ${owner.taxId})`}
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <div className="font-medium">
                  {t('Buildings')} ({preview.buildings.length})
                </div>
                {preview.buildings.map((building, idx) => (
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
          {state === 'idle' && files.length > 0 && (
            <Button onClick={handleParse} data-cy="parseE9">
              {t('Continue')}
            </Button>
          )}
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
