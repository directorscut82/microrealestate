export async function getServerSideProps({ params, req }) {
  // T2.2: prepend the locale segment so next-translate applies the
  // realm's locale on the FIRST response. Without it the redirect lands
  // on `/<org>/dashboard` and next-translate uses defaultLocale='en'.
  // The `locale` cookie is set by signin.js after the user authenticates
  // (and persists across reloads), so we trust it here.
  const cookieMatch = req?.headers?.cookie?.match(/(?:^|; )locale=([^;]+)/);
  const cookieLocale = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  const localePrefix = cookieLocale ? `/${cookieLocale}` : '';
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
