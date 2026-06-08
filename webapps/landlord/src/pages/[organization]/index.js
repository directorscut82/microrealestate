import i18n from '../../../i18n';
import { getStoreInstance, setupOrganizationsInStore } from '../../store';

const ALLOWED_LOCALES = i18n.locales;

function pickLocaleFromCookie(req) {
  const cookieMatch = req?.headers?.cookie?.match(/(?:^|; )locale=([^;]+)/);
  const raw = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  if (!raw || !ALLOWED_LOCALES.includes(raw)) return '';
  return raw;
}

export async function getServerSideProps(context) {
  const { params, req } = context;
  const store = getStoreInstance();

  let realmLocale = '';
  try {
    const { status } = await store.user.refreshTokens(context);
    if (status === 200) {
      await setupOrganizationsInStore(params.organization, store);
      const candidate = store.organization.selected?.locale;
      if (candidate && ALLOWED_LOCALES.includes(candidate)) {
        realmLocale = candidate;
      }
    }
  } catch {
    // Fall through to cookie fallback. Realm lookup can fail if the
    // user is unauthenticated, the org name is unknown, or the API is
    // unreachable; none of those should crash the redirect.
  }

  const chosen = realmLocale || pickLocaleFromCookie(req);
  const localePrefix =
    chosen && chosen !== i18n.defaultLocale ? `/${chosen}` : '';

  return {
    redirect: {
      destination: `${localePrefix}/${params.organization}/dashboard`,
      permanent: false
    }
  };
}

export default function Index() {
  return null;
}
