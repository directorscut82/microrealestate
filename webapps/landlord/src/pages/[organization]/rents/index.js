import i18n from '../../../i18n';
import moment from 'moment';
import { getStoreInstance, setupOrganizationsInStore } from '../../../store';

const ALLOWED_LOCALES = i18n.locales;

function pickLocaleFromCookie(req) {
  const cookieMatch = req?.headers?.cookie?.match(/(?:^|; )locale=([^;]+)/);
  const raw = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  if (!raw || !ALLOWED_LOCALES.includes(raw)) return '';
  return raw;
}

// A bare /[org]/rents previously 404'd (only /rents/[yearMonth] existed).
// Redirect it to the CURRENT month's rents page so the route resolves, with
// the same realm-locale handling the [organization] index uses.
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
    // Unauthenticated / unknown org / API down — fall through to cookie locale.
  }

  const chosen = realmLocale || pickLocaleFromCookie(req);
  const localePrefix =
    chosen && chosen !== i18n.defaultLocale ? `/${chosen}` : '';
  const yearMonth = moment().format('YYYY.MM');

  return {
    redirect: {
      destination: `${localePrefix}/${params.organization}/rents/${yearMonth}`,
      permanent: false
    }
  };
}

export default function RentsIndex() {
  return null;
}
