import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  createLease,
  createProperty,
  createTenant,
  extendTenantLease,
  fetchBuildings,
  fetchLeases,
  fetchProperties,
  fetchTenant,
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
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
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
  // PDF-import-as-lease-extension: per-row merge strategy.
  //   'extend'  → preserve history (push prior lease into leaseHistory[])
  //   'replace' → in-place update of root fields (legacy behavior)
  //   'new'     → bypass taxId guard, create a brand-new tenant
  // The default per row is derived from the server-side classification
  // (kind=extension → 'extend', kind=update → 'replace', kind=review →
  //  'new', kind=new → 'new'). The user can override via the radio group.
  const [importStrategies, setImportStrategies] = useState({});

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

      // P2.10 / N7: AADE PDFs occasionally surface mis-keyed dates where
      // validityEnd is on or before validityStart (typo on the original
      // declaration; user-supplied amendment with a wrong end). Compute a
      // dateInvalid flag so the preview can warn AND the Import button
      // stays disabled rather than producing a tenant whose lease is
      // already expired before it begins.
      const _vs = moment(parsed.validityStart, 'DD/MM/YYYY', true);
      const _ve = moment(parsed.validityEnd, 'DD/MM/YYYY', true);
      const dateInvalid =
        _vs.isValid() && _ve.isValid() ? !_ve.isAfter(_vs) : false;

      // Server-side classification (services/api/src/managers/pdfimportmanager).
      // Falls back to a client-side heuristic when older API responses don't
      // carry the field — matches kind=extension if the parsed primary taxId
      // matches an existing tenant whose endDate is within ~30 days of the
      // parsed validityStart and validityEnd extends past it.
      let classificationKind = parsed.classification?.kind;
      if (!classificationKind) {
        if (matchedTenant && firstTaxId && matchedTenant.taxId === firstTaxId) {
          const existingEnd = matchedTenant.endDate
            ? moment(matchedTenant.endDate)
            : null;
          const isExtension =
            existingEnd &&
            existingEnd.isValid() &&
            !matchedTenant.terminationDate &&
            _vs.isValid() &&
            _ve.isValid() &&
            _vs.diff(existingEnd, 'days') >= -30 &&
            _ve.isAfter(existingEnd);
          classificationKind = isExtension ? 'extension' : 'update';
        } else if (
          matchedTenant &&
          firstTaxId &&
          matchedTenant.taxId !== firstTaxId
        ) {
          classificationKind = 'review';
        } else {
          classificationKind = 'new';
        }
      }

      return {
        months,
        pastMonths,
        matchedProperty,
        matchedTenant,
        occupiedBy,
        dateInvalid,
        classificationKind
      };
    });
  }, [parsedResults, existingProperties, existingTenants]);

  // Default the per-row merge strategy from the classification kind, but
  // only when the user has not yet picked an explicit choice for that row
  // (otherwise toggling a Select / Checkbox elsewhere in the row would
  // clobber the user's selection on every render).
  useEffect(() => {
    if (parsedResults.length === 0) return;
    setImportStrategies((prev) => {
      const next = { ...prev };
      let changed = false;
      matchInfos.forEach((info, idx) => {
        if (next[idx] !== undefined) return;
        let def;
        switch (info?.classificationKind) {
          case 'extension':
            def = 'extend';
            break;
          case 'update':
            def = 'replace';
            break;
          case 'review':
            def = 'new';
            break;
          default:
            def = 'new';
        }
        next[idx] = def;
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [matchInfos, parsedResults.length]);

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
    setImportStrategies({});
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
    let unique = results.filter((r) => {
      const key =
        r.declarationNumber ||
        `${r.tenants?.[0]?.taxId}_${r.properties?.[0]?.atakNumber}`;
      if (!key || key === 'undefined_undefined') return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // P2.8 / L6: cross-reference amendments against their originals. The
    // declarationNumber-only key above lets BOTH "12345" (original) and
    // "12345-AMD" (amendment whose amendsDeclaration === "12345") through
    // because they have distinct declaration numbers. When the user drops
    // an entire AADE export folder for a tenant they end up with N rows
    // for the same lease. Prefer the amendment (newer / most recent state)
    // and drop the originals it amends.
    const amendsDeclSet = new Set(
      unique
        .map((r) => r.amendsDeclaration)
        .filter((d) => typeof d === 'string' && d.length > 0)
    );
    if (amendsDeclSet.size > 0) {
      unique = unique.filter(
        (r) => !(r.declarationNumber && amendsDeclSet.has(r.declarationNumber))
      );
    }
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
      // P2.11 / N8: track every skip reason so the success toast can
      // surface a non-zero count to the user. Without this the dialog
      // silently auto-navigated on a single success even when N rows
      // were dropped (occupied / invalid dates / no resolvable property).
      let skipped = 0;

      for (let idx = 0; idx < parsedResults.length; idx++) {
        const parsed = parsedResults[idx];
        const matchInfo = matchInfos[idx];

        // Skip entries where property is occupied by another tenant
        if (matchInfo?.occupiedBy) {
          skipped += 1;
          continue;
        }
        // P2.10 / N7: defense in depth — the Import button is disabled
        // when any row's validityEnd <= validityStart, but if we ever
        // reach the mutation with an invalid row (programmatic call,
        // race), skip it cleanly rather than persist a backwards lease.
        if (matchInfo?.dateInvalid) {
          skipped += 1;
          continue;
        }

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

        // 2. Resolve properties (P2.9 / N1)
        // AADE PDFs may declare multiple properties under a single lease
        // (e.g. apartment + storage room + parking spot, all rented to the
        // same tenant). Iterate over `parsed.properties` and create or
        // match each one — previously only properties[0] was processed
        // and the rest were silently dropped. Each iteration goes through
        // the same resolve-property → ensure-building flow as before; the
        // outputs are accumulated into `resolvedProperties` and threaded
        // into the tenant body's properties[] array further down.
        const resolvedProperties = [];
        for (let pIdx = 0; pIdx < parsed.properties.length; pIdx++) {
          const prop = parsed.properties[pIdx];
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

        // Per-property match resolution: matchInfo only carries the
        // primary (properties[0]) match. For pIdx > 0 (additional
        // properties on a multi-property lease) we look up the match
        // inline against existingProperties using the same atak-or-
        // street-floor heuristic the matchInfos memo uses.
        let perPropertyMatch = null;
        let perPropertyOccupiedBy = null;
        if (pIdx === 0) {
          perPropertyMatch = matchInfo?.matchedProperty || null;
          perPropertyOccupiedBy = matchInfo?.occupiedBy || null;
        } else if (prop?.atakNumber) {
          perPropertyMatch =
            existingProperties.find(
              (p) =>
                p.atakNumber === prop.atakNumber ||
                p.altAtakNumbers?.includes(prop.atakNumber)
            ) || null;
          if (perPropertyMatch && !matchInfo?.matchedTenant) {
            perPropertyOccupiedBy =
              existingTenants.find((t) =>
                t.properties?.some(
                  (tp) => tp.propertyId === perPropertyMatch._id
                )
              ) || null;
          }
        }

        // Skip properties already occupied by another tenant — the user
        // saw the warning at preview time. Continue with the remaining
        // properties on the same lease so we don't lose data.
        if (perPropertyOccupiedBy) continue;

        let property;
        if (perPropertyMatch) {
          // P1.7 / M3: only overwrite the existing property when the user
          // explicitly opted in via the per-row checkbox. Default OFF so
          // re-importing the same lease (or an amendment) doesn't silently
          // clobber manual edits like surface corrections, custom name,
          // expense categories, etc.
          if (updatePropertyFlags[idx]) {
            property = await updateProperty({
              _id: perPropertyMatch._id,
              ...propertyData
            });
          } else {
            property = perPropertyMatch;
          }
        } else {
          // P2.12 / N9: a concurrent identical import (same PDF, two
          // tabs / two browsers / a re-clicked button) can race past the
          // existingProperties match and try to insert a duplicate
          // atakNumber. Mongo answers with E11000 which the common
          // errorHandler now translates to 409. Recover by re-fetching
          // properties and treating the duplicate as already-imported.
          try {
            property = await createProperty(propertyData);
          } catch (err) {
            if (err?.response?.status === 409 && propertyData.atakNumber) {
              const refreshedProps = await fetchProperties();
              const dup = refreshedProps.find(
                (p) =>
                  p.atakNumber === propertyData.atakNumber ||
                  p.altAtakNumbers?.includes(propertyData.atakNumber)
              );
              if (dup) {
                property = dup;
              } else {
                throw err;
              }
            } else {
              throw err;
            }
          }
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

        // Record the resolved property + per-property rent so the tenant
        // body below can attach all of them. prop.monthlyRent is the
        // per-property amount AADE emits separately from the lease total.
        resolvedProperties.push({
          property,
          rent: prop.monthlyRent || 0
        });
        }
        // End P2.9 / N1 per-property loop.

        // No properties resolved at all (every property on the lease was
        // occupied by another tenant). Skip this lease entirely; the
        // outer loop's `created` array is the success ledger so we
        // simply don't push.
        if (resolvedProperties.length === 0) {
          skipped += 1;
          continue;
        }

        // 3. Resolve tenant
        // P1.1 / M6: client-side defense — even though the server now
        // 422s non-lease PDFs in pdfimportmanager, malformed legitimate
        // PDFs may produce a tenants[0] without a name. Don't crash the
        // whole batch on a single weird row.
        const primaryTenant = parsed.tenants?.[0];
        if (!primaryTenant?.name) {
          skipped += 1;
          continue;
        }
        // P2.5 / M8: when the parser flagged this tenant as a Greek legal
        // entity (Α.Ε., Ε.Π.Ε., etc.), persist it as a company instead of
        // first/last-name-decomposing the legal name. The Tenant schema
        // accepts isCompany/company/manager/legalForm — the API just
        // round-trips them. We don't have a manager name from the AADE
        // PDF, so leave that empty for the user to fill in.
        const isCompany = !!primaryTenant.isCompany;
        const nameParts = primaryTenant.name.split(/\s+/);
        const lastName = isCompany ? '' : nameParts[0] || '';
        const firstName = isCompany ? '' : nameParts.slice(1).join(' ') || '';
        const beginDate = parsed.validityStart || parsed.originalStartDate;
        const tenantData = {
          name: primaryTenant.name,
          firstName,
          lastName,
          isCompany,
          company: isCompany
            ? primaryTenant.companyName || primaryTenant.name
            : '',
          legalForm: isCompany ? primaryTenant.legalForm || '' : '',
          manager: '',
          leaseId,
          beginDate,
          endDate: parsed.validityEnd || '',
          properties: resolvedProperties.map((rp) => ({
            propertyId: rp.property._id,
            rent: rp.rent,
            expenses: [],
            entryDate: beginDate,
            exitDate: parsed.validityEnd || ''
          })),
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
              contact: isCompany
                ? primaryTenant.companyName || primaryTenant.name
                : `${firstName} ${lastName}`.trim(),
              email: '',
              phone1: '',
              phone2: ''
            }
          ],
          stepperMode: false
        };

        let tenant;
        const strategy = importStrategies[idx] || 'new';
        // 'extend' and 'replace' both require an existing matched tenant.
        // If the user picked one of those without a match (shouldn't be
        // possible from the UI, but guard anyway), fall back to creating
        // a new tenant rather than crashing on a null _id.
        const canMergeIntoExisting =
          !!matchInfo?.matchedTenant && strategy !== 'new';
        if (canMergeIntoExisting && strategy === 'extend') {
          // PDF-import-as-lease-extension: server snapshots the prior
          // root-level lease window into leaseHistory[] before applying the
          // new declaration's dates / declaration number. The parsed object
          // we POST is the same shape parseImportedPdf returned plus the
          // resolved leaseId so the server doesn't have to re-resolve.
          //
          // Refresh __v from a live GET before POSTing — the matchInfo
          // snapshot may be minutes old (the dialog stays mounted) and the
          // server's optimistic-lock guard 422s on stale __v. Same pattern
          // as the replace branch below.
          let extendVersion = matchInfo.matchedTenant.__v;
          try {
            const fresh = await fetchTenant(matchInfo.matchedTenant._id);
            if (fresh && typeof fresh.__v === 'number') {
              extendVersion = fresh.__v;
            }
          } catch {
            // Fall through to the cached __v; server will 409 if it lost
            // the race and the user can retry.
          }
          tenant = await extendTenantLease(matchInfo.matchedTenant._id, {
            ...parsed,
            leaseId,
            __v: extendVersion
          });
        } else if (canMergeIntoExisting && strategy === 'replace') {
          // P2.1 / H2: previously the PATCH overwrote properties[] with a
          // single-element array built from parsed.properties[0], wiping any
          // existing property entries on a multi-property tenant. GET the
          // current tenant, merge the new property entry keyed on
          // propertyId (skip if already present, append if new), and PATCH
          // the merged body. Also thread __v from the matched fixture so
          // occupantmanager's optimistic-lock guard accepts the request
          // (otherwise it 422s on missing __v).
          let mergedProperties = tenantData.properties;
          let baseVersion = matchInfo.matchedTenant.__v;
          try {
            const fresh = await fetchTenant(matchInfo.matchedTenant._id);
            const existing = Array.isArray(fresh?.properties)
              ? fresh.properties
              : [];
            const existingIds = new Set(
              existing.map((p) => String(p.propertyId))
            );
            // Append only the parsed entries that are not already on the
            // tenant. P2.9 / N1 produces N entries (one per parsed
            // property) so we walk the whole list rather than only [0].
            const newEntries = tenantData.properties.filter(
              (e) => !existingIds.has(String(e.propertyId))
            );
            mergedProperties = newEntries.length
              ? [...existing, ...newEntries]
              : existing;
            if (Number.isFinite(fresh?.__v)) {
              baseVersion = fresh.__v;
            }
          } catch {
            // GET failed — fall back to the dialog's snapshot to avoid
            // blocking the import. The merge degrades to "old behavior"
            // for this one row only, which is the safest fallback when
            // we can't read the live state.
          }
          tenant = await updateTenant({
            _id: matchInfo.matchedTenant._id,
            ...tenantData,
            properties: mergedProperties,
            __v: baseVersion
          });
        } else {
          // P2.12 / N9: concurrent same-PDF imports may try to insert two
          // tenants with the same taxId. The server now translates that
          // E11000 into a 409. Re-read tenants and treat the duplicate as
          // already-imported (success). If we somehow can't find the
          // duplicate (race vs another in-flight import that hasn't
          // committed yet), surface a recoverable error.
          try {
            tenant = await createTenant(tenantData);
          } catch (err) {
            if (err?.response?.status === 409 && tenantData.taxId) {
              const refreshedTenants = await fetchTenants();
              const dup = refreshedTenants.find(
                (t) =>
                  t.taxId === tenantData.taxId ||
                  t.coTenants?.some((ct) => ct.taxId === tenantData.taxId)
              );
              if (dup) {
                tenant = dup;
              } else {
                toast.warning(
                  t(
                    'Another import is in progress; please retry'
                  )
                );
                throw err;
              }
            } else {
              throw err;
            }
          }
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
          // Past-month settlement amount: prefer the existing rent's
          // grandTotal (accurate ledger), then the sum of all resolved
          // properties' monthlyRent (in-scope here — `prop` from the
          // earlier per-property loop is NOT in scope at this point and
          // referencing it threw ReferenceError on every settlement
          // where grandTotal was falsy).
          const sumPropertyRents = (resolvedProperties || []).reduce(
            (s, rp) => s + (Number(rp.rent) || 0),
            0
          );
          while (termDate.isBefore(now, 'month')) {
            const term = termDate.format('YYYYMM') + '0100';
            const rentForTerm = tenantRents.find((r) => String(r.term) === term);
            const amount =
              rentForTerm?.total?.grandTotal ||
              sumPropertyRents ||
              parsed.totalMonthlyRent ||
              0;
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

      return { created, skipped };
    },
    onSuccess: ({ created: tenants, skipped }) => {
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
      // P2.11 / N8: surface skipped count alongside the success message
      // so a single-success import that swallowed N occupied / invalid
      // rows isn't silently auto-navigated. Always toast first; navigate
      // afterwards.
      if (skipped > 0) {
        toast.success(
          t(
            'Imported {{count}} tenant ({{skipped}} skipped — already occupied or invalid)',
            { count: tenants.length, skipped }
          )
        );
      } else if (tenants.length !== 1) {
        toast.success(
          t('{{count}} tenants imported', { count: tenants.length })
        );
      }
      if (tenants.length === 1 && tenants[0]?._id) {
        router.push(
          `/${store.organization.selected?.name}/tenants/${tenants[0]._id}`,
          undefined,
          { locale: store.organization.selected?.locale }
        );
      }
    },
    onError: (err) => {
      // Surface the server's actual error so the user can tell apart:
      //   - 422 window-mismatch ("Some payments will be lost...")
      //   - 409 stale __v ("Update conflict: tenant was modified...")
      //   - 404 lease/tenant not found
      //   - 500 backend down
      // The previous flat 'Error creating tenant' hid all of these and
      // left the user retrying the same broken click.
      const status = err?.response?.status;
      const serverMsg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message;
      let copy;
      if (status === 409) {
        copy = t(
          'This tenant was changed by another window. Reload the page and try again.'
        );
      } else if (status === 422 && serverMsg) {
        // 422 messages from validators are user-actionable; show as-is.
        copy = serverMsg;
      } else if (status === 404 && serverMsg) {
        copy = serverMsg;
      } else if (serverMsg) {
        copy = serverMsg;
      } else {
        copy = t('Error creating tenant');
      }
      toast.error(copy);
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
                          {info.classificationKind === 'extension'
                            ? t('Lease extension detected')
                            : t('Update')}
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
                        {info.classificationKind === 'extension'
                          ? t('Lease extension detected')
                          : t('Tenant already exists')}
                        :{' '}{info.matchedTenant.name}
                      </div>
                    )}

                    {info?.matchedTenant && !info?.occupiedBy && (
                      <div className="space-y-1 pt-2 p-2 bg-muted/50 rounded-md">
                        <Label className="text-xs">
                          {t('Lease extension detected')}
                        </Label>
                        <RadioGroup
                          value={importStrategies[idx] || 'new'}
                          onValueChange={(v) =>
                            setImportStrategies((prev) => ({
                              ...prev,
                              [idx]: v
                            }))
                          }
                          className="gap-1"
                        >
                          <RadioGroupItem
                            id={`strategy-extend-${idx}`}
                            value="extend"
                          >
                            {t('Extend lease')}
                          </RadioGroupItem>
                          <RadioGroupItem
                            id={`strategy-replace-${idx}`}
                            value="replace"
                          >
                            {t('Replace in place')}
                          </RadioGroupItem>
                          <RadioGroupItem
                            id={`strategy-new-${idx}`}
                            value="new"
                          >
                            {t('Create new tenant')}
                          </RadioGroupItem>
                        </RadioGroup>
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

                    {info?.dateInvalid && (
                      <div className="flex items-center gap-1 text-xs text-red-700">
                        <LuAlertTriangle className="size-3" />
                        {t(
                          'Lease end date is before start date — please verify the source PDF'
                        )}
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

                    {/* P2.9 / N1: render one row per parsed property so
                        multi-property leases (apartment + storage room +
                        parking) surface the full set the import will
                        create / attach. */}
                    {parsed.properties.map((p, pIdx) => (
                      <div
                        key={pIdx}
                        className="text-sm text-muted-foreground"
                      >
                        <LuCheck className="inline size-3 mr-1" />
                        {p.address?.street1}
                        {p.surface ? ` · ${p.surface} τμ` : ''}
                        {p.atakNumber ? ` · ΑΤΑΚ: ${p.atakNumber}` : ''}
                      </div>
                    ))}

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
            <Button
              onClick={handleConfirm}
              // P2.10 / N7: gate the Import button on every importable row
              // having validityEnd > validityStart. We don't filter the
              // invalid rows out — surfacing the per-row warning AND
              // blocking the action lets the user fix the source PDF
              // (or remove that file from the batch) instead of silently
              // skipping it.
              disabled={
                isLoading ||
                matchInfos.some(
                  (info) => info?.dateInvalid && !info?.occupiedBy
                )
              }
            >
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
