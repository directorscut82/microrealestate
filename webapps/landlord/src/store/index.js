import { createContext, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { isClient, isServer } from '@microrealestate/commonui/utils';

import config from '../config';
import { setOrganizationId } from '../utils/fetch';
import Store from './Store';

let _store;

export function getStoreInstance(initialData) {
  // On the server, create a fresh Store per request to avoid leaking
  // user/organization state across concurrent SSR responses. We still
  // assign to _store so that setupOrganizationsInStore (called after
  // getStoreInstance during the same request) can find it; concurrent
  // requests overwrite the variable but each request only reads it
  // synchronously between the assignment in getServerSideProps and the
  // setupOrganizationsInStore call that immediately follows.
  if (isServer()) {
    _store = new Store();
    if (initialData) _store.hydrate(initialData);
    return _store;
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

export async function setupOrganizationsInStore(selectedOrgName) {
  if (!_store) {
    console.error(
      'the store is not created. Fill organizations in store is not possible'
    );
    return;
  }

  await _store.organization.fetch();
  if (_store.organization.items.length && !_store.organization.selected) {
    let selectedOrganization;
    if (selectedOrgName) {
      selectedOrganization = _store.organization.items.find(
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
      selectedOrganization = _store.organization.items[0];
    }
    _store.organization.setSelected(selectedOrganization, _store.user);
    setOrganizationId(_store.organization.selected._id);
  }
}
