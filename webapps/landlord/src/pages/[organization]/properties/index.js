import { fetchPropertiesPage, QueryKeys } from '../../../utils/restcalls';
import { useCallback, useContext, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { List } from '../../../components/ResourceList';
import { LuPlusCircle } from 'react-icons/lu';
import NewPropertyDialog from '../../../components/properties/NewPropertyDialog';
import Page from '../../../components/Page';
import PropertyList from '../../../components/properties/PropertyList';
import { StoreContext } from '../../../store';
import { toast } from 'sonner';
import types from '../../../components/properties/types';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

const PAGE_LIMIT = 100;

function _filterData(data = [], filters) {
  let filteredItems = data;
  if (filters.statuses?.length) {
    const typeFilters = filters.statuses.filter(
      (status) => !['vacant', 'occupied'].includes(status)
    );
    if (typeFilters.length) {
      filteredItems = filteredItems.filter(({ type }) =>
        typeFilters.includes(type)
      );
    }

    const statusFilters = filters.statuses.filter((status) =>
      ['vacant', 'occupied'].includes(status)
    );
    if (statusFilters.length) {
      filteredItems = filteredItems.filter(({ status }) =>
        statusFilters.includes(status)
      );
    }
  }

  if (filters.searchText) {
    const regExp = /\s|\.|-/gi;
    const cleanedSearchText = filters.searchText
      .toLowerCase()
      .replace(regExp, '');

    // Wave-24 B2: extend the search beyond `name` to atakNumber, address
    // street/city, and surface — these are the fields landlords actually
    // type when looking for a property.
    const matchField = (val) =>
      String(val ?? '')
        .replace(regExp, '')
        .toLowerCase()
        .indexOf(cleanedSearchText) != -1;
    filteredItems = filteredItems.filter(
      ({ name, atakNumber, address, surface }) =>
        matchField(name) ||
        matchField(atakNumber) ||
        matchField(address?.street1) ||
        matchField(address?.city) ||
        matchField(surface)
    );
  }

  // Tier F2: sort by (buildingId, atakNumber) so a building's units stay
  // adjacent in the data array. Without this, the upstream paginator
  // (ResourceList List._computeChunks, page size 21) splits a building
  // across pages — page 2 then sees a SOLO unit with that buildingId,
  // which PropertyList still groups by buildingId but renders as a
  // single-row 'group' OR (when the group renders empty) puts the lone
  // property into ΛΟΙΠΑ. Sorting keeps each building contiguous and
  // makes pagination boundaries fall between buildings most of the time.
  // Properties without buildingId are pushed to the end so they always
  // land in the ΛΟΙΠΑ section on the last page.
  filteredItems = [...filteredItems].sort((a, b) => {
    const ab = a.buildingId ? String(a.buildingId) : '￿';
    const bb = b.buildingId ? String(b.buildingId) : '￿';
    if (ab !== bb) return ab < bb ? -1 : 1;
    const aa = String(a.atakNumber || a.name || '');
    const ba = String(b.atakNumber || b.name || '');
    return aa < ba ? -1 : aa > ba ? 1 : 0;
  });
  return filteredItems;
}

function Properties() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();

  const {
    data,
    isError,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useInfiniteQuery({
    queryKey: [QueryKeys.PROPERTIES, 'list'],
    queryFn: ({ pageParam = 1 }) =>
      fetchPropertiesPage({ page: pageParam, limit: PAGE_LIMIT }),
    getNextPageParam: (lastPage) => {
      const nextPage = lastPage.page + 1;
      const totalPages = Math.ceil(lastPage.total / lastPage.limit);
      return nextPage <= totalPages ? nextPage : undefined;
    },
    initialPageParam: 1
  });

  const allProperties = data?.pages?.flatMap((page) => page.items) ?? [];

  const [openNewPropertyDialog, setOpenNewPropertyDialog] = useState(false);

  const handleAction = useCallback(() => {
    setOpenNewPropertyDialog(true);
  }, [setOpenNewPropertyDialog]);

  if (isError) {
    toast.error(t('Error fetching properties'));
  }

  return (
    <Page title={t('Properties')} loading={isLoading} dataCy="propertiesPage">
      <List
        data={allProperties}
        filters={[
          { id: 'vacant', label: t('Vacant') },
          { id: 'occupied', label: t('Rented') },
          ...types.map(({ id, labelId }) => ({
            id,
            label: t(labelId)
          }))
        ]}
        actions={[{ id: 'addProperty', label: t('Add a property') }]}
        filterFn={_filterData}
        onLoadMore={hasNextPage ? fetchNextPage : undefined}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        renderActions={() => (
          <div className="flex justify-end">
            <Button onClick={handleAction} size="sm" className="gap-2">
              <LuPlusCircle className="size-4" />
              {t('Add a property')}
            </Button>
          </div>
        )}
        renderList={PropertyList}
      />
      <NewPropertyDialog
        open={openNewPropertyDialog}
        setOpen={setOpenNewPropertyDialog}
      />
    </Page>
  );
}

export default withAuthentication(Properties);
