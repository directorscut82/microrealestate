import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from '../ui/drawer';
import React, {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import { Button } from '../ui/button';
import { fetchRents } from '../../utils/restcalls';
import PaymentTabs from './PaymentTabs';
import RentSelector from './RentSelector';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

export default function NewPaymentDialog({
  open,
  setOpen,
  data: defaultRent,
  onClose,
  // Wave-26 round-3o: when true, the date picker on payment drafts is
  // disabled and locked to today. Used by the dashboard shortcut.
  lockDateToToday = false
}) {
  const { t } = useTranslation('common');
  const [selectedRent, setSelectedRent] = useState();
  const [rents, setRents] = useState();
  const [saving, setSaving] = useState(false);
  const formRef = useRef();
  // Re-entrancy guard. Reading `saving` from useState in handleSave's
  // closure is racy: a fast double-click runs the handler twice with
  // `saving=false` captured both times, before React flushes setSaving.
  // A useRef value is updated synchronously, so the second click sees
  // the in-flight flag and bails. The visible disabled-state on the
  // button still uses the useState (so it actually re-renders disabled).
  const submittingRef = useRef(false);

  useEffect(() => {
    const loadRents = async () => {
      try {
        const data = await fetchRents();
        setRents(data.rents);
        if (data.rents.length === 1) {
          setSelectedRent(data.rents[0]);
        }
      } catch {
        toast.error(t('Something went wrong'));
        setRents([]);
      }
    };

    setSelectedRent(open ? defaultRent : null);
    setRents(open && defaultRent ? [defaultRent] : null);
    if (open && !defaultRent) {
      loadRents();
    }
  }, [open, defaultRent, t]);

  const handleRentChange = async (rent) => {
    setSelectedRent(rent);
    formRef.current?.setValues(rent);
  };

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSave = useCallback(() => {
    // Synchronous re-entry guard via ref — the useState `saving` flag
    // can only catch repeated clicks AFTER React renders the disabled
    // button. A fast double-click before that render runs handleSave
    // twice, fires two PATCH requests, and the second loses to the
    // optimistic-lock 409 with the toast appearing on a closed dialog.
    // The ref is reset by handleSubmit (success) or handleError
    // (PaymentTabs onError fires for both zod-validation failures and
    // PATCH catch). Both paths are guaranteed to fire — no timeout
    // fallback needed (the prior 80ms reset was racy: a fast PATCH
    // would see isSubmitting=false and unlock the ref, allowing a
    // queued duplicate click through).
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSaving(true);
    formRef.current.submit();
  }, []);

  const handleError = useCallback(() => {
    submittingRef.current = false;
    setSaving(false);
  }, []);

  const handleSubmit = useCallback(() => {
    // Keep submittingRef = true through the drawer close animation so a
    // second click that arrives during the close-out window cannot fire
    // a duplicate PATCH. The ref resets when the drawer reopens (via
    // the `open` effect below). Without this, force-clicks during the
    // ~300ms vaul close animation slip past the ref guard because we
    // had already set it false here.
    setSaving(false);
    onClose?.(selectedRent);
    handleClose();
  }, [handleClose, onClose, selectedRent]);

  // Reset the re-entry guard when the dialog (re)opens. Closing the
  // drawer keeps the ref locked so duplicate-clicks during the close
  // animation are absorbed.
  useEffect(() => {
    if (open) {
      submittingRef.current = false;
    }
  }, [open]);

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerContent className="h-full w-full">
        <DrawerHeader className="mx-auto w-full max-w-screen-lg text-lg md:text-xl font-semibold leading-none tracking-tight px-4">
          <DrawerTitle>
            {rents?.length > 1 ? t('Pay a rent') : t('Enter a rent settlement')}
          </DrawerTitle>
        </DrawerHeader>

        <div className="p-4 overflow-y-auto scrollbar-branded mx-auto w-full max-w-screen-lg space-y-2">
          <RentSelector
            value={selectedRent}
            rents={rents}
            onChange={handleRentChange}
          />
          {selectedRent?.term ? (
            <PaymentTabs
              ref={formRef}
              rent={selectedRent}
              onSubmit={handleSubmit}
              onError={handleError}
              lockDateToToday={lockDateToToday}
            />
          ) : null}
        </div>

        <DrawerFooter className="mx-auto w-full max-w-screen-lg">
          <div className="flex flex-col md:flex-row md:justify-end sm:gap-2">
            <Button variant="outline" onClick={handleClose}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!selectedRent?.occupant || saving}
            >
              {saving ? t('Saving') : t('Record')}
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
