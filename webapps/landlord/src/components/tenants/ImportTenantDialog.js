import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import {
  createDocument,
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
import { apiFetcher, uploadDocument } from '../../utils/fetch';
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

/**
 * `initialImport` (optional) — open pre-filled from a Telegram inbox item
 * instead of an upload: { parsed, fileName, fileBlob|null, onImported }.
 * `parsed` is the SAME shape importTenantPdf returns (the server stored it
 * verbatim and re-ran the classification fresh); fileBlob feeds the
 * persist-original-PDF step at confirm time and may be null (that step is
 * best-effort and skips without it, exactly as it does today when _file is
 * absent). onImported fires after a successful import so the page can consume
 * the inbox item.
 */
export default function ImportTenantDialog({ open, setOpen, initialImport }) {
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

  // Hydrate from a Telegram inbox item: skip the upload phase entirely and
  // land on the SAME preview the upload path builds. The row shape mirrors
  // handleParse's `{ ...result, _fileName, _file }` — everything downstream
  // (lease matching, merge strategies, the confirm) is shared code.
  // Hydrate ONCE per item: a re-fired effect would overwrite the strategies and
  // flags the landlord has already set on the preview rows.
  const hydratedRef = React.useRef(null);
  useEffect(() => {
    if (!open || !initialImport?.parsed) return;
    if (hydratedRef.current === initialImport.itemId) return;
    hydratedRef.current = initialImport.itemId;
    setParsedResults([
      {
        ...initialImport.parsed,
        classification: initialImport.parsed.classification,
        _fileName: initialImport.fileName || 'lease.pdf',
        _file: initialImport.fileBlob || null
      }
    ]);
    setState('preview');
  }, [open, initialImport]);

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
          (p) =>
            p.atakNumber === prop.atakNumber ||
            p.altAtakNumbers?.includes(prop.atakNumber)
        );
        // Fallback: match by street + floor (co-owned properties have different ATAKs)
        if (!matchedProperty && prop?.address?.street1) {
          const floorMatch = prop.rawAddress?.match(/Όροφος\s+(\d+)/);
          const isIsogeio =
            !floorMatch && /Ισόγειο/i.test(prop.rawAddress || '');
          const floor = floorMatch
            ? parseInt(floorMatch[1], 10)
            : isIsogeio
              ? 0
              : null;
          const floorLabel =
            floor === 0 ? 'Ισόγειο' : floor != null ? `Όροφος ${floor}` : null;
          // street1 may include appended floor (e.g. "ΟΔΟΣ ΗΤΑ 24, Όροφος 1")
          // Extract just the street+number part before the comma
          const streetOnly = (prop.address?.street1 || '').split(',')[0].trim();
          if (floor !== null && floorLabel) {
            matchedProperty = existingProperties.find((p) => {
              if (!p.name?.includes(streetOnly)) return false;
              if (!p.name?.includes(floorLabel)) return false;
              // If surface available, prefer exact surface match
              if (
                prop.surface &&
                p.surface &&
                Math.abs(p.surface - prop.surface) > 1
              )
                return false;
              return true;
            });
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
        occupiedBy = existingTenants.find((t) =>
          t.properties?.some((tp) => tp.propertyId === matchedProperty._id)
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
    // Reset the hydrate-once guard too — see ImportE9Dialog's note: without it a
    // second «Άνοιγμα» on the same item opens an empty dialog.
    hydratedRef.current = null;
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
        // _file: kept so the confirm step can persist the ORIGINAL lease PDF
        // to the tenant's documents (B2) — before this, all imported PDFs
        // were parsed in memory and discarded.
        results.push({ ...result, _fileName: file.name, _file: file });
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
      // BUGFIX (multi-tenant import collapse, reported 2026-07): the loop body
      // used to let ANY non-409 error (e.g. the server's 422 double-occupancy
      // guard) throw straight out of mutationFn — aborting the WHOLE batch, so
      // only tenants created before the first failure survived and the rest
      // vanished with just a raw error toast. Now every row is wrapped in
      // try/catch: a failure records a reason and continues, so one bad PDF
      // can't drop the others. `failures[]` is surfaced in the result toast.
      const failures = [];

      // BUGFIX (import 422 "lease with name ... already exists", reported
      // 2026-07): the auto-match effect only reuses leases that already exist
      // in the query cache. Two PDFs in the SAME batch with the same month
      // count (e.g. both 24) each found no pre-existing lease, so BOTH called
      // createLease with the identical name "Lease 24 months" — the 2nd 422'd
      // and that row died. Cache leases created (or matched) during THIS batch
      // by name so the second row reuses the first row's lease instead of
      // re-POSTing a duplicate. Seed it with the leases already on the realm.
      const leaseByName = new Map();
      for (const l of activeLeases) {
        if (l?.name) leaseByName.set(l.name, l._id);
      }

      for (let idx = 0; idx < parsedResults.length; idx++) {
        const parsed = parsedResults[idx];
        const matchInfo = matchInfos[idx];
        const rowName =
          parsed?.tenants?.[0]?.name || t('Tenant {{n}}', { n: idx + 1 });

        // Skip entries where property is occupied by another tenant
        if (matchInfo?.occupiedBy) {
          skipped += 1;
          failures.push({ name: rowName, reason: 'occupied' });
          continue;
        }
        // P2.10 / N7: defense in depth — the Import button is disabled
        // when any row's validityEnd <= validityStart, but if we ever
        // reach the mutation with an invalid row (programmatic call,
        // race), skip it cleanly rather than persist a backwards lease.
        if (matchInfo?.dateInvalid) {
          skipped += 1;
          failures.push({ name: rowName, reason: 'invalidDates' });
          continue;
        }

        try {
          const months =
            matchInfo?.months ||
            computeMonths(parsed.validityStart, parsed.validityEnd);

          // 1. Resolve lease
          let leaseId = selectedLeaseIds[idx] || '';
          if (!leaseId) {
            const leaseName = t('Lease {{count}} months', { count: months });
            // Reuse a lease of the same name created earlier in THIS batch (or
            // already on the realm) instead of POSTing a duplicate that 422s.
            leaseId = leaseByName.get(leaseName) || '';
            if (!leaseId) {
              try {
                const newLease = await createLease({
                  name: leaseName,
                  numberOfTerms: months,
                  timeRange: 'months',
                  active: true
                });
                leaseId = newLease._id;
              } catch (leaseErr) {
                // Defensive: if the server reports the name already exists
                // (concurrent/duplicate), refetch and reuse it rather than
                // failing the row.
                const msg =
                  leaseErr?.response?.data?.message || leaseErr?.message || '';
                if (
                  leaseErr?.response?.status === 422 &&
                  /already exists/i.test(msg)
                ) {
                  const fresh = await fetchLeases();
                  const found = (fresh || []).find((l) => l.name === leaseName);
                  if (!found) throw leaseErr;
                  leaseId = found._id;
                } else {
                  throw leaseErr;
                }
              }
            }
            leaseByName.set(leaseName, leaseId);
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
          // Track properties dropped because they're occupied by ANOTHER tenant,
          // so a multi-property lease that loses SOME (but not all) properties
          // doesn't silently attach the tenant to fewer units than the PDF
          // declared (GAP A). Surfaced after the loop.
          const droppedOccupiedProps = [];
          for (let pIdx = 0; pIdx < parsed.properties.length; pIdx++) {
            const prop = parsed.properties[pIdx];
            // Compute a proper name from address (e.g. "ΟΔΟΣ ΗΤΑ 24 - Ισόγειο")
            const streetPart = (prop.address?.street1 || '')
              .split(',')[0]
              .trim();
            const floorRaw = (prop.address?.street1 || '').match(
              /Όροφος\s*(\d+)/
            );
            const floorNum = floorRaw ? parseInt(floorRaw[1], 10) : null;
            const floorLabel =
              floorNum === 0
                ? 'Ισόγειο'
                : floorNum != null
                  ? `Όροφος ${floorNum}`
                  : (prop.address?.street1 || '').match(/Ισόγειο/i)
                    ? 'Ισόγειο'
                    : null;
            const propertyName =
              streetPart && floorLabel
                ? `${streetPart} - ${floorLabel}`
                : streetPart ||
                  prop.rawAddress ||
                  prop.atakNumber ||
                  'Imported property';
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
            // properties on the same lease so we don't lose data. RECORD the drop
            // so a partial-property loss is surfaced (GAP A), not silent.
            if (perPropertyOccupiedBy) {
              droppedOccupiedProps.push(
                (prop.address?.street1 || '').split(',')[0].trim() ||
                  perPropertyOccupiedBy.name ||
                  t('a unit')
              );
              continue;
            }

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
                (b) =>
                  b.name === streetPart || b.address?.street1 === streetPart
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
            stepperMode: false,
            // "Mark all past months paid" for a NEW tenant: let the server seed
            // the past ledger already-settled at generation (Contract.create
            // autoPayThroughTerm). This replaces the old post-create PATCH loop
            // (below) that paid each month's CUMULATIVE grandTotal and thus
            // over-recorded collected N-fold (the ΟΔΟΣ ΗΤΑ 24 garbage). Only the
            // createTenant (strategy 'new') server path threads this; extend/
            // replace still use the loop until their handlers thread it too.
            // Must use the SAME predicate as the checkbox and the replace/extend
            // loop below (`=== true`), or the box reads unchecked while the server
            // still seeds the past ledger as settled.
            markPastPaid:
              markPaidFlags[idx] === true && matchInfo?.pastMonths > 0
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
                    t('Another import is in progress; please retry')
                  );
                  throw err;
                }
              } else {
                throw err;
              }
            }
          }

          // Settle past months if flag is set.
          //
          // The 'new' strategy is now handled SERVER-SIDE: createTenant received
          // markPastPaid above → Contract.create seeds the past ledger already
          // settled at generation (no cumulative carry-in). Running this client
          // loop for 'new' too would double-pay. So this loop now covers ONLY the
          // extend/replace strategies, whose server handlers (extendTenantLease /
          // updateTenant) do NOT yet thread autoPayThroughTerm.
          //
          // NOTE: for extend/replace this loop still pays totalAmount − payment
          // per term. On those paths the tenant ALREADY EXISTS with a prior
          // ledger, so a full seed-at-create isn't available; this preserves the
          // prior behavior for them until their handlers thread the directive
          // (tracked follow-up). It is NOT the cumulative-snowball path — it
          // re-fetches and pays each term's residual owed.
          if (
            strategy !== 'new' &&
            // Opt-IN. This synthesises `transfer` payments for each past term's
            // residual owed — for a tenant genuinely in arrears that FABRICATES
            // money never received and erases the debt from every surface. It was
            // pre-checked (`!== false` on an empty map is true), so the
            // destructive path was the default.
            markPaidFlags[idx] === true &&
            matchInfo?.pastMonths > 0
          ) {
            // P1.2 / M4: previously hit `/rents/:year` which is not a
            // registered route — the silent catch fell back to base
            // monthlyRent only, dropping charges/VAT/discount. Use the
            // actual endpoint (services/api/src/routes.ts:200) which
            // returns the full per-term rent ledger for this tenant in a
            // single round-trip and is correct across multi-year leases.
            const startDate = moment(
              parsed.validityStart || parsed.originalStartDate,
              'DD/MM/YYYY'
            );
            const now = moment();
            let termDate = startDate.clone();
            // BUGFIX (mark-past-paid balance snowball — reproduced live 2026-07):
            // the old code read `rentForTerm.total.grandTotal`, but the
            // /rents/tenant/:id payload (fetchTenantRents) has NO `.total`
            // object — the amounts are TOP-LEVEL (`totalAmount`, `balance`,
            // `payment`). So `.total.grandTotal` was ALWAYS undefined and every
            // month fell back to the flat monthly rent (180), underpaying while
            // the carried balance snowballed (180→360→540→720) and dumping a
            // phantom balance into the current month ("huge owed").
            // Fix: RE-FETCH the ledger before each term (so each term's owed
            // reflects prior settlements) and pay that term's TRUE owed =
            // totalAmount − already-paid. Verified: every past month settles to
            // newBalance 0 and the current month carries only its own rent.
            while (termDate.isBefore(now, 'month')) {
              const term = termDate.format('YYYYMM') + '0100';
              // L1 (destructive-write audit 2026-07): the /rents/payment PATCH
              // has REPLACE (PUT) semantics — the payments array sent OVERWRITES
              // what's on disk (rentmanager `_updateByTerm`). This loop must
              // therefore (a) preserve the term's EXISTING recorded payments and
              // (b) add only the DELTA still owed — never post `[{amount: fullOwed}]`
              // alone, which destroyed a partially-paid term's real payment(s)
              // (date/reference/allocation) and left it under-paid. Only fetch +
              // patch when a rent record exists; a fetch failure must NOT clobber
              // with a flat fallback (that wiped even a fully-paid term).
              let existingPayments = [];
              let delta = 0;
              let haveRentRecord = false;
              try {
                const snap = await fetchTenantRents(tenant._id);
                const rentForTerm = (snap?.rents || []).find(
                  (r) => String(r.term) === term
                );
                if (rentForTerm) {
                  haveRentRecord = true;
                  // Echo existing payments verbatim (dates are already
                  // DD/MM/YYYY on disk) so REPLACE preserves them.
                  existingPayments = (rentForTerm.payments || [])
                    .filter((p) => Number(p?.amount) > 0)
                    .map((p) => ({
                      amount: Number(p.amount) || 0,
                      date: p.date || '',
                      type: p.type || 'transfer',
                      reference: p.reference || '',
                      description: p.description || '',
                      promo: Number(p.promo) || 0,
                      notepromo: p.notepromo || '',
                      extracharge: Number(p.extracharge) || 0,
                      noteextracharge: p.noteextracharge || '',
                      allocation: Array.isArray(p.allocation)
                        ? p.allocation
                        : []
                    }));
                  // totalAmount includes carried balance + this month's
                  // rent/charges; `payment` is what's already recorded. Only the
                  // remaining gap needs a new mark-paid row.
                  const owed =
                    (Number(rentForTerm.totalAmount) || 0) -
                    (Number(rentForTerm.payment) || 0);
                  delta = Math.max(0, Math.round(owed * 100) / 100);
                }
              } catch (err) {
                // Fetch failed → we do NOT know the existing payments, so we must
                // NOT PATCH (a REPLACE with a fabricated array would clobber).
                console.warn(
                  `import: mark-past-paid skipped term ${term} (ledger fetch failed):`,
                  err?.response?.data?.message || err?.message || err
                );
                termDate.add(1, 'month');
                continue;
              }
              if (haveRentRecord && delta > 0.005) {
                const payments = [
                  ...existingPayments,
                  {
                    amount: delta,
                    type: 'transfer',
                    date: termDate.format('DD/MM/YYYY')
                  }
                ];
                try {
                  await apiFetcher().patch(
                    `/rents/payment/${tenant._id}/${term}`,
                    { _id: tenant._id, payments }
                  );
                } catch (err) {
                  // F8 (audit-2026-07): a real settlement failure must not vanish
                  // silently — the operator has no other signal it didn't land.
                  console.warn(
                    `import: mark-past-paid failed for ${tenant._id} term ${term}:`,
                    err?.response?.data?.message || err?.message || err
                  );
                }
              }
              termDate.add(1, 'month');
            }
          }

          created.push(tenant);

          // Persist the ORIGINAL imported lease PDF to the tenant's documents
          // (B2 via /documents/upload + a Document record). Best-effort: a
          // storage failure must never fail the import itself.
          if (parsed._file && tenant?._id && leaseId) {
            try {
              const uploadResp = await uploadDocument({
                endpoint: '/documents/upload',
                documentName: (parsed._fileName || 'lease').replace(
                  /\.pdf$/i,
                  ''
                ),
                file: parsed._file,
                folder: `${tenant.name || tenant._id}/contract_scanned_documents`
              });
              await createDocument({
                tenantId: tenant._id,
                leaseId,
                type: 'file',
                name: parsed._fileName || 'lease.pdf',
                description: t('Imported lease PDF'),
                mimeType: 'application/pdf',
                url: uploadResp.data.key,
                versionId: uploadResp.data.versionId
              });
            } catch (persistErr) {
              console.error(
                'lease PDF persist failed (non-blocking)',
                persistErr
              );
            }
          }

          // GAP A: the tenant WAS created but one or more of its declared
          // properties were dropped as already-occupied — surface that so the
          // operator knows the tenant has fewer units than the PDF declared.
          if (droppedOccupiedProps.length > 0) {
            failures.push({
              name: rowName,
              reason: 'partialProperties',
              props: droppedOccupiedProps
            });
          }
        } catch (err) {
          // Per-row isolation: a failure on ONE tenant must not abort the
          // whole batch (was the multi-tenant-collapse bug). Record why and
          // move on. 409 duplicate-taxId is already handled inline above; any
          // other status (esp. the 422 double-occupancy guard) lands here.
          const status = err?.response?.status;
          const serverMsg =
            err?.response?.data?.error || err?.response?.data?.message;
          const reason =
            status === 422 && /already assigned|occupied/i.test(serverMsg || '')
              ? 'occupied'
              : serverMsg || err?.message || 'error';
          skipped += 1;
          failures.push({ name: rowName, reason, status });
          // eslint-disable-next-line no-console
          console.warn(
            `import: skipped tenant "${rowName}"`,
            status,
            serverMsg
          );
          continue;
        }
      }

      return { created, skipped, failures };
    },
    onSuccess: ({ created: tenants, skipped, failures = [] }) => {
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
      // Telegram-opened import: consume the inbox item so the bell clears —
      // but ONLY if a tenant was actually created. `onSuccess` here means "the
      // mutation did not throw", not "something was imported": every row can be
      // skipped (property already occupied → 422, invalid dates), and this same
      // handler goes on to render «No tenants imported». Consuming then left the
      // landlord with an error toast, no tenant, and no notification to retry
      // from — recoverable only by re-sending the PDF to the bot.
      if (initialImport?.onImported && (tenants?.length ?? 0) > 0) {
        initialImport.onImported();
      }
      handleClose();
      // P2.11 / N8: surface skipped count alongside the success message
      // so a single-success import that swallowed N occupied / invalid
      // rows isn't silently auto-navigated. Always toast first; navigate
      // afterwards.
      // Surface WHICH tenants were skipped/partial and WHY (was a bare count
      // that hid a whole-batch collapse AND silent partial-property loss).
      const occupied = failures.filter((f) => f.reason === 'occupied').length;
      const invalid = failures.filter(
        (f) => f.reason === 'invalidDates'
      ).length;
      const partial = failures.filter((f) => f.reason === 'partialProperties');
      const other = failures.filter(
        (f) =>
          f.reason !== 'occupied' &&
          f.reason !== 'invalidDates' &&
          f.reason !== 'partialProperties'
      );
      const parts = [];
      if (occupied)
        parts.push(
          t('{{count}} occupied by another tenant', { count: occupied })
        );
      if (invalid) parts.push(t('{{count}} invalid dates', { count: invalid }));
      if (partial.length)
        parts.push(
          t('{{count}} imported without some occupied units', {
            count: partial.length
          }) +
            ': ' +
            partial
              .map((f) => `${f.name} (${(f.props || []).join(', ')})`)
              .join(', ')
        );
      if (other.length)
        parts.push(
          t('{{count}} error', { count: other.length }) +
            ': ' +
            other.map((f) => `${f.name} (${f.reason})`).join(', ')
        );
      const detail = parts.join(' · ');

      if (skipped > 0) {
        if (tenants.length > 0) {
          toast.warning(
            t('Imported {{count}} · {{skipped}} skipped', {
              count: tenants.length,
              skipped
            }) + (detail ? ` — ${detail}` : '')
          );
        } else {
          // NOTHING imported — make this loud (was a silent single-tenant result).
          toast.error(
            t('No tenants imported — {{skipped}} skipped', { skipped }) +
              (detail ? ` — ${detail}` : '')
          );
        }
      } else if (partial.length > 0) {
        // All requested tenants imported, but at least one lost occupied
        // properties — warn (not a silent success).
        toast.warning(
          t('{{count}} tenants imported', { count: tenants.length }) +
            (detail ? ` — ${detail}` : '')
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
                // Cap to 25 files. The server uploadRateLimit
                // (services/api/src/routes.ts) is 60 uploads/min/user and each
                // imported PDF fires 2 uploads (parse + confirm), so 25 files =
                // 50 uploads stays under the 60/min budget with headroom. (The
                // old cap was 10, mirroring a since-raised 10/min server limit.)
                if (newFiles.length > 25) {
                  toast.warning(
                    t(
                      'Maximum 25 files per import; only the first 25 will be kept'
                    )
                  );
                  setFiles(newFiles.slice(0, 25));
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
                            : info.classificationKind === 'review'
                              ? t('Possible co-tenant — please review')
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
                          : info.classificationKind === 'review'
                            ? t('Possible co-tenant — please review')
                            : t('Tenant already exists')}
                        : {info.matchedTenant.name}
                      </div>
                    )}

                    {info?.matchedTenant && !info?.occupiedBy && (
                      <div className="space-y-1 pt-2 p-2 bg-muted/50 rounded-md">
                        <Label className="text-xs">
                          {info.classificationKind === 'extension'
                            ? t('Lease extension detected')
                            : info.classificationKind === 'review'
                              ? t('Possible co-tenant — please review')
                              : t('Existing tenant — choose merge strategy')}
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
                            // F5-tenant: extend overwrites the existing
                            // tenant's lease window. When this row matched
                            // only via a co-tenant (kind=review) the
                            // existing primary is NOT the parsed primary —
                            // extend would overwrite the wrong tenant's
                            // lease. Disable here AND server-side guard.
                            disabled={info.classificationKind === 'review'}
                          >
                            {t('Extend lease')}
                          </RadioGroupItem>
                          <RadioGroupItem
                            id={`strategy-replace-${idx}`}
                            value="replace"
                            disabled={info.classificationKind === 'review'}
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
                        {t(
                          'Property occupied by {{name}} — remove them first',
                          {
                            name: info.occupiedBy.name
                          }
                        )}
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
                      <div key={pIdx} className="text-sm text-muted-foreground">
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
                        <div className="min-w-0">
                          <label
                            htmlFor={`updateProp-${idx}`}
                            className="text-sm flex items-center gap-1.5 cursor-pointer"
                          >
                            {t('Update property fields from PDF')}
                          </label>
                          {/* The label said nothing about WHAT it overwrites, while the
                              sibling toggle below carries full helper text. This one
                              replaces name, surface, RENT, address, ΑΤΑΚ, ΔΕΗ number and
                              the energy certificate. The rent matters most: the parser's
                              extractMoney returns 0 when the ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ pattern does
                              not match (greekleaseparser.ts:136), and propertyData sends
                              `prop.monthlyRent || 0` — so a PDF whose rent line differs
                              silently overwrites a real rent with 0. */}
                          <p className="mt-1 text-label text-ink-muted">
                            {t(
                              'Replaces the name, surface, rent, address, ΑΤΑΚ, ΔΕΗ number and energy certificate of the existing property with the values read from this PDF. Any manual corrections are lost. If the PDF has no readable rent, the rent becomes 0.'
                            )}
                          </p>
                        </div>
                      </div>
                    )}

                    {info?.pastMonths > 0 && (
                      <div className="flex items-center gap-2 pt-2 p-2 bg-muted/50 rounded-md">
                        <Checkbox
                          id={`markPaid-${idx}`}
                          checked={markPaidFlags[idx] === true}
                          onCheckedChange={(checked) =>
                            setMarkPaidFlags((prev) => ({
                              ...prev,
                              [idx]: checked
                            }))
                          }
                        />
                        <div className="min-w-0">
                          <label
                            htmlFor={`markPaid-${idx}`}
                            className="text-sm flex items-center gap-1.5 cursor-pointer"
                          >
                            <LuCalendarClock className="size-4 shrink-0" />
                            {t('Mark {{count}} past months as paid', {
                              count: info.pastMonths
                            })}
                          </label>
                          <p className="mt-1 text-label text-ink-muted">
                            {t(
                              'Records a payment for each of those months. Leave off unless they really were paid — for a tenant in arrears this erases the debt.'
                            )}
                          </p>
                        </div>
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
              // Dialog-only anchor for the deep-link spec: every text on the
              // review rows also appears on the bell card that opened it, so a
              // text assertion cannot prove the DIALOG rendered.
              data-cy="confirmLeaseImport"
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
