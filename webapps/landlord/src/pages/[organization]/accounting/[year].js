import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from '../../../components/ui/tabs';
import { useCallback, useMemo, useState } from 'react';
import { Card } from '../../../components/ui/card';
import { downloadDocument } from '../../../utils/fetch';
import {
  fetchAccounting,
  fetchOwners,
  QueryKeys
} from '../../../utils/restcalls';
import IncomingTenants from '../../../components/accounting/IncomingTenants';
import moment from 'moment';
import OutgoingTenants from '../../../components/accounting/OutgoingTenants';
import OwnerStatements from '../../../components/accounting/OwnerStatements';
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

  // Owners for the Ιδιοκτήτες sub-tab (statement downloads). Round-2 audit H9:
  // scope to the page's year so Paid/Outstanding reconcile with the sibling
  // year-scoped tabs + statement PDF (the standalone Owners page omits year).
  const { data: ownersData } = useQuery({
    queryKey: [QueryKeys.OWNERS, year],
    queryFn: () => fetchOwners(year),
    enabled: !!year
  });

  const filteredOwners = useMemo(() => {
    const list = ownersData || [];
    if (!searchText) return list;
    // Round-1 audit L7: normalize taxId the SAME way the Owners page does
    // (lowercase + strip space/dot/dash) so the same query yields the same
    // owner set on both surfaces and a separator-containing taxId still matches.
    const norm = (s) =>
      String(s || '')
        .toLowerCase()
        .replace(/\s|\.|-/gi, '');
    const q = norm(searchText);
    const lc = searchText.toLowerCase();
    return list.filter(
      (o) => (o.name || '').toLowerCase().includes(lc) || norm(o.taxId).includes(q)
    );
  }, [ownersData, searchText]);

  const filteredData = useMemo(() => {
    if (!accountingData) return {};
    if (!searchText) return accountingData;
    const lc = searchText.toLowerCase();
    // Round-1 audit L8: coerce name/tenant with String(x ?? '') — a row with a
    // null name otherwise throws at .toLowerCase() and the ErrorBoundary blanks
    // the whole Accounting page (matches owners/index.js norm()).
    return {
      ...accountingData,
      incomingTenants:
        accountingData.incomingTenants?.filter((t) =>
          String(t.name ?? '').toLowerCase().includes(lc)
        ) || [],
      outgoingTenants:
        accountingData.outgoingTenants?.filter((t) =>
          String(t.name ?? '').toLowerCase().includes(lc)
        ) || [],
      settlements:
        accountingData.settlements?.filter((s) =>
          String(s.tenant ?? '').toLowerCase().includes(lc)
        ) || []
    };
  }, [accountingData, searchText]);

  const getSettlementsAsCsv = useCallback(
    async (e) => {
      e.stopPropagation();
      downloadDocument({
        endpoint: `/csv/settlements/${year}`,
        documentName: t('Payments - {{year}}.csv', { year })
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

  // Q4 multi-month batch: the popover passes an array of selected months
  // (1..12). Build a comma-separated list of 10-digit YYYYMMDDHH terms
  // and hand it to /documents/invoice/<tid>/<csv-terms>. The backend
  // regex accepts up to 12 comma-separated terms; the EJS template
  // iterates `tenant.rents.forEach(...)` so a 3-month selection produces
  // a stitched 3-section single PDF automatically.
  const getYearInvoices = useCallback(
    (tenant) => (months) => {
      const list = Array.isArray(months) ? months : [months];
      if (!list.length) return;
      const terms = list
        .map((m) => `${year}${String(m).padStart(2, '0')}0100`)
        .join(',');
      // Filename: single-month → keep the existing `<name>-<YYYYMM>-receipt`
      // shape; multi-month → `<name>-<YYYY>-receipts-<count>` so it stays
      // legible at any selection size.
      const documentName =
        list.length === 1
          ? `${tenant.name}-${year}${String(list[0]).padStart(2, '0')}-${t(
              'receipt'
            )}.pdf`
          : `${tenant.name}-${year}-${t('Receipts')}-${list.length}.pdf`;
      downloadDocument({
        endpoint: `/documents/invoice/${tenant._id}/${terms}`,
        documentName
      });
    },
    [year, t]
  );

  // Owner statement (εκκαθαριστικό) — the owner counterpart to getYearInvoices.
  // Returns a (months[]) => void that downloads the owner_statement PDF for the
  // selected months as a single multi-section document.
  const getOwnerStatement = useCallback(
    (owner) => (months) => {
      const list = Array.isArray(months) ? months : [months];
      if (!list.length) return;
      const terms = list
        .map((m) => `${year}${String(m).padStart(2, '0')}0100`)
        .join(',');
      downloadDocument({
        endpoint: `/documents/owner-statement/${encodeURIComponent(
          owner.ownerKey
        )}/${terms}`,
        documentName: `${owner.name || 'owner'}-${year}-${t('Statement')}.pdf`
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
          >{`${t('Tenant settlements')} (${
            filteredData.settlements?.length || 0
          })`}</TabsTrigger>
          <TabsTrigger value="owners" className="min-w-48 sm:w-full">{`${t(
            'Owner settlements'
          )} (${filteredOwners?.length || 0})`}</TabsTrigger>
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
        <TabsContent value="owners">
          <OwnerStatements
            data={filteredOwners}
            onDownloadStatement={getOwnerStatement}
          />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

export default withAuthentication(Accounting);
