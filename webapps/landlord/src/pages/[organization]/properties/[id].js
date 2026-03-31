import { LuArrowLeft, LuHistory, LuKeyRound, LuTrash } from 'react-icons/lu';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from '../../../components/ui/tabs';
import { useCallback, useState } from 'react';
import {
  createProperty,
  deleteProperty,
  fetchProperty,
  QueryKeys,
  updateProperty
} from '../../../utils/restcalls';
import { Card } from '../../../components/ui/card';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { DashboardCard } from '../../../components/dashboard/DashboardCard';
import Map from '../../../components/Map';
import moment from 'moment';
import NumberFormat from '../../../components/NumberFormat';
import Page from '../../../components/Page';
import PropertyForm from '../../../components/properties/PropertyForm';
import ShortcutButton from '../../../components/ShortcutButton';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

function PropertyOverviewCard({ property }) {
  const { t } = useTranslation('common');
  return (
    <DashboardCard
      Icon={LuKeyRound}
      title={t('Property')}
      renderContent={() => (
        <div className="text-base space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{property?.name}</span>
            <NumberFormat value={property?.price} />
          </div>
          <Map address={property?.address} />
        </div>
      )}
    />
  );
}

function OccupancyHistoryCard({ property }) {
  const { t } = useTranslation('common');
  return (
    <DashboardCard
      Icon={LuHistory}
      title={t('Previous tenants')}
      renderContent={() =>
        property?.occupancyHistory?.length ? (
          property.occupancyHistory.map((occupant) => {
            const occupationDates = t('{{beginDate}} to {{endDate}}', {
              beginDate: moment(occupant.beginDate, 'DD/MM/YYYY').format('ll'),
              endDate: moment(occupant.endDate, 'DD/MM/YYYY').format('ll')
            });
            return (
              <div key={occupant.id} className="mt-2">
                <div className="text-base">{occupant.name}</div>
                <div className="text-xs text-muted-foreground">
                  {occupationDates}
                </div>
              </div>
            );
          })
        ) : (
          <span className="text-base text-muted-foreground">
            {t('Property not rented so far')}
          </span>
        )
      }
    />
  );
}

function Property() {
  const { t } = useTranslation('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [openConfirmDeletePropertyDialog, setOpenConfirmDeletePropertyDialog] =
    useState(false);

  const propertyId = router.query.id;

  const { data: property, isLoading } = useQuery({
    queryKey: [QueryKeys.PROPERTIES, propertyId],
    queryFn: () => fetchProperty(propertyId),
    enabled: !!propertyId
  });

  const saveMutation = useMutation({
    mutationFn: (data) =>
      data._id ? updateProperty(data) : createProperty(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
    }
  });

  const removeMutation = useMutation({
    mutationFn: (ids) => deleteProperty(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
    }
  });

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const onDeleteProperty = useCallback(async () => {
    try {
      await removeMutation.mutateAsync([property._id]);
      router.back();
    } catch (error) {
      const status = error?.response?.status;
      switch (status) {
        case 422:
          return toast.error(t('Property cannot be deleted'));
        case 404:
          return toast.error(t('Property does not exist'));
        case 403:
          return toast.error(t('You are not allowed to delete the Property'));
        default:
          return toast.error(t('Something went wrong'));
      }
    }
  }, [property, removeMutation, router, t]);

  const onSubmit = useCallback(
    async (propertyPart) => {
      const data = {
        ...property,
        ...propertyPart,
        price: propertyPart.rent
      };
      try {
        const result = await saveMutation.mutateAsync(data);
        if (!data._id) {
          await router.push(
            `/${router.query.organization}/properties/${result._id}`
          );
        }
      } catch (error) {
        const status = error?.response?.status;
        switch (status) {
          case 422:
            return toast.error(t('Property name is missing'));
          case 403:
            return toast.error(
              t('You are not allowed to update the property')
            );
          case 409:
            return toast.error(t('The property already exists'));
          default:
            return toast.error(t('Something went wrong'));
        }
      }
    },
    [property, saveMutation, t, router]
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
            onClick={() => setOpenConfirmDeletePropertyDialog(true)}
            className="col-start-2 col-end-2"
            dataCy="removeResourceButton"
          />
        </div>
      }
      dataCy="propertyPage"
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Tabs defaultValue="property" className="md:col-span-2">
          <TabsList className="flex justify-start overflow-x-auto overflow-y-hidden">
            <TabsTrigger value="property" className="w-1/2">
              {t('Property')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="property">
            <Card className="p-6">
              <PropertyForm property={property} onSubmit={onSubmit} />
            </Card>
          </TabsContent>
        </Tabs>
        <div className="hidden md:grid grid-cols-1 gap-4 h-fit">
          <PropertyOverviewCard property={property} />
          <OccupancyHistoryCard property={property} />
        </div>
      </div>
      <ConfirmDialog
        title={t('Are you sure to definitely remove this property?')}
        subTitle={property?.name}
        open={openConfirmDeletePropertyDialog}
        setOpen={setOpenConfirmDeletePropertyDialog}
        onConfirm={onDeleteProperty}
      />
    </Page>
  );
}

export default withAuthentication(Property);
