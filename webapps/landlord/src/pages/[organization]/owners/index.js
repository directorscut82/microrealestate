import { fetchOwners, QueryKeys } from '../../../utils/restcalls';
import { List } from '../../../components/ResourceList';
import OwnerList from '../../../components/owners/OwnerList';
import Page from '../../../components/Page';
import { toast } from 'sonner';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
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
        .toLowerCase()
        .replace(/\s|\.|-/gi, '');
    const q = norm(filters.searchText);
    items = items.filter(
      (o) => norm(o.name).indexOf(q) !== -1 || norm(o.taxId).indexOf(q) !== -1
    );
  }
  return items;
}

function Owners() {
  const { t } = useTranslation('common');

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

  if (isError) {
    toast.error(t('Error fetching owners'));
  }

  return (
    <Page loading={isLoading} dataCy="ownersPage">
      <List
        data={owners}
        filters={[
          { id: 'outstanding', label: t('Has outstanding') },
          { id: 'settled', label: t('Settled') }
        ]}
        filterFn={_filterData}
        // Header calls renderActions() unconditionally; the Owners list has no
        // create/import action (owners derive from buildings), so render none.
        renderActions={() => null}
        renderList={({ data }) => <OwnerList owners={data} />}
      />
    </Page>
  );
}

export default withAuthentication(Owners);
