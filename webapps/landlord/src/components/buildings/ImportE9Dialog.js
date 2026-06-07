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
      // T1.P1.2: previous code did a flat `allBuildings.push(...)` over
      // every PDF in the batch, producing one preview card per (file,
      // building) pair. When the user uploaded N E9 PDFs that all
      // declared the same physical building (very common for co-owners
      // or year-over-year amendments), the dialog rendered N duplicate
      // cards. Group by `${street1}|${streetNumber}|${zipCode}` (mirror
      // of e9parser.ts:502 baseKey logic — street + number, refined by
      // zip only when both sides agree) and union units[] / owners[]
      // across duplicates so the preview shows one card per real
      // building.
      const buildingsByKey = new Map();
      let totalSkipped = 0;
      const owners = [];

      const buildingKey = (b) => {
        const street1 = (b?.address?.street1 || '').trim().toUpperCase();
        // street1 is "STREET NUMBER" already (set by e9parser.ts:581);
        // include zipCode in the key but treat empty zip as a wildcard
        // so a zip-less row merges into a zipped sibling instead of
        // creating a separate group.
        const zip = (b?.address?.zipCode || '').trim();
        return `${street1}|${zip}`;
      };

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
          for (const b of result.buildings) {
            const key = buildingKey(b);
            // Find an existing group: exact key OR (same street, one
            // side has empty zip). Without the empty-zip fallback two
            // PDFs of the same building where one row was missing a
            // zip would still split into two cards.
            const streetPart = key.split('|')[0];
            let existing = buildingsByKey.get(key);
            if (!existing) {
              for (const [k, v] of buildingsByKey) {
                const [s, z] = k.split('|');
                if (
                  s === streetPart &&
                  (!z || !key.endsWith(`|${z}`))
                ) {
                  // Either existing or incoming has empty zip — merge.
                  if (!z || key.endsWith('|')) {
                    existing = v;
                    break;
                  }
                }
              }
            }
            if (existing) {
              // Union units by atakNumber so the same unit declared
              // by two co-owners doesn't appear twice.
              const seenAtaks = new Set(
                (existing.units || []).map((u) => u.atakNumber)
              );
              for (const u of b.units || []) {
                if (!seenAtaks.has(u.atakNumber)) {
                  existing.units.push(u);
                  seenAtaks.add(u.atakNumber);
                }
              }
              // Promote zip if we now know it.
              if (!existing.address?.zipCode && b.address?.zipCode) {
                existing.address = {
                  ...(existing.address || {}),
                  zipCode: b.address.zipCode
                };
                // Re-key under the new (now-zipped) key so subsequent
                // matches can hit it directly.
                buildingsByKey.delete(key);
                buildingsByKey.set(buildingKey(existing), existing);
              }
            } else {
              // Clone the building so subsequent unions don't mutate
              // the response object the parser handed us.
              buildingsByKey.set(key, {
                ...b,
                address: { ...(b.address || {}) },
                units: [...(b.units || [])]
              });
            }
          }
        }
        totalSkipped += result.skippedLandPlots || 0;
      }

      setPreview({
        owners,
        buildings: Array.from(buildingsByKey.values()),
        skippedLandPlots: totalSkipped
      });
      setState('preview');
    } catch (error) {
      const serverMessage = error.response?.data?.message;
      toast.error(serverMessage || t('Failed to parse E9 PDF'));
      setState('idle');
    }
  }, [files, t]);

  const handleConfirm = useCallback(async () => {
    if (files.length === 0) return;

    setState('confirming');

    try {
      // T1.P1.19: aggregate per-PDF outcomes so the success toast
      // surfaces accurate counts ("X created, Y updated, Z units added")
      // rather than the previous blanket "Buildings imported
      // successfully" which lied on re-imports that only attached units
      // to existing buildings.
      let createdCount = 0;
      let updatedCount = 0;
      let unitsAddedTotal = 0;
      for (const file of files) {
        const result = await importBuildingPdf(file, true);
        createdCount += Number(result?.createdCount) || 0;
        updatedCount += Number(result?.updatedCount) || 0;
        unitsAddedTotal += Number(result?.unitsAddedTotal) || 0;
      }
      // T1.P1.17: an E9 import touches buildings, properties (created +
      // linked via buildingId), and — when the new units land on a
      // tenanted property — rents and the dashboard/accounting roll-ups
      // (via _recomputeTenantsForProperty in buildingmanager). Mirror
      // ImportTenantDialog's multi-key invalidation so no downstream
      // screen carries stale data after the dialog closes.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });

      if (createdCount > 0 || updatedCount > 0) {
        toast.success(
          t(
            '{{created}} created, {{updated}} updated, {{units}} units added',
            {
              created: createdCount,
              updated: updatedCount,
              units: unitsAddedTotal
            }
          )
        );
      } else {
        toast.success(t('Buildings imported successfully'));
      }
      handleClose();
    } catch (error) {
      const serverMessage = error.response?.data?.message;
      toast.error(serverMessage || t('Failed to import buildings'));
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
                {preview.buildings.map((building, idx) => {
                  // T1.P1.18: surface per-unit existing-property
                  // matches that the server emits via
                  // existingPropertyId/Name (buildingmanager.ts:888-902).
                  // Without this the preview only showed unit COUNT,
                  // hiding the fact that some / all units already exist
                  // — leaving the user surprised when the import
                  // attaches rather than creates.
                  const existingUnits = (building.units || []).filter(
                    (u) => u.existingPropertyId
                  );
                  return (
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
                          {existingUnits.length > 0 && (
                            <div className="text-sm text-muted-foreground">
                              {t(
                                '{{existing}} of {{total}} units already exist',
                                {
                                  existing: existingUnits.length,
                                  total: building.units?.length || 0
                                }
                              )}
                            </div>
                          )}
                          {building.existingBuildingId && (
                            <div className="flex items-center gap-1 text-sm text-warning mt-2">
                              <LuAlertTriangle className="size-4" />
                              {t('Will merge into existing building: {{name}}', {
                                name: building.existingBuildingName
                              })}
                            </div>
                          )}
                          {(building.units || []).length > 0 && (
                            <ul className="mt-2 text-xs text-muted-foreground space-y-0.5">
                              {(building.units || []).map((u, uIdx) => (
                                <li key={uIdx} className="flex items-center gap-1">
                                  <span>
                                    {u.atakNumber}
                                    {typeof u.surface === 'number' && u.surface > 0
                                      ? ` · ${u.surface} τμ`
                                      : ''}
                                  </span>
                                  {u.existingPropertyId && (
                                    <span className="ml-1 text-[10px] uppercase tracking-wide bg-muted px-1.5 py-0.5 rounded">
                                      {t('existing')}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
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
