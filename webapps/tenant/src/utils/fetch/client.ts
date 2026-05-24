'use client';
import axios, { AxiosError, AxiosInstance } from 'axios';
import getEnv from '../env/client';

const withCredentials = getEnv('CORS_ENABLED') === 'true';
const baseURL = getEnv('GATEWAY_URL') || 'http://localhost';

let apiFetcher: AxiosInstance;

export default function useApiFetcher() {
  if (apiFetcher) {
    return apiFetcher;
  }

  apiFetcher = axios.create({
    baseURL,
    withCredentials
  });
  apiFetcher.interceptors.response.use(
    (response) => response,
    (error) => {
      // Only force-redirect on real auth errors from a real response.
      if (
        error instanceof AxiosError &&
        [401, 403].includes(error.response?.status as number)
      ) {
        // The /signedin endpoint represents the in-flight OTP check itself;
        // redirecting on its 401 would interrupt the user's verification flow.
        if (!error.config?.url?.includes('/signedin')) {
          window.location.href = `${getEnv('BASE_PATH') || ''}/signin`;
          throw new axios.Cancel('Operation canceled force login');
        }
      }
      return Promise.reject(error);
    }
  );
  return apiFetcher;
}
