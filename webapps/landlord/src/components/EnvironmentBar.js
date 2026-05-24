import { cn } from '../utils';
import config from '../config';
import useTranslation from 'next-translate/useTranslation';

/*
 * EnvironmentBar — DESIGN.md callout strip.
 *
 * Tinted strip across the top in either olive (demo) or sea (development).
 * Quiet. Earned. Not the same volume as the destructive/oxide alert.
 */
export default function EnvironmentBar({ className }) {
  const { t } = useTranslation('common');
  return config.DEMO_MODE || config.NODE_ENV === 'development' ? (
    <div
      className={cn(
        'text-label py-1 text-center font-medium tracking-wide text-ink',
        config.DEMO_MODE ? 'bg-olive-tint' : 'bg-sea-tint',
        className
      )}
    >
      {config.DEMO_MODE ? t('Demonstration mode') : t('Development mode')}
    </div>
  ) : null;
}
