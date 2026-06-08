import { getStoreInstance, setupOrganizationsInStore } from '../store';

export default function Index() {
  return null;
}

export async function getServerSideProps(context) {
  // E23: server-side rendering — request-scoped Store so concurrent SSR
  // requests can't trample each other's user/organization state. Pass
  // the store explicitly to setupOrganizationsInStore (the legacy
  // signature read from a module-level `_store` that was raced across
  // concurrent requests).
  const store = getStoreInstance();

  const { status } = await store.user.refreshTokens(context);
  if (status !== 200) {
    return { redirect: { destination: '/signin', permanent: false } };
  }

  await setupOrganizationsInStore(undefined, store);
  if (!store.user.signedIn) {
    return { redirect: { destination: '/signin', permanent: false } };
  }

  // T2.2: prepend the realm's locale to the redirect so next-translate
  // applies it from the very first response. Without this prefix the URL
  // is `/<org>/dashboard` (no locale segment) and next-translate falls
  // back to defaultLocale='en' until the client-side router.push in
  // signin.js re-routes — which only fires on the signin path. Direct
  // visits to `/landlord/` therefore rendered English on a Greek realm.
  const orgLocale = store.organization.selected?.locale;
  const localePrefix = orgLocale ? `/${orgLocale}` : '';
  return {
    redirect: {
      destination: `${localePrefix}/${store.organization.selected.name}/dashboard`,
      permanent: false
    }
  };
}
