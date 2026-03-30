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
import Head from 'next/head';
import { InjectStoreContext } from '../store';
import moment from 'moment';
import { Roboto } from 'next/font/google';
import { useEffect } from 'react';

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
  subsets: ['latin', 'latin-ext']
});

function MyApp(props) {
  const { Component, pageProps } = props;
  moment.locale(pageProps?.__lang ?? 'en');

  useEffect(() => {
    // Remove the server-side injected CSS (legacy MUI cleanup).
    const jssStyles = document.querySelector('#jss-server-side');
    if (jssStyles) {
      jssStyles.parentElement.removeChild(jssStyles);
    }
  }, []);

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
      <main className={roboto.className}>
        <QueryClientProvider client={queryClient}>
          <InjectStoreContext initialData={pageProps.initialState?.store}>
            <Application {...pageProps}>
              <Component {...pageProps} />
            </Application>
          </InjectStoreContext>
        </QueryClientProvider>
      </main>
    </>
  );
}

export default MyApp;
