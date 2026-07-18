import {
  fetchOwners,
  QueryKeys,
  sendOwnerSms,
  sendOwnerStatements
} from '../../../utils/restcalls';
import { LuMessageSquare, LuSend } from 'react-icons/lu';
import { useCallback, useContext, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { List } from '../../../components/ResourceList';
import moment from 'moment';
import OwnerList from '../../../components/owners/OwnerList';
import Page from '../../../components/Page';
import { StoreContext } from '../../../store';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

// Client-side filter: chips (outstanding / settled) via the derived `status`
// field, plus free-text search over name + taxId.
function _filterData(data = [], filters) {
  let items = data;
  if (filters.statuses?.length) {
    items = items.filter(({ status }) => filters.statuses.includes(status));
  }
  if (filters.searchText) {
    const norm = (s) =>
      String(s || '')
        .replace(/\s|\.|-/gi, '')
        .toLowerCase()
        .replace(/ς/g, 'σ');
    const q = norm(filters.searchText);
    items = items.filter(
      (o) => norm(o.name).indexOf(q) !== -1 || norm(o.taxId).indexOf(q) !== -1
    );
  }
  return items;
}

function Owners() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState([]);
  const [openConfirmEmail, setOpenConfirmEmail] = useState(false);

  const { data, isError, isLoading } = useQuery({
    queryKey: [QueryKeys.OWNERS],
    queryFn: fetchOwners
  });

  // Attach a derived status for the filter chips.
  const owners = useMemo(
    () =>
      (data || []).map((o) => ({
        ...o,
        status:
          Number(o.totalOutstanding) > 0.005 ? 'outstanding' : 'settled'
      })),
    [data]
  );

  // Current month term (YYYYMMDDHH) — the statement the sends attach/refer to.
  const term = useMemo(() => moment().startOf('month').format('YYYYMMDDHH'), []);
  const selectedOwners = useMemo(
    () => owners.filter((o) => selected.includes(o.ownerKey)),
    [owners, selected]
  );
  const emailable = selectedOwners.filter((o) => o.hasEmail);
  const smsable = selectedOwners.filter((o) => o.hasPhone);

  const emailMutation = useMutation({
    mutationFn: sendOwnerStatements,
    onSuccess: (statusList) => {
      const failed = (statusList || []).filter((s) => s.error);
      if (failed.length) {
        toast.error(
          t('{{count}} owner statements could not be sent', {
            count: failed.length
          })
        );
      } else {
        toast.success(t('Owner statements sent'));
      }
      setSelected([]);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
    },
    onError: () => toast.error(t('Something went wrong'))
  });

  const smsMutation = useMutation({
    mutationFn: sendOwnerSms,
    onSuccess: (statusList) => {
      const failed = (statusList || []).filter((s) => s.error);
      if (failed.length) {
        toast.error(
          t('{{count}} SMS could not be sent', { count: failed.length })
        );
      } else {
        toast.success(t('SMS sent'));
      }
      setSelected([]);
    },
    onError: () => toast.error(t('Something went wrong'))
  });

  const handleSendEmails = useCallback(() => {
    emailMutation.mutate({
      ownerKeys: emailable.map((o) => o.ownerKey),
      term
    });
  }, [emailMutation, emailable, term]);

  const handleSendSms = useCallback(() => {
    smsMutation.mutate({
      ownerKeys: smsable.map((o) => o.ownerKey),
      term
    });
  }, [smsMutation, smsable, term]);

  if (isError) {
    toast.error(t('Error fetching owners'));
  }

  const canSendEmails = store.organization?.canSendEmails;
  const canSendSms = store.organization?.canSendSms;

  return (
    <Page loading={isLoading} dataCy="ownersPage">
      <ConfirmDialog
        title={t('Send the owner expense statement by email to')}
        open={openConfirmEmail}
        setOpen={setOpenConfirmEmail}
        data={emailable.map((o) => o.name).join(', ')}
        onConfirm={handleSendEmails}
      >
        <div className="text-sm">
          {emailable.map((o) => o.name).join(', ')}
        </div>
      </ConfirmDialog>
      <List
        data={owners}
        title={t('Owners')}
        filters={[
          { id: 'outstanding', label: t('Has outstanding') },
          { id: 'settled', label: t('Settled') }
        ]}
        filterFn={_filterData}
        renderActions={() =>
          canSendEmails || canSendSms ? (
            <div className="flex flex-col md:flex-row gap-2">
              {canSendEmails ? (
                <Button
                  variant="secondary"
                  disabled={!emailable.length || emailMutation.isLoading}
                  onClick={() => setOpenConfirmEmail(true)}
                >
                  <LuSend className="mr-1.5 size-4" />
                  {t('Send statement by email')}
                  {emailable.length ? ` (${emailable.length})` : ''}
                </Button>
              ) : null}
              {canSendSms ? (
                <Button
                  variant="secondary"
                  disabled={!smsable.length || smsMutation.isLoading}
                  onClick={handleSendSms}
                >
                  <LuMessageSquare className="mr-1.5 size-4" />
                  {t('Send SMS')}
                  {smsable.length ? ` (${smsable.length})` : ''}
                </Button>
              ) : null}
            </div>
          ) : null
        }
        renderList={({ data }) => (
          <OwnerList data-cy="ownerList" owners={data} selected={selected} setSelected={setSelected} />
        )}
      />
    </Page>
  );
}

export default withAuthentication(Owners);
