import { setAccessToken, setOrganizationId } from '../utils/fetch';

import AppHistory from './AppHistory';
import Organization from './Organization';
import User from './User';

export default class Store {
  constructor() {
    this.appHistory = new AppHistory();
    this.user = new User();
    this.organization = new Organization();
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
  }
}
