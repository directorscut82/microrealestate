import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  createLease,
  createProperty,
  createTenant,
  fetchLeases,
  fetchProperties,
  fetchTenants,
  importTenantPdf,
  updateProperty,
  updateTenant,
  QueryKeys
} from '../../utils/restcalls';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import FileDropZone from '../ui/file-drop-zone';
import { Label } from '../ui/label';
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
      const prop = parsed.properties[0];
      let matchedProperty = null;
      if (prop?.atakNumber) {
        // Primary: exact ATAK match (check both atakNumber and altAtakNumbers)
        matchedProperty = existingProperties.find(
          (p) => p.atakNumber === prop.atakNumber ||
            p.altAtakNumbers?.includes(prop.atakNumber)
        );
        // Fallback: match by street + floor (co-owned properties have different ATAKs)
        if (!matchedProperty && prop.address?.street1) {
          const floorMatch = prop.rawAddress?.match(/Όροφος\s+(\d+)/);
          const floor = floorMatch ? parseInt(floorMatch[1], 10) : null;
          // street1 may include appended floor (e.g. "ΚΑΛΑΜΩΝ 24, Όροφος 1")
          // Extract just the street+number part before the comma
          const streetOnly = prop.address.street1.split(',')[0].trim();
          if (floor !== null) {
            matchedProperty = existingProperties.find(
              (p) => {
                if (!p.name?.includes(streetOnly)) return false;
                if (!p.name?.includes(`Όροφος ${floor}`)) return false;
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

      return { months, matchedProperty, matchedTenant, occupiedBy };
    });
  }, [parsedResults, existingProperties, existingTenants]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setState('idle');
    setFiles([]);
    setParsedResults([]);
    setSelectedLeaseIds({});
  }, [setOpen]);

  const handleParse = useCallback(async () => {
    if (files.length === 0) return;

    setState('loading');
    try {
      const results = [];
      for (const file of files) {
        const result = await importTenantPdf(file);
        results.push({ ...result, _fileName: file.name });
      }
      // Deduplicate: skip files with same declaration number or same tenant+property
      const seen = new Set();
      const unique = results.filter((r) => {
        const key = r.declarationNumber
          || `${r.tenants?.[0]?.taxId}_${r.properties?.[0]?.atakNumber}`;
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
    } catch {
      toast.error(t('Error parsing PDF'));
      setState('idle');
    }
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
            name: `Μίσθωση ${months} μηνών`,
            numberOfTerms: months,
            timeRange: 'months',
            active: true
          });
          leaseId = newLease._id;
        }

        // 2. Resolve property
        const prop = parsed.properties[0];
        const propertyData = {
          name: prop.atakNumber || prop.rawAddress || 'Imported property',
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
          property = await updateProperty({
            _id: matchInfo.matchedProperty._id,
            ...propertyData
          });
        } else {
          property = await createProperty(propertyData);
        }

        // 3. Resolve tenant
        const primaryTenant = parsed.tenants[0];
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
        created.push(tenant);
      }

      return created;
    },
    onSuccess: (tenants) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LEASES] });
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
              onFilesChange={setFiles}
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
