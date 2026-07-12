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
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import BuildingForm from '../../../components/buildings/BuildingForm';
import BuildingDashboard from '../../../components/buildings/BuildingDashboard';
import { Card } from '../../../components/ui/card';
import ConfirmDialog from '../../../components/ConfirmDialog';
import ErrorPage from 'next/error';
import ContractorList from '../../../components/buildings/ContractorList';
import ExpenseList from '../../../components/buildings/ExpenseList';
import BuildingExpensePanel from '../../../components/buildings/BuildingExpensePanel';
import Page from '../../../components/Page';
import PresenceBanner from '../../../components/PresenceBanner';
import RepairList from '../../../components/buildings/RepairList';
import { Button } from '../../../components/ui/button';
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
  // Lets the shared expense-tab button row trigger RepairList's "Add repair"
  // dialog (the repair add-action lives in ExpenseList's row, not RepairList).
  const repairListRef = useRef(null);

  const buildingId = router.query.id;
  const viewers = usePresence('building', buildingId);

  const { data: building, isLoading } = useQuery({
    queryKey: [QueryKeys.BUILDINGS, buildingId],
    queryFn: () => fetchBuilding(buildingId),
    enabled: !!buildingId && buildingId !== 'new'
  });

  const buildingNotFound =
    buildingId && buildingId !== 'new' && !isLoading && !building;

  // Building updates change unit configs, expenses, and ATAK metadata that
  // feed rent computation. Building delete removes downstream entities too.
  // Invalidate RENTS/DASHBOARD/TENANTS alongside the building cache.
  const _invalidateAllBuildingDependents = () => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
  };

  const saveMutation = useMutation({
    mutationFn: (data) => updateBuilding(data),
    onSuccess: () => {
      _invalidateAllBuildingDependents();
      toast.success(t('Building updated'));
    }
  });

  const removeMutation = useMutation({
    mutationFn: (ids) => deleteBuilding(ids),
    onSuccess: _invalidateAllBuildingDependents
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

  if (buildingNotFound) {
    return <ErrorPage statusCode={404} />;
  }

  return (
    <Page
      loading={isLoading}
      ActionBar={
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={handleBack} className="gap-2">
            <LuArrowLeft className="size-4" />
            {t('Back')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setOpenConfirmDeleteBuilding(true)}
            data-cy="removeResourceButton"
            className="gap-2"
          >
            <LuTrash className="size-4" />
            {t('Delete')}
          </Button>
        </div>
      }
      dataCy="buildingPage"
    >
      <PresenceBanner viewers={viewers} />
      {/* Honor ?tab= so other surfaces can deep-link to a specific tab (e.g. the
          «Λοιποί ιδιοκτήτες» owner page linking to this building's Units tab so
          the landlord can name the un-named co-owner). Falls back to overview. */}
      <Tabs
        defaultValue={
          typeof router.query.tab === 'string' &&
          ['overview', 'units', 'expenses', 'contractors', 'settings'].includes(
            router.query.tab
          )
            ? router.query.tab
            : 'overview'
        }
        className="w-full"
      >
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
          <TabsTrigger
            value="contractors"
            className="w-1/5"
            data-cy="contractorsTab"
          >
            {t('Contractors')}
          </TabsTrigger>
          <TabsTrigger value="settings" className="w-1/5" data-cy="settingsTab">
            {t('Information')}
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
            {/* §4: Repairs live in the Expenses tab — they ARE expenses
                (one-time costs distributed to tenants/owners), so the landlord
                manages recurring expenses + repairs in one place. Contractors
                (a directory, not money) stay on their own tab.
                ORDER (user-specified): expense list → Επισκευές → the month
                calendar + ΧΡΕΩΣΕΙΣ breakdown panel. Επισκευές sits BEFORE the
                dates and the right panel.
                The "Add repair" action is hoisted into ExpenseList's top
                button row (all actions in one row) and fires RepairList's
                dialog via the ref. RepairList renders its own heading + table
                only when repairs exist, so an empty building shows no section. */}
            <div className="space-y-8">
              <ExpenseList
                building={building}
                onAddRepair={() => repairListRef.current?.openAdd()}
              />
              <RepairList ref={repairListRef} building={building} />
              {(building?.expenses || []).length > 0 && (
                <BuildingExpensePanel building={building} />
              )}
            </div>
          </Card>
        </TabsContent>
        <TabsContent value="contractors">
          <Card className="p-6">
            <ContractorList building={building} />
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
        subTitle={
          building?.units?.length
            ? t('This will also remove {{count}} units. Occupied units will block deletion.', { count: building.units.length })
            : building?.name
        }
        open={openConfirmDeleteBuilding}
        setOpen={setOpenConfirmDeleteBuilding}
        onConfirm={onDeleteBuilding}
      />
    </Page>
  );
}

export default withAuthentication(Building);
