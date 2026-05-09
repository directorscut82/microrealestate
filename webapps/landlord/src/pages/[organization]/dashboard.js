import {
  fetchDashboard,
  fetchLeases,
  fetchProperties,
  fetchTenants,
  QueryKeys
} from '../../utils/restcalls';
import GeneralFigures from '../../components/dashboard/GeneralFigures';
import MonthFigures from '../../components/dashboard/MonthFigures';
import Page from '../../components/Page';
import PendingBills from '../../components/dashboard/PendingBills';
import Shortcuts from '../../components/dashboard/Shortcuts';
import { useQuery } from '@tanstack/react-query';
import Welcome from '../../components/Welcome';
import { withAuthentication } from '../../components/Authentication';
import YearFigures from '../../components/dashboard/YearFigures';

function Dashboard() {
  const dashboardQuery = useQuery({
    queryKey: [QueryKeys.DASHBOARD],
    queryFn: fetchDashboard,
    refetchOnMount: 'always',
    retry: 3
  });
  const tenantsQuery = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: fetchTenants,
    refetchOnMount: 'always',
    retry: 3
  });
  const propertiesQuery = useQuery({
    queryKey: [QueryKeys.PROPERTIES],
    queryFn: fetchProperties,
    refetchOnMount: 'always',
    retry: 3
  });
  const leasesQuery = useQuery({
    queryKey: [QueryKeys.LEASES],
    queryFn: fetchLeases,
    refetchOnMount: 'always',
    retry: 3
  });
  const isLoading =
    dashboardQuery.isLoading ||
    tenantsQuery.isLoading ||
    propertiesQuery.isLoading ||
    leasesQuery.isLoading;
  const isFirstConnection =
    !leasesQuery?.data?.length ||
    !dashboardQuery?.data?.overview?.propertyCount ||
    !tenantsQuery?.data?.length ||
    !propertiesQuery?.data?.length;

  const dashboardData = dashboardQuery.data || {};
  const tenants = tenantsQuery.data || [];
  const leases = leasesQuery.data || [];

  return (
    <Page loading={isLoading} dataCy="dashboardPage">
      <div className="flex flex-col gap-4">
        <Welcome className="mb-6" />
        {isFirstConnection ? (
          <Shortcuts
            firstConnection
            className="w-full"
            dashboardData={dashboardData}
            tenants={tenants}
            leases={leases}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <Shortcuts
              className="md:col-span-5"
              dashboardData={dashboardData}
              tenants={tenants}
              leases={leases}
            />
            <MonthFigures
              className="md:col-span-3"
              dashboardData={dashboardData}
            />
            <GeneralFigures
              className="md:col-span-2"
              dashboardData={dashboardData}
            />
            <YearFigures
              className="md:col-span-5"
              dashboardData={dashboardData}
            />
            <PendingBills
              className="md:col-span-5"
              dashboardData={dashboardData}
            />
          </div>
        )}
      </div>
    </Page>
  );
}

export default withAuthentication(Dashboard);
