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
import { LuDownload, LuLoader2, LuUpload } from 'react-icons/lu';
import moment from 'moment';
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
  const [backupMeta, setBackupMeta] = useState(null);
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

  const handleFileSelect = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (!file.name.endsWith('.json')) {
        toast.error(t('Please select a JSON backup file'));
        return;
      }

      // Read the header BEFORE opening the confirm dialog. The dialog used to know
      // only the filename, so «Yes, restore» was approved blind: a file named
      // backup.json could be last week's, or another organisation's. The server
      // aborts a cross-realm restore before deleting anything
      // (databasemanager.ts:188) and rejects a bad version, but the landlord should
      // see WHAT they are about to overwrite their data with, not find out after.
      let meta = null;
      try {
        const parsed = JSON.parse(await file.text());
        meta = {
          exportDate:
            typeof parsed?.exportDate === 'string' ? parsed.exportDate : '',
          realmId: typeof parsed?.realmId === 'string' ? parsed.realmId : '',
          version: parsed?.version,
          counts: Object.entries(parsed?.collections || {})
            .filter(([, v]) => Array.isArray(v) && v.length)
            .map(([k, v]) => `${k}: ${v.length}`)
        };
      } catch {
        toast.error(t('Invalid backup file format'));
        event.target.value = '';
        return;
      }
      if (!meta.version || !meta.counts.length) {
        toast.error(t('Invalid backup file format'));
        event.target.value = '';
        return;
      }
      setBackupMeta(meta);
      setSelectedFile(file);
      setConfirmOpen(true);
      event.target.value = '';
    },
    [t]
  );

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
      if (result.status === 'restored_with_errors') {
        // D6 (audit-2026-07): a partial restore must warn loudly, not show a
        // green success — some collections did not fully reinsert.
        toast.error(
          t(
            'Restore completed with errors in: {{collections}}. Review and retry.',
            {
              collections: (result.failedCollections || []).join(', ')
            }
          )
        );
      } else {
        // i18n (2026-07): the date was `new Date(x).toLocaleString()` (US
        // M/D/YYYY on the Greek screen). exportDate is echoed straight back
        // from the CLIENT-UPLOADED backup JSON (databasemanager.ts:313) and
        // only `version`/`collections` are validated — so it can be absent.
        // moment(undefined) is TODAY, which on a destructive restore would
        // confidently misstate which snapshot just overwrote the realm.
        // 'HH:mm' not 'LT' on purpose: moment's el LT is a 12-hour clock
        // («5:05 ΜΜ») where Greek convention is 24-hour.
        // The truthiness check is load-bearing AND NOT redundant with
        // isValid(): moment(undefined).isValid() is TRUE (undefined means
        // "now"), so isValid() alone would let the absent case through.
        //
        // The `typeof === 'string'` check is load-bearing for the SAME reason
        // (2026-07 review): truthy + isValid() is not enough, because
        // `exportDate` is echoed back UNVALIDATED (databasemanager.ts:313
        // does `exportDate: payload.exportDate`, and the only client-side
        // gate is `data.version && data.collections`). A backup JSON carrying
        // `"exportDate": {}` — or `[]`, or a Mongo-extended-JSON
        // `{"$date": …}` — is truthy AND moment() reports it valid, resolving
        // to NOW. That prints TODAY's date as the snapshot identity on a
        // DESTRUCTIVE restore, i.e. exactly the misstatement this guard was
        // written to prevent. Verified against the repo's moment build:
        // moment({}).isValid() === true → «31/07/2026 21:10».
        //
        // TWO SENTENCES, not one with an "unknown date" noun substituted in:
        // every non-English carrier governs the {{date}} slot with a
        // preposition+article (el «της», fr «du», de «vom», pt «de», es
        // «del»), so dropping a nominative noun phrase there yields
        // case-broken text («…ασφαλείας της άγνωστη ημερομηνία»). The absent
        // case gets its own self-contained string instead.
        const _rawExportDate =
          typeof result.exportDate === 'string' ? result.exportDate.trim() : '';
        const _exportDate =
          _rawExportDate && moment(_rawExportDate).isValid()
            ? moment(_rawExportDate).format('L HH:mm')
            : null;
        toast.success(
          _exportDate
            ? t('Database restored successfully from backup dated {{date}}', {
                date: _exportDate
              })
            : t(
                'Database restored successfully. The backup file carries no export date.'
              )
        );
      }
      const recon = result.storageReconcile;
      // D1/D3 (audit-2026-07): restore runs the reconcile in DRY-RUN — it never
      // deletes. Report ALL unreferenced files as FOUND: orphansDeleted holds
      // the ones old enough to classify, orphansSkippedRecent holds recent ones
      // the TOCTOU guard protected — both are files in cloud storage no longer
      // referenced by the restored data, so the operator can review and clean
      // them up deliberately rather than have a restore silently destroy files
      // uploaded since the backup.
      const foundCount =
        (recon?.orphansDeleted?.length || 0) +
        (recon?.orphansSkippedRecent?.length || 0);
      if (foundCount) {
        toast.info(
          t(
            '{{count}} unreferenced files found in cloud storage (review in Documents; nothing was deleted)',
            {
              count: foundCount
            }
          )
        );
      }
      if (recon?.missingFiles?.length) {
        toast.warning(
          t(
            '{{count}} document(s) reference files that no longer exist in cloud storage',
            {
              count: recon.missingFiles.length
            }
          )
        );
      }

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
              {/* "complete backup of all your data" was false: `accounts` is
                  force-emptied for a per-realm backup (databasemanager.ts:89),
                  so user logins/passwords are NOT in the file. inboxitems and
                  telegramoffsets are now included; accounts still is not. */}
              {t(
                "Download a backup of this organisation's data — tenants, properties, leases, rents, bills, the pending inbox and settings. User accounts and passwords are NOT included."
              )}
            </p>
            <div className="mt-2">
              <Button onClick={handleSave} disabled={saving || restoring}>
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
            <AlertDialogTitle>{t('Are you sure?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'This will replace this organisation\u2019s data with the backup file — tenants, properties, leases, rents, bills and the pending inbox. User accounts and passwords are not touched. This action cannot be undone: save a backup of the current data first.'
              )}
            </AlertDialogDescription>
            {backupMeta && (
              <div className="mt-3 rounded-md border border-oxide/40 bg-oxide-tint/40 p-3 text-sm text-ink space-y-1">
                <div className="font-medium">
                  {t('You are restoring from this file')}
                </div>
                <div className="text-label">
                  {t('Backup date')}:{' '}
                  <span className="font-mono">
                    {backupMeta.exportDate
                      ? moment(backupMeta.exportDate).format('DD/MM/YYYY HH:mm')
                      : t('unknown')}
                  </span>
                </div>
                {backupMeta.realmId && (
                  <div className="text-label text-ink-muted">
                    {t('Organisation in the file')}:{' '}
                    <span className="font-mono">{backupMeta.realmId}</span>
                  </div>
                )}
                <div className="text-label text-ink-muted">
                  {backupMeta.counts.join(' · ')}
                </div>
              </div>
            )}
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
