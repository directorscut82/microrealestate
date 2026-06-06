import { fetchBuildings, QueryKeys } from '../../../utils/restcalls';
import { LuFileUp, LuPlusCircle } from 'react-icons/lu';
import { useCallback, useState } from 'react';
import BuildingList from '../../../components/buildings/BuildingList';
import { Button } from '../../../components/ui/button';
import ImportE9Dialog from '../../../components/buildings/ImportE9Dialog';
import { List } from '../../../components/ResourceList';
import NewBuildingDialog from '../../../components/buildings/NewBuildingDialog';
import Page from '../../../components/Page';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

function _filterData(data = [], filters) {
  let filteredItems = data;

  if (filters.statuses?.length) {
    if (filters.statuses.includes('hasElevator')) {
      filteredItems = filteredItems.filter((b) => b.hasElevator);
    }
    if (filters.statuses.includes('hasCentralHeating')) {
      filteredItems = filteredItems.filter((b) => b.hasCentralHeating);
    }
  }

  if (filters.searchText) {
    // Wave-24 B3: the previous `\s|\.-` regex matched a literal "." followed
    // by "-" rather than the intended "any of space, dot, or hyphen".
    // Fix to a true character class.
    //
    // L1 (June 2026): the predicate was using `field?.replace(...)...indexOf(cleaned) !== -1`,
    // which short-circuits to `undefined` when the field is missing — and
    // `undefined !== -1` evaluates to `true`, so any building lacking a
    // description/street1/city matched every query. Coerce to '' first so
    // the chain resolves to a real number.
    const regExp = /\s|\.|-/gi;
    const cleaned = filters.searchText.toLowerCase().replace(regExp, '');
    const matchField = (val) =>
      String(val ?? '')
        .replace(regExp, '')
        .toLowerCase()
        .indexOf(cleaned) !== -1;
    filteredItems = filteredItems.filter(
      (b) =>
        matchField(b.name) ||
        matchField(b.description) ||
        matchField(b.address?.street1) ||
        matchField(b.address?.city)
    );
  }

  return filteredItems;
}

function Buildings() {
  const { t } = useTranslation('common');
  const { data, isError, isLoading } = useQuery({
    queryKey: [QueryKeys.BUILDINGS],
    queryFn: () => fetchBuildings()
  });

  const [openNewBuildingDialog, setOpenNewBuildingDialog] = useState(false);
  const [openImportE9Dialog, setOpenImportE9Dialog] = useState(false);

  if (isError) {
    toast.error(t('Error fetching buildings'));
  }

  return (
    <Page title={t('Buildings')} loading={isLoading} dataCy="buildingsPage">
      <List
        data={data}
        filters={[
          { id: 'hasElevator', label: t('Has elevator') },
          { id: 'hasCentralHeating', label: t('Has heating') }
        ]}
        filterFn={_filterData}
        renderActions={() => (
          <div className="flex flex-col gap-2 w-full">
            <Button
              variant="secondary"
              className="w-full gap-2"
              onClick={() => setOpenNewBuildingDialog(true)}
            >
              <LuPlusCircle className="size-4" />
              {t('Add a building')}
            </Button>
            <Button
              variant="secondary"
              className="w-full gap-2"
              onClick={() => setOpenImportE9Dialog(true)}
            >
              <LuFileUp className="size-4" />
              {t('Import from E9')}
            </Button>
          </div>
        )}
        renderList={BuildingList}
      />
      <NewBuildingDialog
        open={openNewBuildingDialog}
        setOpen={setOpenNewBuildingDialog}
      />
      <ImportE9Dialog
        open={openImportE9Dialog}
        setOpen={setOpenImportE9Dialog}
      />
    </Page>
  );
}

export default withAuthentication(Buildings);
