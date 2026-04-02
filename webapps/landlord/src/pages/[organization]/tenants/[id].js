import {
  createTenant,
  deleteTenant,
  fetchLeases,
  fetchProperties,
  fetchTenant,
  QueryKeys,
  updateTenant
} from '../../../utils/restcalls';
import {
  LuArrowLeft,
  LuHistory,
  LuPencil,
  LuStopCircle,
  LuTrash
} from 'react-icons/lu';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from '../../../components/ui/card';
import ConfirmDialog from '../../../components/ConfirmDialog';
import ContractOverviewCard from '../../../components/tenants/ContractOverviewCard';
import moment from 'moment';
import Page from '../../../components/Page';
import PresenceBanner from '../../../components/PresenceBanner';
import usePresence from '../../../hooks/usePresence';
import RentHistoryDialog from '../../../components/rents/RentHistoryDialog';
import RentOverviewCard from '../../../components/tenants/RentOverviewCard';
import ShortcutButton from '../../../components/ShortcutButton';
import { StoreContext } from '../../../store';
import TenantStepper from '../../../components/tenants/TenantStepper';
import TenantTabs from '../../../components/tenants/TenantTabs';
import TerminateLeaseDialog from '../../../components/tenants/TerminateLeaseDialog';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

function Tenant() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenantId = router.query.id;
  const viewers = usePresence('tenant', tenantId);

  const { data: tenant, isLoading: tenantLoading } = useQuery({
    queryKey: [QueryKeys.TENANTS, tenantId],
    queryFn: () => fetchTenant(tenantId),
    enabled: !!tenantId
  });

  const { data: properties = [] } = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties
  });

  const { data: leases = [] } = useQuery({
    queryKey: [QueryKeys.LEASES],
    queryFn: fetchLeases
  });

  const saveMutation = useMutation({
    mutationFn: (data) => (data._id ? updateTenant(data) : createTenant(data)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
    }
  });

  const removeMutation = useMutation({
    mutationFn: (ids) => deleteTenant(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
    }
  });

  const [openRentHistoryDialog, setOpenRentHistoryDialog] = useState(false);
  const [selectedRentHistory, setSelectedRentHistory] = useState(null);
  const [openConfirmEditTenant, setOpenConfirmEditTenant] = useState(false);
  const [openConfirmDeleteTenant, setOpenConfirmDeleteTenant] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [openTerminateLeaseDialog, setOpenTerminateLeaseDialog] =
    useState(false);

  // Update readOnly when tenant data loads
  useEffect(() => {
    if (tenant) {
      setReadOnly(tenant.terminated || !!tenant.properties?.length);
    }
  }, [tenant]);

  const onEditTenant = useCallback(() => setReadOnly(false), []);

  const onDeleteTenant = useCallback(async () => {
    try {
      await removeMutation.mutateAsync([tenant._id]);
      router.back();
    } catch (error) {
      const status = error?.response?.status;
      switch (status) {
        case 422:
          return toast.error(
            t('Tenant cannot be deleted because some rents have been paid')
          );
        case 404:
          return toast.error(t('Tenant does not exist'));
        case 403:
          return toast.error(t('You are not allowed to delete the tenant'));
        default:
          return toast.error(t('Something went wrong'));
      }
    }
  }, [removeMutation, tenant, router, t]);

  const onSubmit = useCallback(
    async (tenantPart) => {
      const current = tenant || {};
      const properties = (current.properties || []).map(
        ({ propertyId, entryDate, exitDate, rent, expenses }) => ({
          propertyId, entryDate, exitDate, rent, expenses
        })
      );
      const data = {
        isCompany: false,
        isVat: false,
        ...current,
        properties,
        ...tenantPart
      };

      try {
        const saved = await saveMutation.mutateAsync(data);
        if (!data._id) {
          await router.push(
            `/${router.query.organization}/tenants/${saved._id}`
          );
        }
      } catch (error) {
        const status = error?.response?.status;
        if (data._id) {
          switch (status) {
            case 422:
              return toast.error(t('Tenant name is missing'));
            case 403:
              return toast.error(t('You are not allowed to update the tenant'));
            default:
              return toast.error(t('Something went wrong'));
          }
        } else {
          switch (status) {
            case 422:
              return toast.error(t('Tenant name is missing'));
            case 403:
              return toast.error(t('You are not allowed to add a tenant'));
            case 409:
              return toast.error(t('The tenant already exists'));
            default:
              return toast.error(t('Something went wrong'));
          }
        }
      }
    },
    [tenant, saveMutation, router, t]
  );

  const selected = tenant || {};

  const showTerminateLeaseButton = useMemo(
    () =>
      !!(
        selected.beginDate &&
        selected.endDate &&
        !selected.terminationDate &&
        !selected.stepperMode &&
        !selected.terminated
      ),
    [selected]
  );

  const showEditButton = useMemo(
    () => !selected.stepperMode && selected.properties?.length > 0,
    [selected.properties?.length, selected.stepperMode]
  );

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleDeleteTenant = useCallback(
    () => setOpenConfirmDeleteTenant(true),
    []
  );

  const handleTerminateLease = useCallback(
    () => setOpenTerminateLeaseDialog(true),
    []
  );

  const handleRentHistory = useCallback(() => {
    setSelectedRentHistory(selected);
    setOpenRentHistoryDialog(true);
  }, [selected]);

  const handleEditTenant = useCallback(
    () => setOpenConfirmEditTenant(true),
    []
  );

  return (
    <Page
      loading={tenantLoading}
      ActionBar={
        <div className="grid grid-cols-5 gap-1.5 md:gap-4">
          <ShortcutButton
            label={t('Back')}
            Icon={LuArrowLeft}
            onClick={handleBack}
          />
          <ShortcutButton
            label={t('Delete')}
            Icon={LuTrash}
            disabled={selected.hasPayments}
            onClick={handleDeleteTenant}
            dataCy="removeResourceButton"
          />
          {showTerminateLeaseButton ? (
            <ShortcutButton
              label={t('Terminate')}
              Icon={LuStopCircle}
              onClick={handleTerminateLease}
            />
          ) : null}
          {showEditButton ? (
            <ShortcutButton
              label={t('Edit')}
              Icon={LuPencil}
              onClick={handleEditTenant}
            />
          ) : null}
          {showEditButton ? (
            <ShortcutButton
              Icon={LuHistory}
              label={t('Schedule')}
              onClick={handleRentHistory}
            />
          ) : null}
        </div>
      }
      dataCy="tenantPage"
    >
      <PresenceBanner viewers={viewers} />
      {selected.stepperMode ? (
        <Card>
          <TenantStepper tenant={selected} leases={leases} properties={properties} organization={store.organization.selected} onSubmit={onSubmit} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <TenantTabs tenant={selected} leases={leases} properties={properties} organization={store.organization.selected} onSubmit={onSubmit} readOnly={readOnly} />
            </div>
            {!!selected.properties && (
              <div className="hidden md:grid grid-cols-1 gap-4 h-fit">
                <ContractOverviewCard tenant={selected} />
                <RentOverviewCard tenant={selected} />
              </div>
            )}
          </div>
          <TerminateLeaseDialog
            open={openTerminateLeaseDialog}
            setOpen={setOpenTerminateLeaseDialog}
            tenant={selected}
          />
          <ConfirmDialog
            title={
              selected.terminated
                ? t('Lease terminated on {{terminationDate}}', {
                    terminationDate: moment(
                      selected.terminationDate,
                      'DD/MM/YYYY'
                    ).format('LL')
                  })
                : t('Lease running')
            }
            subTitle={t(
              'Modifying this form might break the contract signed with the tenant'
            )}
            subTitle2={t('Continue editing?')}
            open={openConfirmEditTenant}
            setOpen={setOpenConfirmEditTenant}
            onConfirm={onEditTenant}
          />
        </>
      )}
      <RentHistoryDialog
        open={openRentHistoryDialog}
        setOpen={setOpenRentHistoryDialog}
        data={selectedRentHistory}
      />
      <ConfirmDialog
        title={
          selected.hasPayments
            ? t('This tenant cannot be deleted')
            : t('Deletion of the tenant?')
        }
        subTitle={
          selected.hasPayments
            ? t(
                'Deleting {{tenant}} is not allowed because some rent settlements have been recorded',
                { tenant: selected.name }
              )
            : t('Do you confirm the permanent deletion of {{tenant}}?', {
                tenant: selected.name
              })
        }
        open={openConfirmDeleteTenant}
        setOpen={setOpenConfirmDeleteTenant}
        justOkButton={selected.hasPayments}
        onConfirm={!selected.hasPayments ? onDeleteTenant : null}
      />
    </Page>
  );
}

export default withAuthentication(Tenant);
