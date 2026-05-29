import { Component, useContext } from 'react';
import { Button } from './ui/button';
import config from '../config';
import { StoreContext } from '../store';
import useTranslation from 'next-translate/useTranslation';

// Wave-26: split into a class boundary (required to catch render errors)
// and a function-component fallback that uses i18n + the store. The class
// itself can't use hooks, so the translated strings + locale-aware Go Home
// live in the fallback.
function ErrorFallback({ error }) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);

  const handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  // Locale-aware Go Home: navigate to the user's selected realm's
  // /dashboard if we have one, otherwise to /signin. Pass the realm's
  // locale so Next.js doesn't briefly render the page in defaultLocale=en
  // before the store hydrates.
  const handleGoHome = () => {
    if (typeof window === 'undefined') return;
    const realm = store?.organization?.selected;
    const locale = realm?.locale;
    const target = realm?.name
      ? `${config.BASE_PATH}/${encodeURIComponent(realm.name)}/dashboard`
      : `${config.BASE_PATH}/signin`;
    // Next.js path-based locale routing: prepend the locale segment so the
    // page loads with the right language on first paint instead of flashing
    // English. Path is `/<locale><BASE_PATH>...`.
    const url = locale ? `/${locale}${target}` : target;
    window.location.assign(url);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 text-center">
      <h1 className="text-2xl font-semibold mb-4">
        {t('Something went wrong')}
      </h1>
      <p className="text-muted-foreground mb-6 max-w-md">
        {t('An unexpected error occurred. Please try reloading the page.')}
      </p>
      {process.env.NODE_ENV === 'development' && error && (
        <pre className="mb-6 p-4 bg-muted rounded text-left text-sm max-w-lg overflow-auto max-h-48">
          {error.message}
        </pre>
      )}
      <div className="flex gap-3">
        <Button variant="outline" onClick={handleGoHome}>
          {t('Go Home')}
        </Button>
        <Button onClick={handleReload}>{t('Reload Page')}</Button>
      </div>
    </div>
  );
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
