import { apiFetcher } from '../utils/fetch';

export default class Organization {
  constructor(store) {
    this._store = store;
    this.selected = undefined;
    this.items = [];
  }

  setSelected = (org, user) => {
    this.selected = org;
    user.setRole(
      this.selected.members.find(({ email }) => email === user.email).role
    );
    this._store.notify();
  };

  setItems = (organizations = []) => {
    this.items = organizations;
    this._store.notify();
  };

  get canSendEmails() {
    return (
      !!this.selected?.thirdParties?.gmail?.selected ||
      this.selected?.thirdParties?.smtp?.selected ||
      this.selected?.thirdParties?.mailgun?.selected
    );
  }

  // Wave-26: which email provider is wired (display only — used by the
  // /rents channel-status banners so the user sees "Gmail" rather than
  // "configured" alone). Returns null when no email provider is selected.
  get emailProviderName() {
    const tp = this.selected?.thirdParties;
    if (tp?.gmail?.selected) return 'Gmail';
    if (tp?.smtp?.selected) return 'SMTP';
    if (tp?.mailgun?.selected) return 'Mailgun';
    return null;
  }

  // Wave-26: SMS gateway parity. Backed by `thirdParties.smsGateway.selected`,
  // populated via the same Settings → Third-party services form.
  get canSendSms() {
    return !!this.selected?.thirdParties?.smsGateway?.selected;
  }

  get canUploadDocumentsInCloud() {
    return !!this.selected?.thirdParties?.b2;
  }

  async fetch() {
    try {
      const response = await apiFetcher().get('/realms');
      this.setItems(response.data);
      return { status: 200, data: response.data };
    } catch (error) {
      console.error(error);
      return error.response.status;
    }
  }

  async create(organization) {
    try {
      const response = await apiFetcher().post('/realms', organization);
      return { status: 200, data: response.data };
    } catch (error) {
      console.error(error);
      return { status: error?.response?.status };
    }
  }

  async update(organization) {
    try {
      const response = await apiFetcher().patch(
        `/realms/${organization._id}`,
        organization
      );
      return { status: 200, data: response.data };
    } catch (error) {
      console.error(error);
      return { status: error?.response?.status };
    }
  }
}
