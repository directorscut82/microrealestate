import { apiFetcher } from '../utils/fetch';

export default class Organization {
  constructor() {
    this.selected = undefined;
    this.items = [];
  }

  setSelected = (org, user) => {
    this.selected = org;
    user.setRole(
      this.selected.members.find(({ email }) => email === user.email).role
    );
  };

  setItems = (organizations = []) => {
    this.items = organizations;
  };

  get canSendEmails() {
    return (
      !!this.selected?.thirdParties?.gmail?.selected ||
      this.selected?.thirdParties?.smtp?.selected ||
      this.selected?.thirdParties?.mailgun?.selected
    );
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
