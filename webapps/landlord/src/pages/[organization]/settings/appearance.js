import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../../../components/ui/card';
import { LuCheck, LuMonitor, LuMoon, LuSun } from 'react-icons/lu';
import Page from '../../../components/Page';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

const THEMES = [
  {
    id: 'system',
    icon: LuMonitor,
    preview: {
      sidebar: '#1e293b',
      bg: '#f8fafc',
      header: '#2563eb',
      card: '#ffffff',
      text: '#334155',
      accent: '#2563eb'
    }
  },
  {
    id: 'light',
    icon: LuSun,
    preview: {
      sidebar: '#1e293b',
      bg: '#f8fafc',
      header: '#2563eb',
      card: '#ffffff',
      text: '#334155',
      accent: '#2563eb'
    }
  },
  {
    id: 'dark',
    icon: LuMoon,
    preview: {
      sidebar: '#0f172a',
      bg: '#0f172a',
      header: '#3b82f6',
      card: '#1e293b',
      text: '#94a3b8',
      accent: '#3b82f6'
    }
  },
  {
    id: 'midnight',
    icon: null,
    preview: {
      sidebar: '#0c0a20',
      bg: '#13112b',
      header: '#a78bfa',
      card: '#1e1b3a',
      text: '#a5b4fc',
      accent: '#a78bfa'
    }
  },
  {
    id: 'forest',
    icon: null,
    preview: {
      sidebar: '#14261a',
      bg: '#f0fdf4',
      header: '#16a34a',
      card: '#ffffff',
      text: '#166534',
      accent: '#16a34a'
    }
  },
  {
    id: 'sunset',
    icon: null,
    preview: {
      sidebar: '#2d1b0e',
      bg: '#fffbf5',
      header: '#ea580c',
      card: '#ffffff',
      text: '#78350f',
      accent: '#ea580c'
    }
  }
];

function ThemeCard({ themeId, icon: Icon, preview, isSelected, onSelect, t }) {
  return (
    <button
      onClick={() => onSelect(themeId)}
      className={`group relative flex flex-col gap-3 rounded-xl border-2 p-3 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 ${
        isSelected
          ? 'border-primary shadow-md ring-2 ring-primary/20 bg-primary/5'
          : 'border-border hover:border-primary/40 bg-card'
      }`}
    >
      {isSelected && (
        <div className="absolute -top-2 -right-2 rounded-full bg-primary p-1 shadow-sm">
          <LuCheck className="h-3 w-3 text-primary-foreground" />
        </div>
      )}
      <div
        className="w-full aspect-[4/3] rounded-lg overflow-hidden border shadow-sm"
        style={{ backgroundColor: preview.bg }}
      >
        <div className="flex h-full">
          <div
            className="w-1/4 h-full p-1.5 flex flex-col gap-1"
            style={{ backgroundColor: preview.sidebar }}
          >
            <div className="h-1.5 w-full rounded-full opacity-60" style={{ backgroundColor: preview.accent }} />
            <div className="h-1.5 w-3/4 rounded-full opacity-30" style={{ backgroundColor: preview.text }} />
            <div className="h-1.5 w-3/4 rounded-full opacity-30" style={{ backgroundColor: preview.text }} />
            <div className="h-1.5 w-3/4 rounded-full opacity-30" style={{ backgroundColor: preview.text }} />
          </div>
          <div className="flex-1 p-2 flex flex-col gap-1.5">
            <div className="h-2 w-20 rounded-sm" style={{ backgroundColor: preview.header }} />
            <div className="flex gap-1 flex-1">
              <div className="flex-1 rounded-md p-1.5" style={{ backgroundColor: preview.card, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                <div className="h-1.5 w-full rounded-full mb-1" style={{ backgroundColor: preview.text, opacity: 0.3 }} />
                <div className="h-1.5 w-2/3 rounded-full" style={{ backgroundColor: preview.text, opacity: 0.2 }} />
              </div>
              <div className="flex-1 rounded-md p-1.5" style={{ backgroundColor: preview.card, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                <div className="h-1.5 w-full rounded-full mb-1" style={{ backgroundColor: preview.text, opacity: 0.3 }} />
                <div className="h-1.5 w-2/3 rounded-full" style={{ backgroundColor: preview.text, opacity: 0.2 }} />
              </div>
            </div>
            <div className="h-4 w-14 rounded-md self-end" style={{ backgroundColor: preview.accent }} />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        <span className="text-sm font-medium">{t(themeId)}</span>
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
          <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
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
