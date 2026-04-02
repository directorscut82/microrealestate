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
import ShortcutButton from '../../../../components/ShortcutButton';
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

  const saveMutation = useMutation({
    mutationFn: (data) =>
      data._id ? updateLease(data) : createLease(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LEASES] });
    }
  });

  const removeMutation = useMutation({
    mutationFn: (ids) => deleteLease(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LEASES] });
    }
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
        <div className="grid grid-cols-5 gap-1.5 md:gap-4">
          <ShortcutButton
            label={t('Back')}
            Icon={LuArrowLeft}
            onClick={handleBack}
          />
          <ShortcutButton
            label={t('Delete')}
            Icon={LuTrash}
            onClick={() => setOpenRemoveContractDialog(true)}
            disabled={
              lease?.usedByTenants || store.user.role !== ADMIN_ROLE
            }
            className="col-start-2 col-end-2"
            dataCy="removeResourceButton"
          />
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
