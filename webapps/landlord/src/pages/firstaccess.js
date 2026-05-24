import React, { useContext, useEffect } from 'react';
import { Card, CardContent } from '../components/ui/card';
import Landlord from '../components/organization/LandlordForm';
import { StoreContext } from '../store';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../components/Authentication';

/*
 * FirstAccess — DESIGN.md onboarding page.
 *
 * Centered form on cream body. Three layers of hierarchy: a quiet greeting
 * (label-sized, ink-muted), a real page title (headline weight), and the
 * organization form sitting in a single bone card directly below.
 */
function FirstAccess() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const router = useRouter();

  useEffect(() => {
    if (store.organization.items.length && store.organization.selected?.name) {
      router.push(`/${store.organization.selected.name}/dashboard`);
    }
  }, [store.organization.items.length, store.organization.selected?.name, router]);

  if (store.organization.items.length) {
    return null;
  }

  return (
    <div
      className="mx-auto w-full max-w-xl px-6 pt-12 pb-16"
      data-cy="firstaccessPage"
    >
      <header className="mb-8 space-y-2">
        <div className="text-label text-ink-muted uppercase tracking-wide">
          {t('Welcome {{firstName}} {{lastName}}!', {
            firstName: store.user.firstName,
            lastName: store.user.lastName
          })}
        </div>
        <h1 className="text-headline font-medium text-ink tracking-tight">
          {t('One more step, tell us who will rent the properties')}
        </h1>
      </header>
      <Card>
        <CardContent className="pt-6">
          <Landlord firstAccess />
        </CardContent>
      </Card>
    </div>
  );
}

export default withAuthentication(FirstAccess);
