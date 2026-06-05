import { fetchRents, QueryKeys, sendRentEmails, sendRentSms } from '../../../../utils/restcalls';
import { LuChevronDown, LuMessageSquare, LuSend } from 'react-icons/lu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../../../components/ui/popover';
import { useCallback, useContext, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../../components/ui/button';
import ChannelStatusBanners from '../../../../components/rents/ChannelStatusBanners';
import ConfirmDialog from '../../../../components/ConfirmDialog';
import ErrorPage from 'next/error';
import { GrDocumentPdf } from 'react-icons/gr';
import { List } from '../../../../components/ResourceList';
import { LuRotateCw } from 'react-icons/lu';
import moment from 'moment';
import Page from '../../../../components/Page';
import { RentOverview } from '../../../../components/rents/RentOverview';
import RentTable from '../../../../components/rents/RentTable';
import { StoreContext } from '../../../../store';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../../components/Authentication';

function _filterData(data, filters) {
  // E17: defend against an undefined `data` (initial render before
  // useQuery resolves, error states, paginated empty pages, etc.). The
  // List component invokes filterFn before its own loading branch on
  // each render and `data.rents` previously crashed with "Cannot read
  // properties of undefined" on those frames.
  const _rents = Array.isArray(data?.rents) ? data.rents : [];
  let filteredItems =
    filters.statuses?.length > 0
      ? _rents.filter(({ status }) => filters.statuses.includes(status))
      : _rents;

  if (filters.searchText) {
    const regExp = /\s|\.|-/gi;
    const cleanedSearchText = filters.searchText
      .toLowerCase()
      .replace(regExp, '');

    filteredItems = filteredItems.filter(
      ({ occupant: { isCompany, name, manager, contacts }, payments }) => {
        // Search match name
        let found =
          name.replace(regExp, '').toLowerCase().indexOf(cleanedSearchText) !=
          -1;

        // Search match manager
        if (!found && isCompany) {
          found =
            manager
              .replace(regExp, '')
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

        // Search match in payment references
        if (!found) {
          found = !!payments?.find(
            ({ reference = '' }) =>
              reference
                .replace(regExp, '')
                .toLowerCase()
                .indexOf(cleanedSearchText) != -1
          );
        }

        return found;
      }
    );
  }
  return filteredItems;
}

function Actions({ values, yearMonth, onDone }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [showConfirmDlg, setShowConfirmDlg] = useState(false);
  const [selectedDocumentName, setSelectedDocumentName] = useState(null);
  const disabled = !values?.length;

  // Sending invoices/notices stamps the rent record (lastSentDate / emailed
  // timestamps) and writes a Document. Refresh RENTS broadly (cross-period
  // ledger views) and the dashboard summary which counts unsent notices.
  const _invalidateRentSendDependents = () => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS, yearMonth] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
  };

  const sendMutation = useMutation({
    mutationFn: sendRentEmails,
    onSuccess: () => {
      _invalidateRentSendDependents();
      onDone?.();
    }
  });

  const smsMutation = useMutation({
    mutationFn: sendRentSms,
    onSuccess: () => {
      toast.success(t('SMS sent'));
      _invalidateRentSendDependents();
      onDone?.();
    }
  });

  const handleAction = useCallback(
    (docName) => async () => {
      setSelectedDocumentName(docName);
      setShowConfirmDlg(true);
    },
    []
  );

  const handleConfirm = useCallback(async () => {
    try {
      await sendMutation.mutateAsync({
        document: selectedDocumentName,
        tenantIds: values.map((r) => r._id),
        terms: values.map((r) => r.term)
      });
    } catch {
      toast.error(t('Email delivery service cannot send emails'));
    }
  }, [selectedDocumentName, sendMutation, t, values]);

  return (
    <>
      {sendMutation.isPending ? (
        <div className="flex items-center gap-1 text-muted-foreground">
          <LuRotateCw className="animate-spin size-4" />
          {t('Sending...')}
        </div>
      ) : (
        <div className="flex flex-col">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary" disabled={disabled}>
                <LuSend className="mr-2" />
                {t('Send by email')}
                <LuChevronDown className="ml-1" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="p-0.5 m-0 w-auto">
              <div className="flex flex-col">
                <Button
                  variant="ghost"
                  onClick={handleAction('invoice')}
                  disabled={disabled}
                  className="justify-start w-full rounded-none"
                >
                  <GrDocumentPdf className="mr-2" /> {t('Invoice')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleAction('rentcall')}
                  disabled={disabled}
                  className="justify-start w-full rounded-none"
                >
                  <GrDocumentPdf className="mr-2" /> {t('First payment notice')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleAction('rentcall_reminder')}
                  className="justify-start w-full rounded-none text-warning"
                >
                  <GrDocumentPdf className="mr-2 " />{' '}
                  {t('Second payment notice')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleAction('rentcall_last_reminder')}
                  className="justify-start w-full rounded-none text-destructive"
                >
                  <GrDocumentPdf className="mr-2" /> {t('Last payment notice')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="secondary"
            disabled={disabled || smsMutation.isPending}
            onClick={async () => {
              try {
                await smsMutation.mutateAsync({
                  document: 'rentcall',
                  tenantIds: values.map((r) => r._id),
                  terms: values.map((r) => r.term)
                });
              } catch {
                toast.error(t('SMS sending failed'));
              }
            }}
          >
            <LuMessageSquare className="mr-2" />
            {smsMutation.isPending ? t('Sending...') : t('Send SMS')}
          </Button>
        </div>
      )}

      {selectedDocumentName ? (
        <ConfirmDialog
          title={t('Are you sure to send "{{docName}}"?', {
            docName: t(selectedDocumentName)
          })}
          open={showConfirmDlg}
          setOpen={setShowConfirmDlg}
          data={selectedDocumentName}
          onConfirm={handleConfirm}
        >
          <div className="mb-2">{t('Tenants selected')}</div>
          <div className="flex flex-col gap-1 pl-4 text-sm max-h-48 overflow-auto">
            {values.map((tenant) => (
              <div key={tenant._id}>{tenant.occupant.name}</div>
            ))}
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function Rents() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const { yearMonth } = router.query;
  const isYearMonthValid = useMemo(
    () => moment(yearMonth, 'YYYY.MM', true).isValid(),
    [yearMonth]
  );
  const period = useMemo(
    () =>
      isYearMonthValid ? moment(yearMonth, 'YYYY.MM') : moment(),
    [yearMonth, isYearMonthValid]
  );
  const { data, isError, isLoading } = useQuery({
    queryKey: [QueryKeys.RENTS, yearMonth],
    queryFn: () => fetchRents(yearMonth),
    enabled: isYearMonthValid
  });
  const [rentSelected, setRentSelected] = useState([]);

  const handleActionDone = useCallback(() => {
    setRentSelected([]);
  }, []);

  if (isError) {
    toast.error(t('Error fetching rents'));
  }

  if (yearMonth && !isYearMonthValid) {
    return <ErrorPage statusCode={404} />;
  }

  return (
    <Page loading={isLoading} dataCy="rentsPage">
      <div className="my-4">
        <RentOverview data={{ period, ...data?.overview }} />
      </div>

      <ChannelStatusBanners />
      <List
        data={data}
        filters={[
          // Wave-26 round-3h: terser filter chips. The longer 'Owed this month'
          // form stays on the KPI tiles where the context is less obvious.
          { id: 'notpaid', label: t('In arrears') },
          { id: 'partiallypaid', label: t('Partially settled') },
          { id: 'paid', label: t('Settled') }
        ]}
        filterFn={_filterData}
        renderActions={() =>
          store.organization.canSendEmails ? (
            <Actions values={rentSelected} yearMonth={yearMonth} onDone={handleActionDone} />
          ) : null
        }
        renderList={({ data }) => (
          <RentTable
            rents={data}
            selected={rentSelected}
            setSelected={setRentSelected}
          />
        )}
      />
    </Page>
  );
}

export default withAuthentication(Rents);
