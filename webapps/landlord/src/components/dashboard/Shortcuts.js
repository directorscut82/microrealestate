/* eslint-disable sort-imports */
import { LuKeyRound, LuStopCircle, LuUserCircle } from 'react-icons/lu';
import { TbCashRegister } from 'react-icons/tb';
import { useCallback, useContext, useMemo, useState } from 'react';
import { cn } from '../../utils';
import { Card, CardContent } from '../ui/card';
import FirstConnection from './FirstConnection';
import NewLeaseDialog from '../organization/lease/NewLeaseDialog';
import NewPaymentDialog from '../payment/NewPaymentDialog';
import NewPropertyDialog from '../properties/NewPropertyDialog';
import NewTenantDialog from '../tenants/NewTenantDialog';
import { RiContractLine } from 'react-icons/ri';
import ShortcutButton from '../ShortcutButton';
import { StoreContext } from '../../store';
import TerminateLeaseDialog from '../tenants/TerminateLeaseDialog';
import { useMediaQuery } from 'usehooks-ts';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

/*
 * Shortcuts — DESIGN.md app shell shortcut bar.
 *
 * On mobile, a fixed bottom strip with a top hairline (no card-in-card; the
 * strip is its own surface). On desktop, an inline grid of bone tiles.
 *
 * First-connection mode embeds an illustration + step list inside a Card,
 * which is the legitimate use of a card here (welcoming new users).
 */
function Shortcuts({
  firstConnection = false,
  className,
  dashboardData = {},
  tenants = [],
  leases = []
}) {
  const store = useContext(StoreContext);
  const router = useRouter();
  const { t } = useTranslation('common');
  const isDesktop = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false
  });
  const [openNewLeaseDialog, setOpenNewLeaseDialog] = useState(false);
  const [openNewTenantDialog, setOpenNewTenantDialog] = useState(false);
  const [openNewPropertyDialog, setOpenNewPropertyDialog] = useState(false);
  const [openNewPaymentDialog, setOpenNewPaymentDialog] = useState(false);
  const [openTerminateLeaseDialog, setOpenTerminateLeaseDialog] =
    useState(false);

  const tenantsNotTerminated = useMemo(
    () => tenants.filter((t) => !t.terminated),
    [tenants]
  );

  const hasContract = !!leases?.length;
  const hasProperty = !!dashboardData?.overview?.propertyCount;
  const hasTenant = !!tenants?.length;

  const handleCreateContract = useCallback(() => {
    setOpenNewLeaseDialog(true);
  }, [setOpenNewLeaseDialog]);

  const handleAddProperty = useCallback(() => {
    setOpenNewPropertyDialog(true);
  }, [setOpenNewPropertyDialog]);

  const handleAddTenant = useCallback(() => {
    setOpenNewTenantDialog(true);
  }, [setOpenNewTenantDialog]);

  const handlePayment = useCallback(() => {
    setOpenNewPaymentDialog(true);
  }, [setOpenNewPaymentDialog]);

  const handleTerminateLease = useCallback(() => {
    setOpenTerminateLeaseDialog(true);
  }, [setOpenTerminateLeaseDialog]);

  return (
    <>
      {firstConnection ? (
        <Card className={className}>
          <CardContent className="pt-6">
            <FirstConnection
              hasContract={hasContract}
              hasProperty={hasProperty}
              hasTenant={hasTenant}
              handleCreateContract={handleCreateContract}
              handleAddProperty={handleAddProperty}
              handleAddTenant={handleAddTenant}
            />
          </CardContent>
        </Card>
      ) : (
        <div
          className={cn(
            'fixed grid grid-cols-5 gap-px bottom-0 left-0 w-full z-40 bg-bone border-t border-stone-line',
            'md:relative md:z-auto md:bg-transparent md:border-0 md:gap-3',
            className
          )}
        >
          <ShortcutButton
            Icon={TbCashRegister}
            label={isDesktop ? t('Pay a rent') : t('Pay')}
            disabled={!dashboardData?.overview?.tenantCount}
            onClick={handlePayment}
            dataCy="shortcutSettleRent"
          />

          <ShortcutButton
            Icon={LuStopCircle}
            label={isDesktop ? t('Terminate a lease') : t('Terminate')}
            onClick={handleTerminateLease}
            dataCy="shortcutTerminateLease"
          />

          <ShortcutButton
            Icon={LuKeyRound}
            label={isDesktop ? t('Add a property') : t('Add')}
            onClick={handleAddProperty}
            dataCy="shortcutAddProperty"
          />

          <ShortcutButton
            Icon={LuUserCircle}
            label={isDesktop ? t('Add a tenant') : t('Add')}
            onClick={handleAddTenant}
            dataCy="shortcutAddTenant"
          />

          {store.user.isAdministrator && (
            <ShortcutButton
              Icon={RiContractLine}
              label={isDesktop ? t('Create a contract') : t('Create')}
              onClick={handleCreateContract}
              dataCy="shortcutCreateContract"
            />
          )}
        </div>
      )}
      <NewPaymentDialog
        open={openNewPaymentDialog}
        setOpen={setOpenNewPaymentDialog}
      />
      <TerminateLeaseDialog
        open={openTerminateLeaseDialog}
        setOpen={setOpenTerminateLeaseDialog}
        tenantList={tenantsNotTerminated}
      />
      <NewTenantDialog
        open={openNewTenantDialog}
        setOpen={setOpenNewTenantDialog}
      />
      <NewPropertyDialog
        open={openNewPropertyDialog}
        setOpen={setOpenNewPropertyDialog}
      />
      <NewLeaseDialog
        open={openNewLeaseDialog}
        setOpen={setOpenNewLeaseDialog}
      />
    </>
  );
}

export default Shortcuts;
