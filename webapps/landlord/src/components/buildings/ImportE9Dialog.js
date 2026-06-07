import { importBuildingPdf, QueryKeys } from '../../utils/restcalls';
import {
  LuAlertTriangle,
  LuBuilding2,
  LuCheckCircle,
  LuXCircle
} from 'react-icons/lu';
import React, { useCallback, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import FileDropZone from '../ui/file-drop-zone';
import { Label } from '../ui/label';
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
  // T2.P1.16: per-file parse outcome so a single broken PDF does not
  // crash the whole batch. Shape: [{file, status:'parsed'|'error', message?}]
  const [fileResults, setFileResults] = useState([]);
  // T2.P1.20: opt-in destructive overwrite of existing Property fields
  // (electricitySupplyNumber, name, surface). Default OFF so re-imports
  // don't silently clobber edits the user made in Property forms.
  const [forceOverwrite, setForceOverwrite] = useState(false);
  // T2.P1.21: AbortController so the user can cancel an in-flight
  // upload instead of being held hostage by ResponsiveDialog's
  // isLoading lock. Stored in a ref because the controller must
  // survive re-renders without being recreated by useState set calls.
  const abortRef = useRef(null);

  const handleClose = useCallback(() => {
    // T2.P1.21: tear down any in-flight axios request before closing so
    // the server-side parse doesn't keep running and rate-limit the
    // user's next attempt.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setOpen(false);
    setState('idle');
    setFiles([]);
    setPreview(null);
    setFileResults([]);
    setForceOverwrite(false);
  }, [setOpen]);

  // T2.P1.16: parse a specific subset of files (defaults to all current
  // files). On retry-failed-only the caller passes the subset that errored.
  const handleParse = useCallback(async (filesToParse) => {
    const targets = filesToParse || files;
    if (targets.length === 0) return;

    setState('loading');
    const controller = new AbortController();
    abortRef.current = controller;

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

      // T2.P1.16: track per-file results so one failed PDF doesn't crash
      // the rest of the batch. We also start from any prior fileResults
      // so a "retry failed" pass merges new outcomes over the failed
      // entries while preserving previously-parsed successes.
      const nextResults = (() => {
        if (filesToParse) {
          // Retry path: clone existing fileResults so we can flip the
          // status of the retried files in place.
          return [...fileResults];
        }
        return targets.map((file) => ({ file, status: 'pending' }));
      })();
      const findResultIndex = (file) =>
        nextResults.findIndex((r) => r.file === file);

      for (const file of targets) {
        // T2.P1.21: bail out early if the user clicked Cancel mid-batch.
        if (controller.signal.aborted) break;
        try {
          const result = await importBuildingPdf(file, false, {
            signal: controller.signal
          });
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
          const idx = findResultIndex(file);
          const entry = { file, status: 'parsed' };
          if (idx >= 0) nextResults[idx] = entry;
          else nextResults.push(entry);
        } catch (error) {
          // Cancellation: surface as cancelled and stop iterating — no
          // sense parsing further files when the user has dismissed.
          if (
            controller.signal.aborted ||
            error?.name === 'CanceledError' ||
            error?.code === 'ERR_CANCELED'
          ) {
            break;
          }
          const serverMessage = error.response?.data?.message;
          const idx = findResultIndex(file);
          const entry = {
            file,
            status: 'error',
            message: serverMessage || error.message || 'Parse failed'
          };
          if (idx >= 0) nextResults[idx] = entry;
          else nextResults.push(entry);
        }
      }

      // T2.P1.21: if the user cancelled, don't transition to preview —
      // just reset to idle so they can re-pick files.
      if (controller.signal.aborted) {
        abortRef.current = null;
        setState('idle');
        return;
      }

      setFileResults(nextResults);
      const errored = nextResults.filter((r) => r.status === 'error');
      if (errored.length === nextResults.length) {
        // Every file failed — stay on the picker so the user sees the
        // per-file error list and can retry.
        toast.error(
          t('All files failed to parse ({{count}})', {
            count: errored.length
          })
        );
        setState('idle');
      } else {
        if (errored.length > 0) {
          toast.warning(
            t('{{count}} of {{total}} files failed; review errors below', {
              count: errored.length,
              total: nextResults.length
            })
          );
        }
        setPreview({
          owners,
          buildings: Array.from(buildingsByKey.values()),
          skippedLandPlots: totalSkipped
        });
        setState('preview');
      }
    } catch (error) {
      // Outer catch is now reserved for non-axios programming errors
      // (e.g. a thrown TypeError in the merge path). Per-file axios
      // failures are caught above.
      const serverMessage = error.response?.data?.message;
      toast.error(serverMessage || t('Failed to parse E9 PDF'));
      setState('idle');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [files, fileResults, t]);

  const handleConfirm = useCallback(async () => {
    // T2.P1.16: only confirm files that successfully parsed. A failed
    // PDF in the batch should not be re-uploaded just because the user
    // moved on to the preview step.
    const parsedFiles =
      fileResults.length > 0
        ? fileResults.filter((r) => r.status === 'parsed').map((r) => r.file)
        : files;
    if (parsedFiles.length === 0) return;

    setState('confirming');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // T1.P1.19: aggregate per-PDF outcomes so the success toast
      // surfaces accurate counts ("X created, Y updated, Z units added")
      // rather than the previous blanket "Buildings imported
      // successfully" which lied on re-imports that only attached units
      // to existing buildings.
      let createdCount = 0;
      let updatedCount = 0;
      let unitsAddedTotal = 0;
      let cancelled = false;
      for (const file of parsedFiles) {
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }
        try {
          const result = await importBuildingPdf(file, true, {
            force: forceOverwrite,
            signal: controller.signal
          });
          createdCount += Number(result?.createdCount) || 0;
          updatedCount += Number(result?.updatedCount) || 0;
          unitsAddedTotal += Number(result?.unitsAddedTotal) || 0;
        } catch (err) {
          if (
            controller.signal.aborted ||
            err?.name === 'CanceledError' ||
            err?.code === 'ERR_CANCELED'
          ) {
            cancelled = true;
            break;
          }
          throw err;
        }
      }
      if (cancelled) {
        abortRef.current = null;
        setState('preview');
        return;
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
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [fileResults, files, forceOverwrite, handleClose, queryClient, t]);

  const isLoading = state === 'loading' || state === 'confirming';
  // T2.P1.16: retry only the files that errored in the previous parse.
  const failedFiles = fileResults
    .filter((r) => r.status === 'error')
    .map((r) => r.file);
  const handleRetryFailed = useCallback(() => {
    if (failedFiles.length === 0) return;
    handleParse(failedFiles);
  }, [failedFiles, handleParse]);

  return (
    <ResponsiveDialog
      open={!!open}
      // T2.P1.21: pass isLoading={false} so ResponsiveDialog keeps our
      // custom footer rendered (with a Cancel button) instead of swapping
      // it for an in-progress spinner that locks the user out of cancel.
      // The actual "loading" disable state is applied per-control below.
      setOpen={(v) => {
        // ResponsiveDialog uses Radix onOpenChange which fires on Esc and
        // outside-click — funnel both through handleClose so any in-flight
        // request is aborted.
        if (!v) handleClose();
        else setOpen(v);
      }}
      isLoading={false}
      renderHeader={() => t('Import from E9 PDF')}
      renderContent={() => (
        <div className="pt-4 space-y-4">
          {(state === 'idle' || state === 'loading') && (
            <FileDropZone
              multiple
              files={files}
              onFilesChange={(newFiles) => {
                // T2.P1.5: cap at 10 to mirror ImportTenantDialog. The
                // server-side uploadRateLimit middleware
                // (services/api/src/routes.ts:21) is hard-set to 10/min/user
                // and parse+confirm both upload, so anything beyond 10 is
                // guaranteed to 429 mid-batch. Surface the cap before parse
                // rather than letting the user queue 30 files and hit a wall.
                if (newFiles.length > 10) {
                  toast.warning(
                    t(
                      'Maximum 10 files per import; only the first 10 will be kept'
                    )
                  );
                  setFiles(newFiles.slice(0, 10));
                } else {
                  setFiles(newFiles);
                }
                // Reset any prior per-file outcomes when the file list
                // changes so the retry-failed button doesn't reference
                // stale entries the user already removed.
                setFileResults([]);
              }}
              disabled={isLoading}
              description={t(
                'Upload one or more E9 PDF files to import buildings and units'
              )}
            />
          )}

          {/* T2.P1.16: per-file outcome list. Visible during loading so
              the user sees progress as files complete, and on idle after
              a partial-failure pass so the user can retry the failed
              ones without re-picking the whole batch. */}
          {fileResults.length > 0 && state !== 'preview' && (
            <div className="border rounded-md p-3 space-y-1 text-sm">
              <div className="font-medium mb-1">
                {t('Per-file status')}
              </div>
              {fileResults.map((r, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  {r.status === 'parsed' && (
                    <LuCheckCircle className="size-4 text-success" />
                  )}
                  {r.status === 'error' && (
                    <LuXCircle className="size-4 text-destructive" />
                  )}
                  {r.status === 'pending' && (
                    <span className="size-4 rounded-full border border-muted-foreground/30 animate-pulse" />
                  )}
                  <span className="truncate flex-1">{r.file?.name}</span>
                  {r.status === 'error' && r.message && (
                    <span className="text-xs text-destructive truncate max-w-[40%]">
                      {r.message}
                    </span>
                  )}
                </div>
              ))}
            </div>
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

              {/* T2.P1.20: opt-in destructive overwrite. Default OFF so
                  re-imports only fill empty fields on existing
                  Properties. With this checked, the server overwrites
                  electricitySupplyNumber, surface, and the auto-named
                  fallback even when the Property already had values. */}
              <div className="border rounded-md p-3 flex items-start gap-2">
                <Checkbox
                  id="e9-force-overwrite"
                  checked={forceOverwrite}
                  onCheckedChange={(v) => setForceOverwrite(!!v)}
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <Label htmlFor="e9-force-overwrite" className="cursor-pointer">
                    {t('Update existing properties')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'Overwrite electricity supply numbers and surface area on properties that already exist. Off by default so re-imports preserve fields you have edited.'
                    )}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      renderFooter={() => (
        <>
          {/* T2.P1.21: Cancel is always visible — even mid-parse — so
              the user can abort an in-flight upload. Clicking Cancel
              calls handleClose which calls abortRef.current.abort() to
              tear down axios mid-flight. */}
          <Button variant="outline" onClick={handleClose}>
            {isLoading ? t('Cancel upload') : t('Cancel')}
          </Button>
          {state === 'idle' && files.length > 0 && (
            <Button onClick={() => handleParse()} data-cy="parseE9">
              {t('Continue')}
            </Button>
          )}
          {state === 'idle' && failedFiles.length > 0 && (
            <Button
              variant="secondary"
              onClick={handleRetryFailed}
              data-cy="retryFailedE9"
            >
              {t('Retry failed ({{count}})', { count: failedFiles.length })}
            </Button>
          )}
          {state === 'loading' && (
            <Button disabled data-cy="parseE9Pending">
              {t('Parsing…')}
            </Button>
          )}
          {state === 'preview' && (
            <Button onClick={handleConfirm} data-cy="confirmImport">
              {t('Confirm Import')}
            </Button>
          )}
          {state === 'confirming' && (
            <Button disabled data-cy="confirmImportPending">
              {t('Importing…')}
            </Button>
          )}
        </>
      )}
    />
  );
}
