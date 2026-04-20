import { archiveTenant, fetchTenants, QueryKeys, unarchiveTenant } from '../../../utils/restcalls';
import React, { useCallback, useContext, useState } from 'react';
import { Button } from '../../../components/ui/button';
import ImportTenantDialog from '../../../components/tenants/ImportTenantDialog';
import { List } from '../../../components/ResourceList';
import { LuArchive, LuFileUp, LuPlusCircle } from 'react-icons/lu';
import NewTenantDialog from '../../../components/tenants/NewTenantDialog';
import Page from '../../../components/Page';
import { StoreContext } from '../../../store';
import { Switch } from '../../../components/ui/switch';
import { Label } from '../../../components/ui/label';
import TenantList from '../../../components/tenants/TenantList';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

function _filterData(data, filters) {
  let filteredItems =
    filters.statuses?.length === 0
      ? data
      : data.filter(({ status }) => filters.statuses.includes(status));

  if (filters.searchText) {
    const regExp = /\s|\.|-/gi;
    const cleanedSearchText = filters.searchText
      .toLowerCase()
      .replace(regExp, '');

    filteredItems = filteredItems.filter(
      ({ isCompany, name, manager, contacts, properties }) => {
        // Search match name
        let found =
          name.replace(regExp, '').toLowerCase().indexOf(cleanedSearchText) !=
          -1;

        // Search match manager
        if (!found && isCompany) {
          found =
            manager
              ?.replace(regExp, '')
              .toLowerCase()
              .indexOf(cleanedSearchText) != -1;
        }

        // Search match contact
        if (!found) {
          found = !!contacts
            ?.map(({ contact = '', email = '', phone = '' }) => ({
              contact: contact.replace(regExp, '').toLowerCase(),
              email: email.toLowerCase(),
              phone: phone.replace(regExp, '')
            }))
            .filter(
              ({ contact, email, phone }) =>
                contact.indexOf(cleanedSearchText) != -1 ||
                email.indexOf(cleanedSearchText) != -1 ||
                phone.indexOf(cleanedSearchText) != -1
            ).length;
        }

        // Search match property name
        if (!found) {
          found = !!properties?.filter(
            ({ property: { name } }) =>
              name
                .replace(regExp, '')
                .toLowerCase()
                .indexOf(cleanedSearchText) != -1
          ).length;
        }
        return found;
      }
    );
  }
  return filteredItems;
}

function Tenants() {
  const { t } = useTranslation('common');
  const router = useRouter();
  const store = useContext(StoreContext);
  const [openNewTenantDialog, setOpenNewTenantDialog] = useState(false);
  const [openImportDialog, setOpenImportDialog] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { isError, data, isLoading } = useQuery({
    queryKey: [QueryKeys.TENANTS, showArchived],
    queryFn: () => fetchTenants(showArchived)
  });

  const onNewTenant = useCallback(() => {
    setOpenNewTenantDialog(true);
  }, [setOpenNewTenantDialog]);

  const onImportTenant = useCallback(() => {
    setOpenImportDialog(true);
  }, [setOpenImportDialog]);

  if (isError) {
    toast.error(t('Error fetching tenants'));
  }

  return (
    <Page loading={isLoading} dataCy="tenantsPage">
      <List
        data={data}
        filters={[
          { id: 'inprogress', label: t('Lease running') },
          { id: 'stopped', label: t('Lease ended') }
        ]}
        filterFn={_filterData}
        renderActions={() => (
          <div className="flex flex-col gap-2 w-full">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1 gap-2"
                onClick={onNewTenant}
              >
                <LuPlusCircle className="size-4" />
                {t('Add a tenant')}
              </Button>
              <Button
                variant="secondary"
                className="flex-1 gap-2"
                onClick={onImportTenant}
              >
                <LuFileUp className="size-4" />
                {t('Import PDF')}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="showArchived"
                checked={showArchived}
                onCheckedChange={setShowArchived}
                data-cy="showArchivedToggle"
              />
              <Label htmlFor="showArchived" className="text-sm text-muted-foreground">
                <LuArchive className="inline size-3 mr-1" />
                {t('Show archived')}
              </Label>
            </div>
          </div>
        )}
        renderList={({ data }) => <TenantList tenants={data} />}
      />
      <NewTenantDialog
        open={openNewTenantDialog}
        setOpen={setOpenNewTenantDialog}
      />
      <ImportTenantDialog
        open={openImportDialog}
        setOpen={setOpenImportDialog}
      />
    </Page>
  );
}

export default withAuthentication(Tenants);
