import { setAccessToken, setOrganizationId } from '../utils/fetch';

import AppHistory from './AppHistory';
import Organization from './Organization';
import User from './User';

export default class Store {
  constructor() {
    this._listeners = new Set();
    this._version = 0;
    this.appHistory = new AppHistory(this);
    this.user = new User(this);
    this.organization = new Organization(this);
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  notify() {
    this._version++;
    this._listeners.forEach((listener) => listener());
  }

  getVersion() {
    return this._version;
  }

  hydrate(initialData) {
    if (!initialData) {
      return;
    }

    const {
      user = {},
      organization = { items: [] },
      appHistory = { previousPath: '/' }
    } = initialData;

    this.user.firstName = user.firstName;
    this.user.lastName = user.lastName;
    this.user.email = user.email;
    this.user.role = user.role;
    this.user.token = user.token;
    this.user.tokenExpiry = user.tokenExpiry;
    setAccessToken(user.token);

    this.organization.items = organization.items;
    this.organization.selected = organization.selected;
    setOrganizationId(organization.selected?._id);

    this.appHistory.previousPath = appHistory.previousPath;

    this.notify();
  }
}
