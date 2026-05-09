import { useCallback, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../../components/ui/alert-dialog';
import { LuDownload, LuUpload, LuLoader2 } from 'react-icons/lu';
import Page from '../../../components/Page';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';
import {
  downloadDatabaseBackup,
  restoreDatabase
} from '../../../utils/restcalls';
import { toast } from 'sonner';

function DatabaseSettings() {
  const { t } = useTranslation('common');
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const fileInputRef = useRef(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const response = await downloadDatabaseBackup();
      const blob = new Blob([JSON.stringify(response.data, null, 2)], {
        type: 'application/json'
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const date = new Date().toISOString().replace(/[:.]/g, '-');
      link.download = `mre_backup_${date}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      toast.success(t('Database backup downloaded successfully'));
    } catch (error) {
      console.error(error);
      toast.error(t('Failed to download database backup'));
    } finally {
      setSaving(false);
    }
  }, [t]);

  const handleFileSelect = useCallback((event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.json')) {
      toast.error(t('Please select a JSON backup file'));
      return;
    }

    setSelectedFile(file);
    setConfirmOpen(true);
    event.target.value = '';
  }, [t]);

  const handleRestore = useCallback(async () => {
    if (!selectedFile) return;

    setRestoring(true);
    setConfirmOpen(false);
    try {
      const text = await selectedFile.text();
      const data = JSON.parse(text);

      if (!data.version || !data.collections) {
        toast.error(t('Invalid backup file format'));
        return;
      }

      const result = await restoreDatabase(data);
      toast.success(
        t('Database restored successfully from backup dated {{date}}', {
          date: new Date(result.exportDate).toLocaleString()
        })
      );

      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } catch (error) {
      console.error(error);
      toast.error(t('Failed to restore database'));
    } finally {
      setRestoring(false);
      setSelectedFile(null);
    }
  }, [selectedFile, t]);

  return (
    <Page dataCy="databasePage">
      <Card>
        <CardHeader>
          <CardTitle>{t('Database')}</CardTitle>
          <CardDescription>
            {t('Save and restore your application data')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t('Save backup')}</h3>
            <p className="text-sm text-muted-foreground">
              {t(
                'Download a complete backup of all your data including tenants, properties, leases, rents, and settings'
              )}
            </p>
            <div className="mt-2">
              <Button
                onClick={handleSave}
                disabled={saving || restoring}
              >
                {saving ? (
                  <LuLoader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <LuDownload className="mr-2 h-4 w-4" />
                )}
                {saving ? t('Saving...') : t('Save database')}
              </Button>
            </div>
          </div>

          <div className="border-t pt-6">
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('Restore backup')}</h3>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Upload a previously saved backup file to restore all your data. This will replace all current data.'
                )}
              </p>
              <div className="mt-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Button
                  variant="destructive"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={saving || restoring}
                >
                  {restoring ? (
                    <LuLoader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <LuUpload className="mr-2 h-4 w-4" />
                  )}
                  {restoring ? t('Restoring...') : t('Load database')}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Are you sure?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'This will replace ALL current data with the backup file. This action cannot be undone. Make sure you have saved a backup of your current data first.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestore}>
              {t('Yes, restore')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

export default withAuthentication(DatabaseSettings);
