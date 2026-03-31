import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from '../../../components/ui/tabs';
import { useCallback, useMemo, useState } from 'react';
import { Card } from '../../../components/ui/card';
import { downloadDocument } from '../../../utils/fetch';
import { fetchAccounting, QueryKeys } from '../../../utils/restcalls';
import IncomingTenants from '../../../components/accounting/IncomingTenants';
import moment from 'moment';
import OutgoingTenants from '../../../components/accounting/OutgoingTenants';
import Page from '../../../components/Page';
import PeriodPicker from '../../../components/PeriodPicker';
import SearchFilterBar from '../../../components/SearchFilterBar';
import TenantSettlements from '../../../components/accounting/TenantSettlements';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

function TopBar({ onSearch }) {
  const router = useRouter();
  const year = router.query.year || moment().year();

  const onChange = useCallback(
    async (period) => {
      await router.push(
        `/${router.query.organization}/accounting/${period.format(
          'YYYY'
        )}`
      );
    },
    [router]
  );

  return (
    <div className="flex flex-col-reverse md:flex-row gap-4 p-2">
      <SearchFilterBar onSearch={onSearch} className="flex-grow" />
      <PeriodPicker
        format="YYYY"
        period="year"
        value={moment(year, 'YYYY')}
        onChange={onChange}
        className="text-2xl gap-4"
      />
    </div>
  );
}

function Accounting() {
  const { t } = useTranslation('common');
  const router = useRouter();
  const year = router.query.year;
  const [searchText, setSearchText] = useState('');

  const { data: accountingData, isLoading } = useQuery({
    queryKey: [QueryKeys.ACCOUNTING, year],
    queryFn: () => fetchAccounting(year),
    enabled: !!year
  });

  const filteredData = useMemo(() => {
    if (!accountingData) return {};
    if (!searchText) return accountingData;
    const lc = searchText.toLowerCase();
    return {
      ...accountingData,
      incomingTenants:
        accountingData.incomingTenants?.filter((t) =>
          t.name.toLowerCase().includes(lc)
        ) || [],
      outgoingTenants:
        accountingData.outgoingTenants?.filter((t) =>
          t.name.toLowerCase().includes(lc)
        ) || [],
      settlements:
        accountingData.settlements?.filter((s) =>
          s.tenant.toLowerCase().includes(lc)
        ) || []
    };
  }, [accountingData, searchText]);

  const getSettlementsAsCsv = useCallback(
    async (e) => {
      e.stopPropagation();
      downloadDocument({
        endpoint: `/csv/settlements/${year}`,
        documentName: t('Settlements - {{year}}.csv', { year })
      });
    },
    [t, year]
  );

  const getIncomingTenantsAsCsv = useCallback(
    async (e) => {
      e.stopPropagation();
      downloadDocument({
        endpoint: `/csv/tenants/incoming/${year}`,
        documentName: t('Incoming tenants - {{year}}.csv', { year })
      });
    },
    [t, year]
  );

  const getOutgoingTenantsAsCsv = useCallback(
    async (e) => {
      e.stopPropagation();
      downloadDocument({
        endpoint: `/csv/tenants/outgoing/${year}`,
        documentName: t('Outgoing tenants - {{year}}.csv', { year })
      });
    },
    [t, year]
  );

  const getYearInvoices = useCallback(
    (tenant) => () => {
      downloadDocument({
        endpoint: `/documents/invoice/${tenant._id}/${year}`,
        documentName: `${tenant.name}-${year}-${t('invoice')}.pdf`
      });
    },
    [year, t]
  );

  const handleSearch = useCallback((_, text) => {
    setSearchText(text);
  }, []);

  return (
    <Page loading={isLoading} dataCy="accountingPage">
      <Card className="px-4 py-2 mb-6">
        <TopBar onSearch={handleSearch} />
      </Card>
      <Tabs defaultValue="incoming">
        <TabsList className="flex justify-start w-screen-nomargin-sm md:w-full overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="incoming" className="min-w-48 sm:w-full">{`${t(
            'Incoming tenants'
          )} (${filteredData.incomingTenants?.length || 0})`}</TabsTrigger>
          <TabsTrigger value="outgoing" className="min-w-48 sm:w-full">{`${t(
            'Outgoing tenants'
          )} (${filteredData.outgoingTenants?.length || 0})`}</TabsTrigger>
          <TabsTrigger
            value="settlements"
            className="min-w-48 sm:w-full"
          >{`${t('Settlements')} (${
            filteredData.settlements?.length || 0
          })`}</TabsTrigger>
        </TabsList>
        <TabsContent value="incoming">
          <IncomingTenants
            data={filteredData.incomingTenants}
            onCSVClick={getIncomingTenantsAsCsv}
          />
        </TabsContent>
        <TabsContent value="outgoing">
          <OutgoingTenants
            data={filteredData.outgoingTenants}
            onCSVClick={getOutgoingTenantsAsCsv}
          />
        </TabsContent>
        <TabsContent value="settlements">
          <TenantSettlements
            data={filteredData.settlements}
            onCSVClick={getSettlementsAsCsv}
            onDownloadYearInvoices={getYearInvoices}
          />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

export default withAuthentication(Accounting);
