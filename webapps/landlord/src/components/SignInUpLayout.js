import config from '../config';
import useTranslation from 'next-translate/useTranslation';

/*
 * SignInUpLayout — DESIGN.md auth shell.
 *
 * Type-only branding, no illustration. Cream body. The wordmark sits in the
 * top-left of the page; the form centers in the viewport with a generous
 * gutter on either side. Reads as a quiet sign-in to a tool, not as a
 * marketing landing page.
 *
 * Earlier revision had a cobalt-navy panel + smiling-houses illustration on
 * the left half. Removed: it was the generic property-tech SaaS reflex
 * PRODUCT.md flags as the absolute first anti-reference.
 */
export default function SignInUpLayout({ children }) {
  const { t } = useTranslation('common');

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 py-5 md:px-10">
        <div className="text-title font-medium text-ink tracking-tight">
          {config.APP_NAME}
        </div>
        <div className="text-label text-ink-muted">{t('for landlords')}</div>
      </header>
      <main className="flex-1 flex items-start sm:items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
