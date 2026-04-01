import { getStoreInstance, setupOrganizationsInStore } from '../store';

export default function Index() {
  return null;
}

export async function getServerSideProps(context) {
  const store = getStoreInstance();

  const { status } = await store.user.refreshTokens(context);
  if (status !== 200) {
    return { redirect: { destination: '/signin', permanent: false } };
  }

  await setupOrganizationsInStore();
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
