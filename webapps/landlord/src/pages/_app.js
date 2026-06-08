import '../styles/globals.css';
import 'moment/locale/fr';
import 'moment/locale/pt';
import 'moment/locale/de';
import 'moment/locale/el';
import 'moment/locale/es';
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';
import 'react-awesome-lightbox/build/style.css';
import '../components/PdfViewer/pdfviewer.css';
import '../components/RichTextEditor/richtexteditor.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Application from '../components/Application';
import { applyZodTranslator } from '../utils/zodErrorMap';
import config from '../config';
import ErrorBoundary from '../components/ErrorBoundary';
import Head from 'next/head';
import { InjectStoreContext } from '../store';
import moment from 'moment';
import { IBM_Plex_Mono, Manrope } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import { useEffect } from 'react';
import useTranslation from 'next-translate/useTranslation';

const queryClient = new QueryClient();

const APP_TITLE = [config.APP_NAME, 'Landlord'];
if (config.NODE_ENV === 'development') {
  APP_TITLE.push('DEV');
} else if (config.DEMO_MODE) {
  APP_TITLE.push('DEMO');
}

// Manrope carries everything: page titles, body, buttons, tables, labels.
// Warm humanist sans with first-class Greek glyphs. Hierarchy comes from
// size + weight (400 body, 500 emphasis), not from a separate display family.
const manrope = Manrope({
  weight: ['300', '400', '500', '600'],
  display: 'swap',
  subsets: ['latin', 'latin-ext', 'greek'],
  variable: '--font-sans'
});

// IBM Plex Mono carries currency cells and any column where numbers stack.
// Warmer / less terminal than JetBrains Mono. Tabular numerals enabled via CSS.
const plexMono = IBM_Plex_Mono({
  weight: ['400', '500'],
  display: 'swap',
  subsets: ['latin', 'latin-ext'],
  variable: '--font-mono'
});

// `--font-display` kept as an alias of the sans variable so any remaining
// `font-display` consumers still resolve, but render in Manrope at the
// caller's weight, not in a different family. Drop the alias once consumers
// migrate to font-sans.
const fontVariables = `${manrope.variable} ${plexMono.variable}`;

function MyApp(props) {
  const { Component, pageProps } = props;
  const { t } = useTranslation('common');
  applyZodTranslator(t);
  moment.locale(pageProps?.__lang ?? 'en');

  // Apply font CSS variables to <html> so Radix portals inherit them.
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add(
      manrope.variable,
      plexMono.variable
    );
  }

  // Reset retired theme values from localStorage to 'system'.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem('theme');
      if (stored && !['light', 'dark', 'system'].includes(stored)) {
        window.localStorage.setItem('theme', 'system');
        // Strip stale theme class names from <html>.
        const root = document.documentElement;
        ['midnight', 'forest', 'sunset'].forEach((cls) =>
          root.classList.remove(cls)
        );
      }
    } catch {
      // localStorage may be unavailable (private mode, SSR boundary).
    }
  }, []);

  // T2.2 bootstrap: existing sessions wrote a `locale` cookie but not the
  // canonical Next.js `NEXT_LOCALE` cookie. Without `NEXT_LOCALE`, Next's
  // built-in i18n locale detection falls back to Accept-Language and a
  // Greek realm user with an English browser still gets redirected to
  // `/en/...` until they sign in again. Mirror the legacy cookie into
  // NEXT_LOCALE on first client render so the next non-prefixed deep
  // link picks the realm's locale on the very first request.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const cookies = document.cookie || '';
      const legacyMatch = cookies.match(/(?:^|; )locale=([^;]*)/);
      const nextMatch = cookies.match(/(?:^|; )NEXT_LOCALE=([^;]*)/);
      if (legacyMatch && legacyMatch[1] && !nextMatch) {
        const value = legacyMatch[1];
        document.cookie = `NEXT_LOCALE=${value};path=/;max-age=31536000`;
      }
    } catch {
      // document.cookie may be unavailable in some sandboxed contexts.
    }
  }, []);

  return (
    <>
      <Head>
        <title>{APP_TITLE.join(' - ')}</title>
        <meta name="theme-color" content="#f8f5ee" />
        <meta
          name="viewport"
          content="minimum-scale=1, initial-scale=1, width=device-width"
        />
        <link rel="shortcut icon" href={`${config.BASE_PATH}/favicon.svg`} />
      </Head>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-primary focus:text-primary-foreground"
      >
        {t('Skip to content')}
      </a>
      <main id="main-content" className={`${fontVariables} font-sans`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          themes={['light', 'dark']}
          enableSystem={true}
          disableTransitionOnChange
        >
          <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <InjectStoreContext initialData={pageProps.initialState?.store}>
                <Application {...pageProps}>
                  <Component {...pageProps} />
                </Application>
              </InjectStoreContext>
            </QueryClientProvider>
          </ErrorBoundary>
        </ThemeProvider>
      </main>
    </>
  );
}

export default MyApp;
