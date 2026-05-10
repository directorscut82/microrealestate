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
import config from '../config';
import ErrorBoundary from '../components/ErrorBoundary';
import Head from 'next/head';
import { InjectStoreContext } from '../store';
import moment from 'moment';
import { Roboto } from 'next/font/google';
import { ThemeProvider } from 'next-themes';

const queryClient = new QueryClient();

const APP_TITLE = [config.APP_NAME, 'Landlord'];
if (config.NODE_ENV === 'development') {
  APP_TITLE.push('DEV');
} else if (config.DEMO_MODE) {
  APP_TITLE.push('DEMO');
}

const roboto = Roboto({
  weight: ['300', '400', '500', '700'],
  display: 'swap',
  subsets: ['latin', 'latin-ext'],
  variable: '--font-roboto'
});

function MyApp(props) {
  const { Component, pageProps } = props;
  moment.locale(pageProps?.__lang ?? 'en');

  // Apply font CSS variable to <html> so Radix portals inherit it
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add(roboto.variable);
  }

  return (
    <>
      <Head>
        <title>{APP_TITLE.join(' - ')}</title>
        <meta name="theme-color" content="#2563eb" />
        <meta
          name="viewport"
          content="minimum-scale=1, initial-scale=1, width=device-width"
        />
        <link rel="shortcut icon" href={`${config.BASE_PATH}/favicon.svg`} />
      </Head>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-primary focus:text-primary-foreground">Skip to content</a>
      <main id="main-content" className={`${roboto.variable} font-sans`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          themes={['light', 'dark', 'midnight', 'forest', 'sunset']}
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
