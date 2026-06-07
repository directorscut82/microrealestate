import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  createLease,
  createProperty,
  createTenant,
  fetchBuildings,
  fetchLeases,
  fetchProperties,
  fetchTenantRents,
  fetchTenants,
  importTenantPdf,
  QueryKeys,
  updateProperty,
  updateTenant
} from '../../utils/restcalls';
import {
  apiFetcher
} from '../../utils/fetch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import FileDropZone from '../ui/file-drop-zone';
import { Label } from '../ui/label';
import { LuCalendarClock } from 'react-icons/lu';
import { LuAlertTriangle, LuBan, LuCheck, LuUser } from 'react-icons/lu';
import moment from 'moment';
import ResponsiveDialog from '../ResponsiveDialog';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

function computeMonths(startStr, endStr) {
  const start = moment(startStr, 'DD/MM/YYYY');
  const end = moment(endStr, 'DD/MM/YYYY');
  if (!start.isValid() || !end.isValid()) return 0;
  return Math.round(end.diff(start, 'months', true));
}

export default function ImportTenantDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const [files, setFiles] = useState([]);
  const [parsedResults, setParsedResults] = useState([]);
  const [selectedLeaseIds, setSelectedLeaseIds] = useState({});
  const [markPaidFlags, setMarkPaidFlags] = useState({});
  // P1.7 / M3: opt-in flag per row to update an existing matched property
  // from the parsed PDF. Default OFF so re-importing the same PDF (or
  // an amendment) doesn't silently overwrite manually edited fields like
  // surface corrections, custom name, expense categories, etc. 4 duplicate
  // pairs in the user's PDF corpus would otherwise clobber edits.
  const [updatePropertyFlags, setUpdatePropertyFlags] = useState({});

  const { data: leases = [] } = useQuery({
    queryKey: [QueryKeys.LEASES],
    queryFn: fetchLeases
  });

  const { data: existingProperties = [] } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties,
    enabled: parsedResults.length > 0
  });

  const { data: existingTenants = [] } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: fetchTenants,
    enabled: parsedResults.length > 0
  });

  const activeLeases = useMemo(() => leases.filter((l) => l.active), [leases]);

  // Auto-match leases for each parsed result
  useEffect(() => {
    if (parsedResults.length === 0) return;

    const leaseMap = {};
    parsedResults.forEach((parsed, idx) => {
      const months = computeMonths(parsed.validityStart, parsed.validityEnd);
      const matched = activeLeases.find(
        (l) => l.numberOfTerms === months && l.timeRange === 'months'
      );
      if (matched) {
        leaseMap[idx] = matched._id;
      }
    });
    setSelectedLeaseIds((prev) => ({ ...prev, ...leaseMap }));
  }, [parsedResults, activeLeases]);

  const matchInfos = useMemo(() => {
    return parsedResults.map((parsed) => {
      const months = computeMonths(parsed.validityStart, parsed.validityEnd);
      // Compute past months (ongoing lease)
      const startDate = moment(parsed.validityStart, 'DD/MM/YYYY');
      const now = moment();
      let pastMonths = 0;
      if (startDate.isValid() && startDate.isBefore(now)) {
        pastMonths = Math.floor(now.diff(startDate, 'months', true));
      }
      const prop = parsed.properties?.[0];
      let matchedProperty = null;
      if (prop?.atakNumber) {
        // Primary: exact ATAK match (check both atakNumber and altAtakNumbers)
        matchedProperty = existingProperties.find(
          (p) => p.atakNumber === prop.atakNumber ||
            p.altAtakNumbers?.includes(prop.atakNumber)
        );
        // Fallback: match by street + floor (co-owned properties have different ATAKs)
        if (!matchedProperty && prop?.address?.street1) {
          const floorMatch = prop.rawAddress?.match(/Όροφος\s+(\d+)/);
          const isIsogeio = !floorMatch && /Ισόγειο/i.test(prop.rawAddress || '');
          const floor = floorMatch ? parseInt(floorMatch[1], 10) : (isIsogeio ? 0 : null);
          const floorLabel = floor === 0 ? 'Ισόγειο'
            : floor != null ? `Όροφος ${floor}`
            : null;
          // street1 may include appended floor (e.g. "ΚΑΛΑΜΩΝ 24, Όροφος 1")
          // Extract just the street+number part before the comma
          const streetOnly = (prop.address?.street1 || '').split(',')[0].trim();
          if (floor !== null && floorLabel) {
            matchedProperty = existingProperties.find(
              (p) => {
                if (!p.name?.includes(streetOnly)) return false;
                if (!p.name?.includes(floorLabel)) return false;
                // If surface available, prefer exact surface match
                if (prop.surface && p.surface && Math.abs(p.surface - prop.surface) > 1) return false;
                return true;
              }
            );
          }
        }
      }
      const firstTaxId = parsed.tenants[0]?.taxId;
      const matchedTenant = firstTaxId
        ? existingTenants.find(
            (t) =>
              t.taxId === firstTaxId ||
              t.coTenants?.some((ct) => ct.taxId === firstTaxId)
          )
        : null;

      // Check if property is occupied by a different tenant
      let occupiedBy = null;
      if (matchedProperty && !matchedTenant) {
        occupiedBy = existingTenants.find(
          (t) =>
            t.properties?.some(
              (tp) => tp.propertyId === matchedProperty._id
            )
        );
      }

      return { months, pastMonths, matchedProperty, matchedTenant, occupiedBy };
    });
  }, [parsedResults, existingProperties, existingTenants]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setState('idle');
    setFiles([]);
    setParsedResults([]);
    setSelectedLeaseIds({});
    // P1.5 / N3: clear per-row opt-in flags. Persistent dialog mount means
    // these maps survive close/reopen — without the reset, prior session's
    // flags re-apply to a different tenant/property.
    setMarkPaidFlags({});
    setUpdatePropertyFlags({});
  }, [setOpen]);

  const handleParse = useCallback(async () => {
    if (files.length === 0) return;

    setState('loading');
    // P1.6 / N2: per-file try/catch so a single bad PDF (parse error, or
    // a 429 from the server-side 10/min rate limit) doesn't wipe the whole
    // batch. We collect partial results and only blow up the whole flow on
    // the very first file failing — at that point there's nothing to keep.
    const results = [];
    let rateLimited = false;
    let hadParseError = false;
    for (const file of files) {
      try {
        const result = await importTenantPdf(file);
        results.push({ ...result, _fileName: file.name });
      } catch (err) {
        if (err?.response?.status === 429) {
          rateLimited = true;
          break;
        }
        hadParseError = true;
        // continue — surface a generic error after the loop, but keep
        // any successfully parsed files so the user doesn't retype.
      }
    }

    if (rateLimited) {
      toast.error(
        t(
          'Too many files; uploaded {{count}} of {{total}} — try again in 1 minute',
          { count: results.length, total: files.length }
        )
      );
    } else if (hadParseError && results.length === 0) {
      toast.error(t('Error parsing PDF'));
      setFiles([]);
      setState('idle');
      return;
    } else if (hadParseError) {
      toast.warning(
        t('{{count}} of {{total}} files failed to parse', {
          count: files.length - results.length,
          total: files.length
        })
      );
    }

    if (results.length === 0) {
      // Nothing parsed (rate limited on file 0, or all files failed).
      setFiles([]);
      setState('idle');
      return;
    }

    // Deduplicate: skip files with same declaration number or same tenant+property
    const seen = new Set();
    const unique = results.filter((r) => {
      const key =
        r.declarationNumber ||
        `${r.tenants?.[0]?.taxId}_${r.properties?.[0]?.atakNumber}`;
      if (!key || key === 'undefined_undefined') return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length < results.length) {
      toast.info(
        t('{{count}} duplicate files skipped', {
          count: results.length - unique.length
        })
      );
    }
    setParsedResults(unique);
    setState('preview');
  }, [files, t]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const created = [];

      for (let idx = 0; idx < parsedResults.length; idx++) {
        const parsed = parsedResults[idx];
        const matchInfo = matchInfos[idx];

        // Skip entries where property is occupied by another tenant
        if (matchInfo?.occupiedBy) continue;

        const months =
          matchInfo?.months ||
          computeMonths(parsed.validityStart, parsed.validityEnd);

        // 1. Resolve lease
        let leaseId = selectedLeaseIds[idx] || '';
        if (!leaseId) {
          const newLease = await createLease({
            name: t('Lease {{count}} months', { count: months }),
            numberOfTerms: months,
            timeRange: 'months',
            active: true
          });
          leaseId = newLease._id;
        }

        // 2. Resolve property
        const prop = parsed.properties[0];
        // Compute a proper name from address (e.g. "ΚΑΛΑΜΩΝ 24 - Ισόγειο")
        const streetPart = (prop.address?.street1 || '').split(',')[0].trim();
        const floorRaw = (prop.address?.street1 || '').match(/Όροφος\s*(\d+)/);
        const floorNum = floorRaw ? parseInt(floorRaw[1], 10) : null;
        const floorLabel = floorNum === 0 ? 'Ισόγειο'
          : floorNum != null ? `Όροφος ${floorNum}`
          : (prop.address?.street1 || '').match(/Ισόγειο/i) ? 'Ισόγειο' : null;
        const propertyName = streetPart && floorLabel
          ? `${streetPart} - ${floorLabel}`
          : streetPart || prop.rawAddress || prop.atakNumber || 'Imported property';
        const propertyData = {
          name: propertyName,
          type: prop.type || 'apartment',
          surface: prop.surface || 0,
          price: prop.monthlyRent || 0,
          address: {
            street1: prop.address?.street1 || '',
            street2: '',
            zipCode: prop.address?.zipCode || '',
            city: prop.address?.city || '',
            state: prop.address?.state || '',
            country: 'Ελλάδα'
          },
          atakNumber: prop.atakNumber || '',
          dehNumber: prop.dehNumber || '',
          landSurface: prop.landSurface || undefined,
          energyCertificate: prop.energyCertificate
            ? {
                number: prop.energyCertificate.number,
                issueDate: prop.energyCertificate.issueDate
                  ? moment(
                      prop.energyCertificate.issueDate,
                      'DD/MM/YYYY'
                    ).toISOString()
                  : undefined,
                energyClass: prop.energyCertificate.energyClass,
                inspectorNumber: prop.energyCertificate.inspectorNumber
              }
            : undefined
        };

        let property;
        if (matchInfo?.matchedProperty) {
          // P1.7 / M3: only overwrite the existing property when the user
          // explicitly opted in via the per-row checkbox. Default OFF so
          // re-importing the same lease (or an amendment) doesn't silently
          // clobber manual edits like surface corrections, custom name,
          // expense categories, etc.
          if (updatePropertyFlags[idx]) {
            property = await updateProperty({
              _id: matchInfo.matchedProperty._id,
              ...propertyData
            });
          } else {
            property = matchInfo.matchedProperty;
          }
        } else {
          property = await createProperty(propertyData);
        }

        // Ensure a building exists for this property
        if (!property.buildingId && streetPart) {
          // P1.8 / N4: greekleaseparser surfaces the landlord names + AFMs
          // + ownership percentages but the import previously sent owners:
          // []. For any co-owned property (6/11 user PDFs) this dropped 50%+
          // of the ownership data. The Building schema's UnitOwnerSchema
          // accepts type ∈ {'member','external'} — parsed lease landlords
          // are external co-owners by definition (they're in the lease, not
          // necessarily in the realm members list).
          const ownersFromPdf = (parsed.landlords || []).map((L) => ({
            type: 'external',
            name: L.name,
            taxId: L.taxId,
            percentage: L.ownershipPercent
          }));
          const buildings = await fetchBuildings();
          const existingBuilding = buildings.find(
            (b) => b.name === streetPart || b.address?.street1 === streetPart
          );
          if (existingBuilding) {
            // Add unit to existing building if not already there
            const hasUnit = existingBuilding.units?.some(
              (u) => u.propertyId === property._id
            );
            if (!hasUnit) {
              await apiFetcher().post(
                `/buildings/${existingBuilding._id}/units`,
                {
                  atakNumber: prop.atakNumber || '',
                  floor: floorNum ?? 0,
                  surface: prop.surface || 0,
                  electricitySupplyNumber: prop.dehNumber || '',
                  propertyId: property._id,
                  isManaged: true,
                  owners: ownersFromPdf
                }
              );
            }
          } else {
            // P1.3 / M2: 8/11 PDFs in the user's corpus share atakPrefix
            // '00557' (same building, different units). buildingmanager
            // refuses a second building with the same prefix (422). Catch
            // that, look up the actual building by prefix, and fall back
            // to adding the unit there. Any other 422 surfaces the server
            // message in the toast for diagnosability.
            const atakPrefix = (prop.atakNumber || '').slice(0, 5);
            try {
              await apiFetcher().post('/buildings', {
                name: streetPart,
                atakPrefix,
                address: propertyData.address,
                units: [
                  {
                    atakNumber: prop.atakNumber || '',
                    floor: floorNum ?? 0,
                    surface: prop.surface || 0,
                    electricitySupplyNumber: prop.dehNumber || '',
                    propertyId: property._id,
                    isManaged: true,
                    owners: ownersFromPdf
                  }
                ]
              });
            } catch (err) {
              const msg = err?.response?.data?.message || '';
              const isPrefixCollision =
                err?.response?.status === 422 &&
                /atak prefix/i.test(msg) &&
                /already exists/i.test(msg);
              if (isPrefixCollision && atakPrefix) {
                const refreshed = await fetchBuildings();
                const sharedBuilding = refreshed.find(
                  (b) => b.atakPrefix === atakPrefix
                );
                if (sharedBuilding) {
                  const hasUnitAlready = sharedBuilding.units?.some(
                    (u) => u.propertyId === property._id
                  );
                  if (!hasUnitAlready) {
                    await apiFetcher().post(
                      `/buildings/${sharedBuilding._id}/units`,
                      {
                        atakNumber: prop.atakNumber || '',
                        floor: floorNum ?? 0,
                        surface: prop.surface || 0,
                        electricitySupplyNumber: prop.dehNumber || '',
                        propertyId: property._id,
                        isManaged: true,
                        owners: ownersFromPdf
                      }
                    );
                  }
                } else {
                  throw err;
                }
              } else {
                throw err;
              }
            }
          }
        }

        // 3. Resolve tenant
        // P1.1 / M6: client-side defense — even though the server now
        // 422s non-lease PDFs in pdfimportmanager, malformed legitimate
        // PDFs may produce a tenants[0] without a name. Don't crash the
        // whole batch on a single weird row.
        const primaryTenant = parsed.tenants?.[0];
        if (!primaryTenant?.name) {
          continue;
        }
        const nameParts = primaryTenant.name.split(/\s+/);
        const lastName = nameParts[0] || '';
        const firstName = nameParts.slice(1).join(' ') || '';
        const beginDate = parsed.validityStart || parsed.originalStartDate;
        const tenantData = {
          name: primaryTenant.name,
          firstName,
          lastName,
          leaseId,
          beginDate,
          endDate: parsed.validityEnd || '',
          properties: [
            {
              propertyId: property._id,
              rent: prop.monthlyRent || 0,
              expenses: [],
              entryDate: beginDate,
              exitDate: parsed.validityEnd || ''
            }
          ],
          taxId: primaryTenant.taxId || '',
          declarationNumber: parsed.declarationNumber || '',
          amendsDeclaration: parsed.amendsDeclaration || '',
          originalLeaseStartDate: parsed.originalStartDate
            ? moment(parsed.originalStartDate, 'DD/MM/YYYY').toISOString()
            : undefined,
          leaseNotes: parsed.notes || '',
          coTenants: parsed.tenants.map((t) => ({
            name: t.name,
            taxId: t.taxId,
            acceptanceDate: t.acceptanceDate
              ? moment(t.acceptanceDate, 'DD/MM/YYYY').toISOString()
              : undefined
          })),
          contacts: [
            {
              contact: `${firstName} ${lastName}`.trim(),
              email: '',
              phone1: '',
              phone2: ''
            }
          ],
          stepperMode: false
        };

        let tenant;
        if (matchInfo?.matchedTenant) {
          tenant = await updateTenant({
            _id: matchInfo.matchedTenant._id,
            ...tenantData
          });
        } else {
          tenant = await createTenant(tenantData);
        }

        // Settle past months if flag is set (pays full grandTotal including charges)
        if (markPaidFlags[idx] !== false && matchInfo?.pastMonths > 0) {
          // P1.2 / M4: previously hit `/rents/:year` which is not a
          // registered route — the silent catch fell back to base
          // monthlyRent only, dropping charges/VAT/discount. Use the
          // actual endpoint (services/api/src/routes.ts:200) which
          // returns the full per-term rent ledger for this tenant in a
          // single round-trip and is correct across multi-year leases.
          let tenantRents = [];
          try {
            const rentsData = await fetchTenantRents(tenant._id);
            tenantRents = rentsData?.rents || [];
          } catch {
            tenantRents = [];
          }

          const startDate = moment(parsed.validityStart || parsed.originalStartDate, 'DD/MM/YYYY');
          const now = moment();
          let termDate = startDate.clone();
          while (termDate.isBefore(now, 'month')) {
            const term = termDate.format('YYYYMM') + '0100';
            const rentForTerm = tenantRents.find((r) => String(r.term) === term);
            const amount = rentForTerm?.total?.grandTotal || prop.monthlyRent || parsed.totalMonthlyRent || 0;
            try {
              await apiFetcher().patch(
                `/rents/payment/${tenant._id}/${term}`,
                {
                  _id: tenant._id,
                  payments: [{ amount, type: 'transfer', date: termDate.format('DD/MM/YYYY') }]
                }
              );
            } catch { /* skip if term doesn't exist */ }
            termDate.add(1, 'month');
          }
        }

        created.push(tenant);
      }

      return created;
    },
    onSuccess: (tenants) => {
      // Bulk-import touches tenants, properties, leases, and (when past
      // months are settled) the rent + accounting ledgers. Buildings can
      // be created mid-import as well. Invalidate the entire stack so no
      // downstream screen carries stale data after the dialog closes.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LEASES] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
      handleClose();
      if (tenants.length === 1 && tenants[0]?._id) {
        router.push(
          `/${store.organization.selected?.name}/tenants/${tenants[0]._id}`,
          undefined,
          { locale: store.organization.selected?.locale }
        );
      } else {
        toast.success(
          t('{{count}} tenants imported', { count: tenants.length })
        );
      }
    },
    onError: () => {
      toast.error(t('Error creating tenant'));
    }
  });

  const handleConfirm = useCallback(() => {
    createMutation.mutate();
  }, [createMutation]);

  const isLoading = state === 'loading' || createMutation.isPending;

  return (
    <ResponsiveDialog
      open={open}
      setOpen={(v) => {
        if (!v) handleClose();
        else setOpen(v);
      }}
      isLoading={isLoading}
      renderHeader={() => t('Import from PDF')}
      renderContent={() => (
        <div className="pt-4 space-y-4">
          {(state === 'idle' || state === 'loading') && (
            <FileDropZone
              multiple
              files={files}
              onFilesChange={(newFiles) => {
                // P1.6 / N2: cap to 10 files — the server-side
                // uploadRateLimit middleware (services/api/src/routes.ts)
                // is hard-set to 10/min/user, so anything beyond 10 is
                // guaranteed to 429 and force a 1-minute backoff. Better
                // to surface the limit in-band before parse than to let
                // the user queue 30 files and hit a wall halfway through.
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
              }}
              disabled={isLoading}
              description={t(
                'Upload one or more Greek lease PDF files to import tenants'
              )}
            />
          )}

          {state === 'preview' && parsedResults.length > 0 && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              {parsedResults.map((parsed, idx) => {
                const info = matchInfos[idx];
                return (
                  <div
                    key={idx}
                    className={`border rounded-md p-4 space-y-3${
                      info?.occupiedBy ? ' opacity-50' : ''
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <LuUser className="size-5 mt-0.5" />
                      <div className="flex-1">
                        <div className="font-medium">
                          {parsed.tenants[0]?.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {parsed._fileName}
                        </div>
                      </div>
                      {info?.matchedTenant && (
                        <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">
                          {t('Update')}
                        </span>
                      )}
                      {info?.occupiedBy && (
                        <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">
                          {t('Skipped')}
                        </span>
                      )}
                    </div>

                    {info?.matchedTenant && (
                      <div className="flex items-center gap-1 text-xs text-yellow-700">
                        <LuAlertTriangle className="size-3" />
                        {t('Existing tenant found')}:{' '}
                        {info.matchedTenant.name}
                      </div>
                    )}
                    {info?.matchedProperty && (
                      <div className="flex items-center gap-1 text-xs text-yellow-700">
                        <LuAlertTriangle className="size-3" />
                        {t('Existing property found')}:{' '}
                        {info.matchedProperty.name}
                      </div>
                    )}

                    {info?.occupiedBy && (
                      <div className="flex items-center gap-1 text-xs text-red-700">
                        <LuBan className="size-3" />
                        {t('Property occupied by {{name}} — remove them first', {
                          name: info.occupiedBy.name
                        })}
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">
                          {t('Start date')}:
                        </span>{' '}
                        {parsed.validityStart}
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          {t('End date')}:
                        </span>{' '}
                        {parsed.validityEnd}
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          {t('Rent')}:
                        </span>{' '}
                        {parsed.totalMonthlyRent} €
                      </div>
                    </div>

                    {parsed.properties[0] && (
                      <div className="text-sm text-muted-foreground">
                        <LuCheck className="inline size-3 mr-1" />
                        {parsed.properties[0].address?.street1}
                        {parsed.properties[0].surface &&
                          ` · ${parsed.properties[0].surface} τμ`}
                        {parsed.properties[0].atakNumber &&
                          ` · ΑΤΑΚ: ${parsed.properties[0].atakNumber}`}
                      </div>
                    )}

                    <div className="space-y-1">
                      <Label className="text-xs">{t('Contract')}</Label>
                      <Select
                        value={selectedLeaseIds[idx] || ''}
                        onValueChange={(v) =>
                          setSelectedLeaseIds((prev) => ({
                            ...prev,
                            [idx]: v
                          }))
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue
                            placeholder={t('Auto-create from PDF dates')}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {activeLeases.map((lease) => (
                            <SelectItem key={lease._id} value={lease._id}>
                              {lease.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {info?.matchedProperty && !info?.occupiedBy && (
                      <div className="flex items-center gap-2 pt-2 p-2 bg-muted/50 rounded-md">
                        <Checkbox
                          id={`updateProp-${idx}`}
                          checked={!!updatePropertyFlags[idx]}
                          onCheckedChange={(checked) =>
                            setUpdatePropertyFlags((prev) => ({
                              ...prev,
                              [idx]: checked
                            }))
                          }
                        />
                        <label
                          htmlFor={`updateProp-${idx}`}
                          className="text-sm flex items-center gap-1.5 cursor-pointer"
                        >
                          {t('Update property fields from PDF')}
                        </label>
                      </div>
                    )}

                    {info?.pastMonths > 0 && (
                      <div className="flex items-center gap-2 pt-2 p-2 bg-muted/50 rounded-md">
                        <Checkbox
                          id={`markPaid-${idx}`}
                          checked={markPaidFlags[idx] !== false}
                          onCheckedChange={(checked) =>
                            setMarkPaidFlags((prev) => ({
                              ...prev,
                              [idx]: checked
                            }))
                          }
                        />
                        <label htmlFor={`markPaid-${idx}`} className="text-sm flex items-center gap-1.5 cursor-pointer">
                          <LuCalendarClock className="size-4" />
                          {t('Mark {{count}} past months as paid', { count: info.pastMonths })}
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
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
            <Button onClick={handleParse} data-cy="parseLease">
              {t('Continue')}
            </Button>
          )}
          {state === 'preview' && (
            <Button onClick={handleConfirm} disabled={isLoading}>
              {parsedResults.length === 1
                ? matchInfos[0]?.matchedTenant
                  ? t('Update')
                  : t('Import')
                : t('Import {{count}} tenants', {
                    count: parsedResults.length
                  })}
            </Button>
          )}
        </>
      )}
    />
  );
}
