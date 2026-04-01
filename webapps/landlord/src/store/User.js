import * as jose from 'jose';

import { apiFetcher, authApiFetcher, setAccessToken } from '../utils/fetch';
import { isServer } from '@microrealestate/commonui/utils';

export const ADMIN_ROLE = 'administrator';
export const RENTER_ROLE = 'renter';
export const ROLES = [ADMIN_ROLE, RENTER_ROLE];

export default class User {
  constructor(store) {
    this._store = store;
    this.token = undefined;
    this.tokenExpiry = undefined;
    this.firstName = undefined;
    this.lastName = undefined;
    this.email = undefined;
    this.role = undefined;
  }

  get signedIn() {
    return !!this.token;
  }

  get isAdministrator() {
    return this.role === ADMIN_ROLE;
  }

  setRole(role) {
    this.role = role;
    this._store.notify();
  }

  setUserFromToken(accessToken) {
    const {
      account: { firstname, lastname, email },
      exp
    } = jose.decodeJwt(accessToken);
    this.firstName = firstname;
    this.lastName = lastname;
    this.email = email;
    this.token = accessToken;
    this.tokenExpiry = exp;
    setAccessToken(accessToken);
    this._store.notify();
  }

  async signUp(firstname, lastname, email, password) {
    try {
      await apiFetcher().post('/authenticator/landlord/signup', {
        firstname, lastname, email, password
      });
      return 200;
    } catch (error) {
      return error.response.status;
    }
  }

  async signIn(email, password) {
    try {
      const response = await apiFetcher().post(
        '/authenticator/landlord/signin',
        { email, password }
      );
      const { accessToken } = response.data;
      this.setUserFromToken(accessToken);
      return 200;
    } catch (error) {
      return error.response.status;
    }
  }

  async signOut() {
    try {
      await apiFetcher().delete('/authenticator/landlord/signout');
    } finally {
      this.firstName = null;
      this.lastName = null;
      this.email = null;
      this.token = null;
      this.tokenExpiry = undefined;
      setAccessToken(null);
      this._store.notify();
    }
  }

  async refreshTokens(context) {
    try {
      let response;
      if (isServer()) {
        const authFetchApi = authApiFetcher(context.req.headers.cookie);
        response = await authFetchApi.post(
          '/authenticator/landlord/refreshtoken'
        );
        const cookies = response.headers['set-cookie'];
        if (cookies) {
          context.res.setHeader('Set-Cookie', cookies);
        }
      } else {
        response = await apiFetcher().post(
          '/authenticator/landlord/refreshtoken'
        );
      }

      if (response?.data?.accessToken) {
        const { accessToken } = response.data;
        this.setUserFromToken(accessToken);
        return { status: 200 };
      } else {
        this.firstName = undefined;
        this.lastName = undefined;
        this.email = undefined;
        this.token = undefined;
        this.tokenExpiry = undefined;
        setAccessToken(null);
        this._store.notify();
      }
    } catch (error) {
      this.firstName = undefined;
      this.lastName = undefined;
      this.email = undefined;
      this.token = undefined;
      this.tokenExpiry = undefined;
      setAccessToken(null);
      this._store.notify();
      return { status: error?.response?.status, error };
    }
  }

  async forgotPassword(email) {
    try {
      await apiFetcher().post('/authenticator/landlord/forgotpassword', {
        email
      });
      return 200;
    } catch (error) {
      return error.response.status;
    }
  }

  async resetPassword(resetToken, password) {
    try {
      await apiFetcher().patch('/authenticator/landlord/resetpassword', {
        resetToken, password
      });
      return 200;
    } catch (error) {
      return error.response.status;
    }
  }
}
