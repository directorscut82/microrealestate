import { LuArrowLeft, LuTrash } from 'react-icons/lu';
import { useCallback, useContext, useState } from 'react';
import {
  createLease,
  deleteLease,
  fetchLease,
  fetchLeases,
  QueryKeys,
  updateLease
} from '../../../../utils/restcalls';
import { ADMIN_ROLE } from '../../../../store/User';
import { Card } from '../../../../components/ui/card';
import ConfirmDialog from '../../../../components/ConfirmDialog';
import LeaseStepper from '../../../../components/organization/lease/LeaseStepper';
import LeaseTabs from '../../../../components/organization/lease/LeaseTabs';
import Page from '../../../../components/Page';
import PresenceBanner from '../../../../components/PresenceBanner';
import usePresence from '../../../../hooks/usePresence';
import { Button } from '../../../../components/ui/button';
import { StoreContext } from '../../../../store';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../../components/Authentication';

function Contract() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [openRemoveContractDialog, setOpenRemoveContractDialog] =
    useState(false);

  const leaseId = router.query.id;
  const viewers = usePresence('contract', leaseId);

  const { data: lease, isLoading: leaseLoading } = useQuery({
    queryKey: [QueryKeys.LEASES, leaseId],
    queryFn: () => fetchLease(leaseId),
    enabled: !!leaseId
  });

  const { data: leases = [] } = useQuery({
    queryKey: [QueryKeys.LEASES],
    queryFn: fetchLeases
  });

  // Leases drive rent computation (term count, time range, fees). Editing
  // a lease can re-price all linked tenants, so invalidate RENTS + TENANTS
  // alongside the LEASES cache per the lease-mutation rule.
  const _invalidateAllLeaseDependents = () => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.LEASES] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
  };

  const saveMutation = useMutation({
    mutationFn: (data) =>
      data._id ? updateLease(data) : createLease(data),
    onSuccess: _invalidateAllLeaseDependents
  });

  const removeMutation = useMutation({
    mutationFn: (ids) => deleteLease(ids),
    onSuccess: _invalidateAllLeaseDependents
  });

  const onLeaseAddUpdate = useCallback(
    async (leasePart) => {
      const data = { ...lease, ...leasePart };
      try {
        await saveMutation.mutateAsync(data);
      } catch (error) {
        const status = error?.response?.status;
        switch (status) {
          case 422:
            return toast.error(t('Some fields are missing'));
          case 403:
            return toast.error(t('You are not allowed to update the contract'));
          case 404:
            return toast.error(t('Contract is not found'));
          case 409:
            return toast.error(t('The contract already exists'));
          default:
            return toast.error(t('Something went wrong'));
        }
      }
    },
    [lease, saveMutation, t]
  );

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const onLeaseRemove = useCallback(async () => {
    try {
      await removeMutation.mutateAsync([lease._id]);
      router.push(`/${router.query.organization}/settings/contracts`);
    } catch (error) {
      const status = error?.response?.status;
      switch (status) {
        case 422:
          return toast.error(
            t('Contract is used by tenants, it cannot be removed')
          );
        case 403:
          return toast.error(t('You are not allowed to update the contract'));
        default:
          return toast.error(t('Something went wrong'));
      }
    }
  }, [lease, removeMutation, router, t]);

  return (
    <Page
      loading={leaseLoading}
      ActionBar={
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={handleBack} className="gap-2">
            <LuArrowLeft className="size-4" />
            {t('Back')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setOpenRemoveContractDialog(true)}
            disabled={lease?.usedByTenants || store.user.role !== ADMIN_ROLE}
            data-cy="removeResourceButton"
            className="gap-2"
          >
            <LuTrash className="size-4" />
            {t('Delete')}
          </Button>
        </div>
      }
      dataCy="contractPage"
    >
      <PresenceBanner viewers={viewers} />
      {lease?.stepperMode ? (
        <Card>
          <LeaseStepper
            lease={lease}
            leases={leases}
            onSubmit={onLeaseAddUpdate}
          />
        </Card>
      ) : (
        <LeaseTabs
          lease={lease}
          leases={leases}
          onSubmit={onLeaseAddUpdate}
        />
      )}
      <ConfirmDialog
        title={t('Are you sure to remove this contract?')}
        subTitle={lease?.name}
        open={openRemoveContractDialog}
        setOpen={setOpenRemoveContractDialog}
        onConfirm={onLeaseRemove}
      />
    </Page>
  );
}

export default withAuthentication(Contract, ADMIN_ROLE);
