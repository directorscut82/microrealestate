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

  return {
    redirect: {
      destination: `/${store.organization.selected.name}/dashboard`,
      permanent: false
    }
  };
}
