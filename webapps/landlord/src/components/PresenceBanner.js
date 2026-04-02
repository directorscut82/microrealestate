import { Alert } from './ui/alert';
import { LuEye } from 'react-icons/lu';
import useTranslation from 'next-translate/useTranslation';

export default function PresenceBanner({ viewers = [] }) {
  const { t } = useTranslation('common');

  if (!viewers.length) return null;

  const names = viewers.map((v) => v.name).join(', ');

  return (
    <Alert className="flex items-center gap-2 mb-4 bg-info/10 border-info text-info-foreground">
      <LuEye className="size-4 shrink-0" />
      <span className="text-sm">{names} {viewers.length === 1 ? t('is also viewing this page') : t('are also viewing this page')}</span>
    </Alert>
  );
}
