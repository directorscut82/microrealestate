import {
  deleteBuilding,
  fetchBuilding,
  QueryKeys,
  updateBuilding
} from '../../../utils/restcalls';
import { LuArrowLeft, LuTrash } from 'react-icons/lu';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from '../../../components/ui/tabs';
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import BuildingForm from '../../../components/buildings/BuildingForm';
import BuildingDashboard from '../../../components/buildings/BuildingDashboard';
import { Card } from '../../../components/ui/card';
import ConfirmDialog from '../../../components/ConfirmDialog';
import ContractorList from '../../../components/buildings/ContractorList';
import ExpenseList from '../../../components/buildings/ExpenseList';
import Page from '../../../components/Page';
import PresenceBanner from '../../../components/PresenceBanner';
import RepairList from '../../../components/buildings/RepairList';
import ShortcutButton from '../../../components/ShortcutButton';
import { toast } from 'sonner';
import UnitList from '../../../components/buildings/UnitList';
import usePresence from '../../../hooks/usePresence';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

function Building() {
  const { t } = useTranslation('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [openConfirmDeleteBuilding, setOpenConfirmDeleteBuilding] =
    useState(false);

  const buildingId = router.query.id;
  const viewers = usePresence('building', buildingId);

  const { data: building, isLoading } = useQuery({
    queryKey: [QueryKeys.BUILDINGS, buildingId],
    queryFn: () => fetchBuilding(buildingId),
    enabled: !!buildingId
  });

  const saveMutation = useMutation({
    mutationFn: (data) => updateBuilding(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      toast.success(t('Building updated'));
    }
  });

  const removeMutation = useMutation({
    mutationFn: (ids) => deleteBuilding(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    }
  });

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const onDeleteBuilding = useCallback(async () => {
    try {
      await removeMutation.mutateAsync([building._id]);
      router.back();
    } catch (error) {
      const status = error?.response?.status;
      switch (status) {
        case 422:
          return toast.error(
            t('Building cannot be deleted because units have active tenants')
          );
        case 404:
          return toast.error(t('Building does not exist'));
        case 403:
          return toast.error(t('You are not allowed to delete the building'));
        default:
          return toast.error(t('Something went wrong'));
      }
    }
  }, [building, removeMutation, router, t]);

  const onSubmit = useCallback(
    async (buildingPart) => {
      if (!building) return;
      const data = {
        ...building,
        ...buildingPart
      };
      try {
        await saveMutation.mutateAsync(data);
      } catch (error) {
        const status = error?.response?.status;
        switch (status) {
          case 422:
            return toast.error(t('Building name is missing'));
          case 403:
            return toast.error(t('You are not allowed to update the building'));
          case 409:
            return toast.error(t('The building already exists'));
          default:
            return toast.error(t('Something went wrong'));
        }
      }
    },
    [building, saveMutation, t]
  );

  return (
    <Page
      loading={isLoading}
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
            onClick={() => setOpenConfirmDeleteBuilding(true)}
            className="col-start-2 col-end-2"
            dataCy="removeResourceButton"
          />
        </div>
      }
      dataCy="buildingPage"
    >
      <PresenceBanner viewers={viewers} />
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="flex justify-start overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="overview" className="w-1/5" data-cy="overviewTab">
            {t('Overview')}
          </TabsTrigger>
          <TabsTrigger value="units" className="w-1/5" data-cy="unitsTab">
            {t('Units')}
          </TabsTrigger>
          <TabsTrigger value="expenses" className="w-1/5" data-cy="expensesTab">
            {t('Expenses')}
          </TabsTrigger>
          <TabsTrigger value="repairs" className="w-1/5" data-cy="repairsTab">
            {t('Repairs & Contractors')}
          </TabsTrigger>
          <TabsTrigger value="settings" className="w-1/5" data-cy="settingsTab">
            {t('Settings')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card className="p-6">
            <BuildingDashboard building={building} />
          </Card>
        </TabsContent>
        <TabsContent value="units">
          <Card className="p-6">
            <UnitList building={building} />
          </Card>
        </TabsContent>
        <TabsContent value="expenses">
          <Card className="p-6">
            <ExpenseList building={building} />
          </Card>
        </TabsContent>
        <TabsContent value="repairs">
          <Card className="p-6">
            <div className="space-y-8">
              <div>
                <h3 className="text-lg font-semibold mb-4">{t('Repairs')}</h3>
                <RepairList building={building} />
              </div>
              <div>
                <h3 className="text-lg font-semibold mb-4">
                  {t('Contractors')}
                </h3>
                <ContractorList building={building} />
              </div>
            </div>
          </Card>
        </TabsContent>
        <TabsContent value="settings">
          <Card className="p-6">
            <BuildingForm building={building} onSubmit={onSubmit} />
          </Card>
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        title={t('Are you sure to definitely remove this building?')}
        subTitle={building?.name}
        open={openConfirmDeleteBuilding}
        setOpen={setOpenConfirmDeleteBuilding}
        onConfirm={onDeleteBuilding}
      />
    </Page>
  );
}

export default withAuthentication(Building);
