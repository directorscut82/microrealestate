import { LuArrowLeft, LuBuilding2, LuHistory, LuHome, LuKeyRound, LuTrash } from 'react-icons/lu';
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
import ErrorPage from 'next/error';
import { DashboardCard } from '../../../components/dashboard/DashboardCard';
import Map from '../../../components/Map';
import moment from 'moment';
import NumberFormat from '../../../components/NumberFormat';
import Page from '../../../components/Page';
import PresenceBanner from '../../../components/PresenceBanner';
import usePresence from '../../../hooks/usePresence';
import PropertyExpensesCard from '../../../components/properties/PropertyExpensesCard';
import PropertyForm from '../../../components/properties/PropertyForm';
import { Button } from '../../../components/ui/button';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

function PropertyOverviewCard({ property }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  return (
    <DashboardCard
      Icon={LuKeyRound}
      title={t('Property')}
      renderContent={() => (
        <div className="text-base space-y-2">
          {/* The property name is already the page H1 and the editable 'Όνομα'
              field, so this card leads with its only net-new figure: the
              price. (Dropped the third repeat of the name.) */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('Rent')}</span>
            <NumberFormat value={property?.price} />
          </div>
          {/* Owner-occupied (Ιδιοκατοίκηση) is a per-unit occupancy state that
              lives on Building.units[], not on the Property. The single-property
              GET surfaces it as property.status ('owner_occupied'); render it
              here so the detail page matches the property list card and the
              building overview instead of implying the unit is simply vacant. */}
          {property?.status === 'owner_occupied' && (
            <div className="flex items-center gap-2 text-sm text-ink">
              <LuHome className="size-3.5 shrink-0" />
              <span>{t('Owner occupied')}</span>
            </div>
          )}
          {property?.buildingId && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer hover:text-ink transition-colors"
              onClick={() =>
                router.push(
                  `/${router.query.organization}/buildings/${property.buildingId}`
                )
              }
            >
              <LuBuilding2 className="size-3.5 shrink-0" />
              <span className="truncate underline underline-offset-2 decoration-dotted">
                {property.buildingName || t('Building')}
              </span>
            </div>
          )}
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
        ) : property?.status === 'owner_occupied' ? (
          // An owner-occupied unit has no tenant history, but it is NOT
          // "never rented" — the owner lives there. Show that instead of the
          // vacant-unit fallback so the two states are distinguishable.
          <div className="flex items-center gap-2 text-base text-ink">
            <LuHome className="size-4 shrink-0" />
            <span>{t('Occupied by the owner')}</span>
          </div>
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
  const viewers = usePresence('property', propertyId);

  const { data: property, isLoading } = useQuery({
    queryKey: [QueryKeys.PROPERTIES, propertyId],
    queryFn: () => fetchProperty(propertyId),
    enabled: !!propertyId && propertyId !== 'new'
  });

  // The /new route never fetches — only return 404 once a fetch completed
  // for an existing id and produced nothing.
  const notFound =
    propertyId && propertyId !== 'new' && !isLoading && !property;

  // Property create/update/delete affects building unit lists, tenant
  // assignments, dashboard counters and rent computation (price changes
  // propagate into open rent terms). Invalidate the full stack.
  const _invalidateAllPropertyDependents = () => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.PROPERTIES] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
  };

  const saveMutation = useMutation({
    mutationFn: (data) =>
      data._id ? updateProperty(data) : createProperty(data),
    onSuccess: _invalidateAllPropertyDependents
  });

  const removeMutation = useMutation({
    mutationFn: (ids) => deleteProperty(ids),
    onSuccess: _invalidateAllPropertyDependents
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
        // The server names the field it rejected ("address.zipCode must be 5 digits",
        // "atakNumber must be 11 digits", "price must be <= 10000000"). Hardcoding
        // «Λείπει το όνομα του ακινήτου» told the landlord the NAME was missing while
        // the name was filled and the real cause was the postcode, surface or price.
        const apiMessage =
          error?.response?.data?.message || error?.response?.data?.error;
        switch (status) {
          case 422:
            return toast.error(apiMessage || t('Property name is missing'));
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

  if (notFound) {
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
            onClick={() => setOpenConfirmDeletePropertyDialog(true)}
            data-cy="removeResourceButton"
            className="gap-2"
          >
            <LuTrash className="size-4" />
            {t('Delete')}
          </Button>
        </div>
      }
      dataCy="propertyPage"
    >
      <PresenceBanner viewers={viewers} />
      {/* Display-serif page title (the "where am I?" anchor). Replaces the
          single-tab dead-chrome wrapper. */}
      {property?.name && (
        <h1 className="font-display text-display text-ink mb-4">
          {property.name}
        </h1>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <Card className="p-6">
            <PropertyForm property={property} onSubmit={onSubmit} />
          </Card>
        </div>
        <div className="hidden md:grid grid-cols-1 gap-4 h-fit">
          <PropertyOverviewCard property={property} />
          <OccupancyHistoryCard property={property} />
          <PropertyExpensesCard propertyId={propertyId} />
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
