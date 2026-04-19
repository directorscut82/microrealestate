import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { Input } from '../ui/input';
import { Label } from '../ui/label';
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
  const fileInputRef = useRef();
  const [parsed, setParsed] = useState(null);
  const [selectedLeaseId, setSelectedLeaseId] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [matchInfo, setMatchInfo] = useState(null);

  const { data: leases = [] } = useQuery({
    queryKey: [QueryKeys.LEASES],
    queryFn: fetchLeases
  });

  const { data: existingProperties = [] } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties,
    enabled: !!parsed
  });

  const { data: existingTenants = [] } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: fetchTenants,
    enabled: !!parsed
  });

  const activeLeases = useMemo(() => leases.filter((l) => l.active), [leases]);

  // Auto-match lease and detect existing property/tenant when parsed data arrives
  useEffect(() => {
    if (!parsed) {
      setMatchInfo(null);
      return;
    }

    const months = computeMonths(parsed.validityStart, parsed.validityEnd);

    // Match lease by numberOfTerms + timeRange
    const matchedLease = activeLeases.find(
      (l) => l.numberOfTerms === months && l.timeRange === 'months'
    );
    if (matchedLease) {
      setSelectedLeaseId(matchedLease._id);
    }

    // Match property by ATAK number
    const prop = parsed.properties[0];
    const matchedProperty = prop?.atakNumber
      ? existingProperties.find((p) => p.atakNumber === prop.atakNumber)
      : null;

    // Match tenant by first tenant's taxId
    const firstTaxId = parsed.tenants[0]?.taxId;
    const matchedTenant = firstTaxId
      ? existingTenants.find(
          (t) =>
            t.taxId === firstTaxId ||
            t.coTenants?.some((ct) => ct.taxId === firstTaxId)
        )
      : null;

    setMatchInfo({
      months,
      matchedLease,
      matchedProperty,
      matchedTenant
    });
  }, [parsed, activeLeases, existingProperties, existingTenants]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!parsed) return;

      const months = matchInfo?.months || computeMonths(parsed.validityStart, parsed.validityEnd);

      // 1. Resolve lease — use selected, or auto-create
      let leaseId = selectedLeaseId;
      if (!leaseId) {
        const newLease = await createLease({
          name: `Μίσθωση ${months} μηνών`,
          numberOfTerms: months,
          timeRange: 'months',
          active: true
        });
        leaseId = newLease._id;
      }

      // 2. Resolve property — match by ATAK or create
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
                ? moment(prop.energyCertificate.issueDate, 'DD/MM/YYYY').toISOString()
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

      // 3. Resolve tenant — match by taxId or create
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

      return tenant;
    },
    onSuccess: (tenant) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LEASES] });
      setOpen(false);
      setParsed(null);
      setSelectedLeaseId('');
      if (tenant?._id) {
        router.push(
          `/${store.organization.selected?.name}/tenants/${tenant._id}`,
          undefined,
          { locale: store.organization.selected?.locale }
        );
      }
    },
    onError: () => {
      toast.error(t('Error creating tenant'));
    }
  });

  const handleFileSelect = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setIsUploading(true);
      try {
        const result = await importTenantPdf(file);
        setParsed(result);
      } catch {
        toast.error(t('Error parsing PDF'));
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [t]
  );

  const handleConfirm = useCallback(() => {
    createMutation.mutate();
  }, [createMutation]);

  const isLoading = isUploading || createMutation.isPending;

  return (
    <ResponsiveDialog
      open={open}
      setOpen={(v) => {
        if (!v) {
          setParsed(null);
          setSelectedLeaseId('');
          setMatchInfo(null);
        }
        setOpen(v);
      }}
      isLoading={isLoading}
      renderHeader={() => t('Import from PDF')}
      renderContent={() =>
        !parsed ? (
          <div className="p-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('Upload a Greek government lease PDF to import tenant data')}
            </p>
            <Input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileSelect}
              disabled={isLoading}
            />
          </div>
        ) : (
          <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">
                {parsed.isAmendment
                  ? t('Amendment')
                  : t('Original declaration')}
                {' #'}
                {parsed.declarationNumber}
              </h3>
              {parsed.amendsDeclaration && (
                <p className="text-xs text-muted-foreground">
                  {t('Amends')}: #{parsed.amendsDeclaration}
                </p>
              )}
            </div>

            {/* Match indicators */}
            {matchInfo?.matchedTenant && (
              <div className="text-xs bg-yellow-50 border border-yellow-200 rounded p-2">
                ⚠️ {t('Existing tenant found')}: {matchInfo.matchedTenant.name} — {t('will be updated')}
              </div>
            )}
            {matchInfo?.matchedProperty && (
              <div className="text-xs bg-yellow-50 border border-yellow-200 rounded p-2">
                ⚠️ {t('Existing property found')}: {matchInfo.matchedProperty.name} — {t('will be updated')}
              </div>
            )}

            {parsed.landlords?.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs font-semibold">{t('Landlords')}</Label>
                {parsed.landlords.map((landlord, i) => (
                  <div key={i} className="text-sm">
                    {landlord.name}{' '}
                    <span className="text-muted-foreground">
                      (ΑΦΜ: {landlord.taxId}, {landlord.ownershipPercent}%)
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs font-semibold">{t('Tenants')}</Label>
              {parsed.tenants.map((tenant, i) => (
                <div key={i} className="text-sm">
                  {tenant.name}{' '}
                  <span className="text-muted-foreground">
                    (ΑΦΜ: {tenant.taxId})
                  </span>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs font-semibold">
                  {t('Start date')}
                </Label>
                <p className="text-sm">{parsed.validityStart}</p>
              </div>
              <div>
                <Label className="text-xs font-semibold">
                  {t('End date')}
                </Label>
                <p className="text-sm">{parsed.validityEnd}</p>
              </div>
            </div>

            <div>
              <Label className="text-xs font-semibold">
                {t('Monthly rent')}
              </Label>
              <p className="text-sm">{parsed.totalMonthlyRent} €</p>
            </div>

            {parsed.properties.map((prop, i) => (
              <div key={i} className="border rounded p-2 space-y-1">
                <p className="text-sm font-medium">{prop.category}</p>
                <p className="text-sm">
                  {prop.address?.street1}
                  {prop.address?.zipCode && `, ${prop.address.zipCode}`}
                  {prop.address?.city && ` ${prop.address.city}`}
                  {prop.address?.state && `, ${prop.address.state}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {prop.surface} τμ · ΑΤΑΚ: {prop.atakNumber} · ΔΕΗ:{' '}
                  {prop.dehNumber}
                </p>
                {prop.energyCertificate && (
                  <p className="text-xs text-muted-foreground">
                    {t('Energy')}: {prop.energyCertificate.energyClass} (
                    {prop.energyCertificate.number})
                  </p>
                )}
              </div>
            ))}

            <div className="space-y-1">
              <Label className="text-xs font-semibold">{t('Contract')}</Label>
              {matchInfo && !matchInfo.matchedLease && !selectedLeaseId && (
                <p className="text-xs text-muted-foreground">
                  {t('A new contract will be created')}: Μίσθωση{' '}
                  {matchInfo.months} μηνών
                </p>
              )}
              <Select
                value={selectedLeaseId}
                onValueChange={setSelectedLeaseId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Auto-create from PDF dates')} />
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
        )
      }
      renderFooter={() =>
        parsed ? (
          <Button onClick={handleConfirm} disabled={isLoading}>
            {matchInfo?.matchedTenant ? t('Update') : t('Import')}
          </Button>
        ) : null
      }
    />
  );
}
