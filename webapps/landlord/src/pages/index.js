import i18n from '../../i18n';
import { getStoreInstance, setupOrganizationsInStore } from '../store';

const ALLOWED_LOCALES = i18n.locales;

function pickLocalePrefix(req) {
  const cookieMatch = req?.headers?.cookie?.match(/(?:^|; )locale=([^;]+)/);
  const raw = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  if (!raw || !ALLOWED_LOCALES.includes(raw) || raw === i18n.defaultLocale) {
    return '';
  }
  return `/${raw}`;
}

export default function Index() {
  return null;
}

export async function getServerSideProps(context) {
  const store = getStoreInstance();
  const { req } = context;

  const { status } = await store.user.refreshTokens(context);
  if (status !== 200) {
    return {
      redirect: {
        destination: `${pickLocalePrefix(req)}/signin`,
        permanent: false
      }
    };
  }

  await setupOrganizationsInStore(undefined, store);
  if (!store.user.signedIn) {
    return {
      redirect: {
        destination: `${pickLocalePrefix(req)}/signin`,
        permanent: false
      }
    };
  }

  const selected = store.organization.selected;
  if (!selected?.name) {
    return {
      redirect: {
        destination: `${pickLocalePrefix(req)}/signin`,
        permanent: false
      }
    };
  }

  const orgLocale = selected.locale;
  const localePrefix =
    orgLocale && ALLOWED_LOCALES.includes(orgLocale) && orgLocale !== i18n.defaultLocale
      ? `/${orgLocale}`
      : '';
  return {
    redirect: {
      destination: `${localePrefix}/${selected.name}/dashboard`,
      permanent: false
    }
  };
}
