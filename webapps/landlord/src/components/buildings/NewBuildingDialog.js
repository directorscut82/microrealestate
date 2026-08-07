import {
  createBuilding,
  fetchBuildings,
  QueryKeys
} from '../../utils/restcalls';
import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import ResponsiveDialog from '../ResponsiveDialog';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

// Greek postal code: 5 digits.
const POSTAL_REGEX = /^[0-9]{5}$/;
// The ΑΤΑΚ *prefix* is the 6-digit building-level part of an 11-digit ΑΤΑΚ. NOT
// isValidATAK from utils/fieldvalidators — that is the full 11 digits and would
// reject every legitimate prefix. 6 is the length three consumers slice and
// compare for equality (e9parser, occupantmanager), so anything else silently
// fails to link imported properties to this building.
const ATAK_PREFIX_REGEX = /^[0-9]{6}$/;

const schema = z.object({
  name: z.string().trim().min(1),
  atakPrefix: z
    .string()
    .trim()
    .regex(ATAK_PREFIX_REGEX, 'ATAK prefix must be exactly 6 digits'),
  street1: z.string().trim().min(1),
  city: z.string().trim().min(1),
  zipCode: z.string().trim().regex(POSTAL_REGEX, 'Postal code must be 5 digits')
});

export default function NewBuildingDialog({ open, setOpen }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef();

  const createMutation = useMutation({
    mutationFn: createBuilding,
    onSuccess: () => {
      // Creating a building can affect dashboard counts and downstream rent
      // computation once units/tenants are linked. Keep the rent stack in
      // sync per the cross-cutting building-mutation rule.
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
    }
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors }
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      atakPrefix: '',
      street1: '',
      city: '',
      zipCode: ''
    }
  });

  // Existing buildings, to WARN (never block) on a duplicate name. A realm may
  // legitimately hold two buildings with the same name — the realmId+name index
  // is deliberately non-unique and only atakPrefix is de-duped server-side.
  const { data: existingBuildings } = useQuery({
    queryKey: [QueryKeys.BUILDINGS],
    queryFn: fetchBuildings,
    enabled: !!open
  });

  const typedName = watch('name');
  // The bill-import building Select labels options by name alone, so two
  // identically-named buildings render as two IDENTICAL options and the landlord
  // cannot tell which one a bill will be charged to. Say so at creation time,
  // while renaming is still free.
  const duplicateNameCount = useMemo(() => {
    const n = (typedName || '').trim().toLocaleLowerCase();
    if (!n) return 0;
    return (existingBuildings || []).filter(
      (b) => (b?.name || '').trim().toLocaleLowerCase() === n
    ).length;
  }, [typedName, existingBuildings]);

  const handleClose = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  const _onSubmit = useCallback(
    async (buildingPart) => {
      try {
        setIsLoading(true);
        const { street1, city, zipCode, ...rest } = buildingPart;
        const data = await createMutation.mutateAsync({
          ...rest,
          address: { street1, city, zipCode }
        });
        handleClose();
        const orgName =
          store.organization.selected?.name || router.query.organization;
        await router.push(`/${orgName}/buildings/${data._id}`, undefined, {
          locale: store.organization.selected?.locale
        });
      } catch (error) {
        const status = error?.response?.status;
        const serverMessage =
          error?.response?.data?.error || error?.response?.data?.message;
        switch (status) {
          case 422:
            // Surface the SERVER's reason. The fixed string this replaced said
            // "name or ATAK prefix is missing" for every 422 — a cause the zod
            // schema above already makes impossible to reach, so the one message
            // the landlord got was the one thing that could not be wrong. The
            // real 422s here are a duplicate ATAK prefix, a bad IBAN and
            // yearBuilt out of range, and none of them were ever named.
            if (/already exists|already in use/i.test(serverMessage || '')) {
              return toast.error(
                t('A building with this ATAK prefix already exists')
              );
            }
            return toast.error(
              serverMessage || t('Building name or ATAK prefix is missing')
            );
          case 403:
            return toast.error(t('You are not allowed to add a building'));
          default:
            return toast.error(t('Something went wrong'));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [createMutation, handleClose, router, store.organization.selected, t]
  );

  return (
    <ResponsiveDialog
      open={!!open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Add a building')}
      renderContent={() => (
        <form
          ref={formRef}
          onSubmit={handleSubmit(_onSubmit)}
          autoComplete="off"
        >
          <div className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('Name')}</Label>
              <Input id="name" {...register('name')} />
              {errors.name && (
                <p className="text-sm text-destructive">
                  {errors.name.message}
                </p>
              )}
              {/* WARN, not block: a duplicate name is allowed (the realmId+name
                  index is non-unique on purpose). It is worth saying because the
                  bill-import Select labels by name only. */}
              {duplicateNameCount > 0 && (
                <div className="rounded-md border border-oxide/40 bg-oxide-tint/40 p-3 text-sm text-ink space-y-1">
                  <div className="font-medium">
                    {t('{{count}} other buildings already use this name', {
                      count: duplicateNameCount
                    })}
                  </div>
                  <div className="text-label text-ink-muted">
                    {t(
                      'Identically named buildings look the same in the bill-import list. Add something distinguishing — the street or the ATAK prefix — so you can tell which one a bill is charged to.'
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="atakPrefix">{t('ATAK Prefix')}</Label>
              <Input
                id="atakPrefix"
                {...register('atakPrefix')}
                inputMode="numeric"
                maxLength={6}
              />
              {errors.atakPrefix && (
                <p className="text-sm text-destructive">
                  {t(errors.atakPrefix.message)}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="street1">{t('Street 1')}</Label>
              <Input id="street1" {...register('street1')} />
              {errors.street1 && (
                <p className="text-sm text-destructive">
                  {errors.street1.message}
                </p>
              )}
            </div>
            <div className="sm:flex sm:gap-2">
              <div className="space-y-2 flex-1">
                <Label htmlFor="zipCode">{t('Zip code')}</Label>
                <Input
                  id="zipCode"
                  {...register('zipCode')}
                  inputMode="numeric"
                  maxLength={5}
                />
                {errors.zipCode && (
                  <p className="text-sm text-destructive">
                    {errors.zipCode.message}
                  </p>
                )}
              </div>
              <div className="space-y-2 flex-1">
                <Label htmlFor="city">{t('City')}</Label>
                <Input id="city" {...register('city')} />
                {errors.city && (
                  <p className="text-sm text-destructive">
                    {errors.city.message}
                  </p>
                )}
              </div>
            </div>
          </div>
        </form>
      )}
      renderFooter={() => (
        <>
          <Button variant="outline" onClick={handleClose}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={() => formRef.current?.requestSubmit()}
            data-cy="submitBuilding"
          >
            {t('Add')}
          </Button>
        </>
      )}
    />
  );
}
