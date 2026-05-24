import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../../../components/ui/card';
import { LuCheck, LuMonitor, LuMoon, LuSun } from 'react-icons/lu';
import { cn } from '../../../utils';
import Page from '../../../components/Page';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

/*
 * Appearance — DESIGN.md theme picker.
 *
 * Three themes: system, light (the Pangrati Apartment), dark (same materials,
 * lights out). The previous experimental themes (midnight, forest, sunset)
 * have been retired in favor of one disciplined system.
 */

const THEMES = [
  {
    id: 'system',
    icon: LuMonitor,
    preview: {
      sidebar: 'oklch(96% 0.006 85)',
      bg: 'oklch(96% 0.006 85)',
      header: 'oklch(20% 0.012 240)',
      card: 'oklch(98% 0.004 85)',
      text: 'oklch(34% 0.010 240)',
      accent: 'oklch(48% 0.092 240)'
    }
  },
  {
    id: 'light',
    icon: LuSun,
    preview: {
      sidebar: 'oklch(96% 0.006 85)',
      bg: 'oklch(96% 0.006 85)',
      header: 'oklch(20% 0.012 240)',
      card: 'oklch(98% 0.004 85)',
      text: 'oklch(34% 0.010 240)',
      accent: 'oklch(48% 0.092 240)'
    }
  },
  {
    id: 'dark',
    icon: LuMoon,
    preview: {
      sidebar: 'oklch(17% 0.014 240)',
      bg: 'oklch(17% 0.014 240)',
      header: 'oklch(95% 0.006 85)',
      card: 'oklch(22% 0.014 240)',
      text: 'oklch(80% 0.008 85)',
      accent: 'oklch(68% 0.110 240)'
    }
  }
];

function ThemeCard({ themeId, icon: Icon, preview, isSelected, onSelect, t }) {
  return (
    <button
      onClick={() => onSelect(themeId)}
      className={cn(
        'group relative flex flex-col gap-3 rounded-lg border p-3 text-left',
        'transition-colors duration-base ease-out-quart',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sea focus-visible:ring-offset-2 focus-visible:ring-offset-cream',
        isSelected
          ? 'border-sea bg-sea-tint/40 indicator-active'
          : 'border-stone-line bg-bone hover:border-marble'
      )}
    >
      {isSelected && (
        <div className="absolute -top-2 -right-2 rounded-pill bg-sea p-1 shadow-floating">
          <LuCheck className="h-3 w-3 text-bone" />
        </div>
      )}
      <div
        className="w-full aspect-[4/3] rounded-md overflow-hidden border border-stone-line"
        style={{ backgroundColor: preview.bg }}
      >
        <div className="flex h-full">
          <div
            className="w-1/4 h-full p-1.5 flex flex-col gap-1"
            style={{ backgroundColor: preview.sidebar }}
          >
            <div
              className="h-1.5 w-full rounded-pill"
              style={{ backgroundColor: preview.accent, opacity: 0.7 }}
            />
            <div
              className="h-1.5 w-3/4 rounded-pill"
              style={{ backgroundColor: preview.text, opacity: 0.3 }}
            />
            <div
              className="h-1.5 w-3/4 rounded-pill"
              style={{ backgroundColor: preview.text, opacity: 0.3 }}
            />
            <div
              className="h-1.5 w-3/4 rounded-pill"
              style={{ backgroundColor: preview.text, opacity: 0.3 }}
            />
          </div>
          <div className="flex-1 p-2 flex flex-col gap-1.5">
            <div
              className="h-2 w-20 rounded-sm"
              style={{ backgroundColor: preview.header }}
            />
            <div className="flex gap-1 flex-1">
              <div
                className="flex-1 rounded-md p-1.5 border"
                style={{
                  backgroundColor: preview.card,
                  borderColor: preview.text + '30'
                }}
              >
                <div
                  className="h-1.5 w-full rounded-pill mb-1"
                  style={{ backgroundColor: preview.text, opacity: 0.3 }}
                />
                <div
                  className="h-1.5 w-2/3 rounded-pill"
                  style={{ backgroundColor: preview.text, opacity: 0.2 }}
                />
              </div>
              <div
                className="flex-1 rounded-md p-1.5 border"
                style={{
                  backgroundColor: preview.card,
                  borderColor: preview.text + '30'
                }}
              >
                <div
                  className="h-1.5 w-full rounded-pill mb-1"
                  style={{ backgroundColor: preview.text, opacity: 0.3 }}
                />
                <div
                  className="h-1.5 w-2/3 rounded-pill"
                  style={{ backgroundColor: preview.text, opacity: 0.2 }}
                />
              </div>
            </div>
            <div
              className="h-4 w-14 rounded-md self-end"
              style={{ backgroundColor: preview.accent }}
            />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-ink-muted" />}
        <span className="text-title font-semibold text-ink capitalize">
          {t(themeId)}
        </span>
      </div>
    </button>
  );
}

function Appearance() {
  const { t } = useTranslation('common');
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <Page dataCy="appearancePage">
      <Card>
        <CardHeader>
          <CardTitle>{t('Appearance')}</CardTitle>
          <CardDescription>
            {t('Choose a theme for the application')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-5 max-w-2xl">
            {THEMES.map(({ id, icon, preview }) => (
              <ThemeCard
                key={id}
                themeId={id}
                icon={icon}
                preview={preview}
                isSelected={theme === id}
                onSelect={setTheme}
                t={t}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </Page>
  );
}

export default withAuthentication(Appearance);
