import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Textarea } from '../../ui/textarea';
import ResponsiveDialog from '../../ResponsiveDialog';
import { useCallback } from 'react';
import useTranslation from 'next-translate/useTranslation';

export default function ApplicationShowDialog({
  open,
  setOpen,
  data: appcredz,
  onClose
}) {
  const { t } = useTranslation('common');

  const handleClose = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose, setOpen]);

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      renderHeader={() => t('Created credentials')}
      renderContent={() => (
        <div className="pt-6 space-y-4">
          <div>
            {t(
              "Copy the credentials below and keep them safe. You won't be able to retrieve them again."
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="clientId">{t('clientId')}</Label>
            <Input id="clientId" value={appcredz?.clientId || ''} readOnly />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clientSecret">{t('clientSecret')}</Label>
            <Textarea id="clientSecret" value={appcredz?.clientSecret || ''} rows={6} readOnly />
          </div>
        </div>
      )}
      renderFooter={() => <Button onClick={handleClose}>{t('Close')}</Button>}
    />
  );
}
