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
    const regExp = /\s|\.-/gi;
    const cleaned = filters.searchText.toLowerCase().replace(regExp, '');
    filteredItems = filteredItems.filter(
      (b) =>
        b.name?.replace(regExp, '').toLowerCase().indexOf(cleaned) !== -1 ||
        b.description?.replace(regExp, '').toLowerCase().indexOf(cleaned) !==
          -1 ||
        b.address?.street1
          ?.replace(regExp, '')
          .toLowerCase()
          .indexOf(cleaned) !== -1 ||
        b.address?.city?.replace(regExp, '').toLowerCase().indexOf(cleaned) !==
          -1
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
