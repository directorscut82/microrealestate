import { createContext, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { isClient, isServer } from '@microrealestate/commonui/utils';

import config from '../config';
import { setOrganizationId } from '../utils/fetch';
import Store from './Store';

let _store;

export function getStoreInstance(initialData) {
  // E23: on the server every request gets a fresh Store. The previous
  // implementation assigned the new Store to the module-level `_store`
  // so that `setupOrganizationsInStore()` (which read from `_store`)
  // could find it — but two concurrent SSR requests would overwrite
  // each other's `_store` between the synchronous getStoreInstance()
  // and the awaited setupOrganizationsInStore() call inside
  // getServerSideProps. The handoff is now explicit: callers receive
  // the Store directly and pass it to setupOrganizationsInStore. We
  // still keep the module-level `_store` for the CLIENT path (where it
  // is a real singleton) and so the legacy fallback inside
  // setupOrganizationsInStore continues to work for client callers
  // (Authentication.js → useFillStore → setupOrganizationsInStore)
  // that don't pass the store explicitly.
  if (isServer()) {
    const ssrStore = new Store();
    if (initialData) ssrStore.hydrate(initialData);
    return ssrStore;
  }

  if (!_store) {
    _store = new Store();
    _store.hydrate(initialData);
    if (config.NODE_ENV === 'development') {
      window.__store = _store;
    }
  }

  return _store;
}

export const StoreContext = createContext();

export function InjectStoreContext({ children, initialData }) {
  const store = getStoreInstance(initialData);

  const subscribe = useCallback((listener) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getVersion(), [store]);
  const version = useSyncExternalStore(subscribe, getSnapshot, () => 0);

  // Spread into new object so React Context sees a new reference on each notify
  const contextValue = useMemo(
    () => ({ user: store.user, organization: store.organization, appHistory: store.appHistory }),
    [store, version]
  );

  useEffect(() => {
    if (isClient() && config.NODE_ENV === 'development') {
      window.__store = store;
    }
  }, [store]);

  return (
    <StoreContext.Provider value={contextValue}>{children}</StoreContext.Provider>
  );
}

export async function setupOrganizationsInStore(selectedOrgName, storeArg) {
  // E23: accept the store explicitly so the SSR path passes the
  // request-scoped instance straight through. The legacy implementation
  // read from the module-level `_store`, which on the server was being
  // overwritten by every concurrent request — two SSR responses could
  // race and end up calling setSelected on each other's Store. Callers
  // that don't pass the store (the existing client path via
  // useFillStore/Authentication) fall back to the singleton, which on
  // the client IS request-scoped (one tab = one in-memory Store).
  const store = storeArg || _store;
  if (!store) {
    console.error(
      'the store is not created. Fill organizations in store is not possible'
    );
    return;
  }

  await store.organization.fetch();
  if (store.organization.items.length && !store.organization.selected) {
    let selectedOrganization;
    if (selectedOrgName) {
      selectedOrganization = store.organization.items.find(
        ({ name }) => name === selectedOrgName
      );
      if (!selectedOrganization) {
        // Caller passed an explicit name that does not match any org —
        // fail loudly instead of silently picking the first organization.
        throw new Error(
          `Organization "${selectedOrgName}" not found in store`
        );
      }
    } else {
      selectedOrganization = store.organization.items[0];
    }
    store.organization.setSelected(selectedOrganization, store.user);
    setOrganizationId(store.organization.selected._id);
  }
}
