import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../../../components/ui/card';
import {
  deleteDocuments,
  fetchBuildings,
  fetchDocuments,
  fetchTenants,
  QueryKeys,
  updateDocument
} from '../../../utils/restcalls';
import {
  LuBuilding2,
  LuDownload,
  LuFile,
  LuFileText,
  LuImage,
  LuPencil,
  LuTrash,
  LuUser,
  LuUsers
} from 'react-icons/lu';
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { downloadDocument } from '../../../utils/fetch';
import { Input } from '../../../components/ui/input';
import moment from 'moment';
import Page from '../../../components/Page';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

/**
 * Settings → Αρχεία — every uploaded file in the realm, grouped by the entity
 * it belongs to (tenants / buildings / owners), with review (download),
 * inline rename, and delete. A flat ledger list per group — names lead,
 * metadata stays muted, actions appear at the row's end.
 */
function GroupHeader({ icon: Icon, label, count }) {
  return (
    <div className="flex items-center gap-2 pt-6 pb-2">
      <Icon className="size-4 text-ink-muted" aria-hidden="true" />
      <span className="text-title font-semibold text-ink">{label}</span>
      <span className="text-label text-ink-muted">({count})</span>
    </div>
  );
}

function FileRow({ doc, entityLabel, onRename, onDelete }) {
  const { t } = useTranslation('common');
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(doc.name || '');

  const mime = String(doc.mimeType || '');
  const Icon = mime.startsWith('image/')
    ? LuImage
    : mime === 'application/pdf'
      ? LuFileText
      : LuFile;

  return (
    <li className="flex items-center gap-3 py-2.5 border-b border-stone-line last:border-b-0">
      <Icon className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        {renaming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) {
                onRename(doc, value.trim());
                setRenaming(false);
              }
            }}
          >
            <Input
              autoFocus
              className="h-8 max-w-md"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
            <Button type="submit" size="sm" variant="secondary">
              {t('Save')}
            </Button>
          </form>
        ) : (
          <>
            <div className="text-sm font-medium text-ink truncate">
              {doc.name}
            </div>
            <div className="text-label text-ink-muted truncate">
              {entityLabel}
              {doc.createdDate
                ? ` · ${moment(doc.createdDate).format('DD/MM/YYYY')}`
                : ''}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('Download')}
          onClick={() =>
            downloadDocument({
              endpoint: `/documents/${doc._id}`,
              documentName: doc.name
            })
          }
        >
          <LuDownload className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('Rename')}
          onClick={() => {
            setValue(doc.name || '');
            setRenaming(true);
          }}
        >
          <LuPencil className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('Delete')}
          onClick={() => onDelete(doc)}
        >
          <LuTrash className="size-4 text-oxide" />
        </Button>
      </div>
    </li>
  );
}

function Files() {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [toDelete, setToDelete] = useState(null);

  const { data: documents = [], isLoading } = useQuery({
    queryKey: [QueryKeys.DOCUMENTS, 'all-files'],
    queryFn: () => fetchDocuments()
  });
  const { data: tenants = [] } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: () => fetchTenants()
  });
  const { data: buildings = [] } = useQuery({
    queryKey: [QueryKeys.BUILDINGS],
    queryFn: () => fetchBuildings()
  });

  const tenantName = useMemo(() => {
    const m = new Map();
    (Array.isArray(tenants) ? tenants : []).forEach((tn) =>
      m.set(String(tn._id), tn.name)
    );
    return m;
  }, [tenants]);
  const buildingName = useMemo(() => {
    const m = new Map();
    (Array.isArray(buildings) ? buildings : []).forEach((b) =>
      m.set(String(b._id), b.name)
    );
    return m;
  }, [buildings]);

  const groups = useMemo(() => {
    const files = (documents || []).filter((d) => d.type === 'file');
    const byDateDesc = (a, b) =>
      new Date(b.createdDate || 0) - new Date(a.createdDate || 0);
    return {
      tenants: files.filter((d) => d.tenantId).sort(byDateDesc),
      buildings: files.filter((d) => d.buildingId).sort(byDateDesc),
      owners: files.filter((d) => d.ownerKey).sort(byDateDesc)
    };
  }, [documents]);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: [QueryKeys.DOCUMENTS] }),
    [queryClient]
  );

  const renameMutation = useMutation({
    mutationFn: updateDocument,
    onSuccess: invalidate,
    onError: () => toast.error(t('Something went wrong'))
  });
  const deleteMutation = useMutation({
    mutationFn: deleteDocuments,
    onSuccess: () => {
      invalidate();
      toast.success(t('Document deleted'));
    },
    onError: () => toast.error(t('Something went wrong'))
  });

  const handleRename = useCallback(
    (doc, name) => renameMutation.mutate({ _id: doc._id, __v: doc.__v, name }),
    [renameMutation]
  );

  const totalFiles =
    groups.tenants.length + groups.buildings.length + groups.owners.length;

  return (
    <Page loading={isLoading} dataCy="settingsFilesPage">
      <ConfirmDialog
        title={t('Are you sure to remove this document?')}
        subTitle={toDelete?.name}
        open={!!toDelete}
        setOpen={(v) => !v && setToDelete(null)}
        onConfirm={() => {
          if (toDelete) deleteMutation.mutate([toDelete._id]);
          setToDelete(null);
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>{t('Files')}</CardTitle>
          <CardDescription>
            {t('All uploaded files, grouped by tenant, building and owner')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {totalFiles === 0 ? (
            <div className="text-ink-muted text-sm py-6 px-1">
              {t('No documents uploaded yet')}
            </div>
          ) : (
            <>
              {groups.tenants.length > 0 && (
                <>
                  <GroupHeader
                    icon={LuUser}
                    label={t('Tenants')}
                    count={groups.tenants.length}
                  />
                  <ul>
                    {groups.tenants.map((doc) => (
                      <FileRow
                        key={doc._id}
                        doc={doc}
                        entityLabel={
                          tenantName.get(String(doc.tenantId)) ||
                          t('Tenant')
                        }
                        onRename={handleRename}
                        onDelete={setToDelete}
                      />
                    ))}
                  </ul>
                </>
              )}
              {groups.buildings.length > 0 && (
                <>
                  <GroupHeader
                    icon={LuBuilding2}
                    label={t('Buildings')}
                    count={groups.buildings.length}
                  />
                  <ul>
                    {groups.buildings.map((doc) => (
                      <FileRow
                        key={doc._id}
                        doc={doc}
                        entityLabel={
                          buildingName.get(String(doc.buildingId)) ||
                          t('Building')
                        }
                        onRename={handleRename}
                        onDelete={setToDelete}
                      />
                    ))}
                  </ul>
                </>
              )}
              {groups.owners.length > 0 && (
                <>
                  <GroupHeader
                    icon={LuUsers}
                    label={t('Owners')}
                    count={groups.owners.length}
                  />
                  <ul>
                    {groups.owners.map((doc) => (
                      <FileRow
                        key={doc._id}
                        doc={doc}
                        entityLabel={String(doc.ownerKey || '').replace(
                          /^n:/,
                          ''
                        ).split('|')[0]}
                        onRename={handleRename}
                        onDelete={setToDelete}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}

export default withAuthentication(Files);
