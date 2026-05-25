import { getStoreInstance, setupOrganizationsInStore } from '../store';

import config from '../config';
import ErrorPage from 'next/error';
import { useEffect } from 'react';
import useFillStore from '../hooks/useFillStore';
import { useRouter } from 'next/router';

async function fetchData(store, router) {
  if (store.user.signedIn) {
    return store.organization.items;
  }

  await setupOrganizationsInStore(router.query.organization);
  return store.organization.items;
}

export function withAuthentication(PageComponent, grantedRole) {
  function WithAuth(pageProps) {
    const store = getStoreInstance();
    const router = useRouter();
    const [fetching] = useFillStore(fetchData, [router]);

    const needsSignin = !fetching && store.user.signedIn === false;
    const needsFirstAccess =
      !fetching &&
      store.user.signedIn !== false &&
      router.pathname !== '/firstaccess' &&
      !store.organization.items.length;

    useEffect(() => {
      if (needsSignin) {
        window.location.assign(`${config.BASE_PATH}/signin`);
      } else if (needsFirstAccess) {
        window.location.assign(`${config.BASE_PATH}/firstaccess`);
      }
    }, [needsSignin, needsFirstAccess]);

    if (fetching || needsSignin || needsFirstAccess) {
      return null;
    }

    if (grantedRole && grantedRole !== store.user.role) {
      return <ErrorPage statusCode={404} />;
    }

    return <PageComponent {...pageProps} />;
  }

  return WithAuth;
}
