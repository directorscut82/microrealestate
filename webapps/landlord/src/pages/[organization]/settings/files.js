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
  fetchDocumentPage,
  fetchDocumentTree,
  fetchTenants,
  QueryKeys,
  updateDocument
} from '../../../utils/restcalls';
import {
  LuBuilding2,
  LuChevronDown,
  LuChevronRight,
  LuDoorOpen,
  LuDownload,
  LuFile,
  LuFileQuestion,
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
 * Settings → Αρχεία — every uploaded file in the realm, as links, grouped per
 * building and per folder, with NOTHING loaded until a folder is opened.
 *
 * WHY IT WAS REWRITTEN. The previous version called `fetchDocuments()` with no
 * filter, so opening this page downloaded EVERY document row in the realm — over
 * years of bills that is thousands of rows on a page whose whole job is to help you
 * find one file. It also grouped by entity KIND (tenants / buildings / owners),
 * which answers "what sort of thing is this attached to" rather than the question a
 * landlord actually has: "what is on file for this building".
 *
 * The shape now:
 *   · `GET /documents/tree` returns COUNTS only — a few hundred bytes however many
 *     files exist. That is the entire initial load.
 *   · A CLOSED folder issues no request at all (`enabled: open`). That is the
 *     lazy-loading requirement, and it is a property of this component, not of the
 *     endpoint — mounting a folder open by default would quietly undo it.
 *   · Opening «Διαμερίσματα» or «Ενοικιαστές» fetches ONE request for the whole
 *     building (`propertyIds` / `tenantIds` sets), not one per apartment.
 *   · Pages of 50, and the button says how many of how many are shown. A silently
 *     truncated list reads as a complete one, which is how a landlord concludes a
 *     file was never uploaded.
 *
 * A folder with 0 files is not rendered: this page exists to find files, and empty
 * rows are noise you must read past. Those entities keep their own Έγγραφα tab.
 * «Χωρίς αντιστοίχιση» IS rendered when non-zero — documents whose entity no longer
 * resolves still exist and still cost storage, so hiding them would read as "no
 * stray files" when there are some.
 */

const PAGE_SIZE = 50;

function iconFor(doc) {
  const mime = String(doc?.mimeType || '');
  if (mime.startsWith('image/')) return LuImage;
  if (mime === 'application/pdf') return LuFileText;
  return LuFile;
}

/** One file. The NAME is the link — the landlord asked for files as links. */
function FileRow({ doc, onRename, onDelete }) {
  const { t } = useTranslation('common');
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(doc.name || '');
  const Icon = iconFor(doc);

  const open = useCallback(
    () =>
      downloadDocument({
        endpoint: `/documents/${doc._id}`,
        documentName: doc.name
      }),
    [doc]
  );

  return (
    <li
      className="flex items-center gap-3 border-b border-stone-line py-2 last:border-b-0"
      data-cy="fileBrowserRow"
    >
      <Icon className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
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
            <button
              type="button"
              onClick={open}
              className="block max-w-full truncate text-left text-sm font-medium text-ink underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >
              {doc.name}
            </button>
            <div className="truncate text-label text-ink-muted">
              {doc.createdDate ? moment(doc.createdDate).format('DD/MM/YYYY') : ''}
            </div>
            {(() => {
              // Kept from the previous version: on the only realm-wide file surface
              // an EXPIRED document must not look identical to a valid one. Same
              // 30-day threshold as the tenant-side row so the two agree.
              if (!doc.expiryDate) return null;
              const exp = moment(doc.expiryDate);
              if (!exp.isValid()) return null;
              const days = moment.duration(exp - moment()).asDays();
              if (days >= 30) return null;
              const expired = days < 0;
              return (
                <div
                  className={
                    expired
                      ? 'text-label font-medium text-oxide'
                      : 'text-label text-ink-muted'
                  }
                >
                  {expired
                    ? t('This document has expired')
                    : t('This document will expire {{relativeDate}}', {
                        relativeDate: exp.fromNow()
                      })}
                </div>
              );
            })()}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon" aria-label={t('Download')} onClick={open}>
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

/**
 * A folder header + its contents, revealed on click.
 *
 * Two modes, one component: a LEAF is given `fetchPage` and lists files; a CONTAINER
 * is given `children` and reveals nested folders. Both hide their contents while
 * closed, which is what keeps a building's sub-folders from issuing requests before
 * the landlord has asked for that building.
 */
function Folder({
  label,
  icon: Icon,
  count,
  depth = 0,
  cacheKey,
  fetchPage,
  onRename,
  onDelete,
  children
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState(1);

  const isLeaf = typeof fetchPage === 'function';
  const { data, isFetching } = useQuery({
    queryKey: [QueryKeys.DOCUMENTS, 'browser', cacheKey, pages],
    queryFn: () => fetchPage({ limit: PAGE_SIZE * pages, skip: 0 }),
    // The lazy-load guarantee. A closed folder never fetches.
    enabled: open && isLeaf
  });

  // An empty folder is not rendered at all — see the file docstring.
  if (!count) return null;

  const files = (Array.isArray(data) ? data : []).filter((d) => d.type === 'file');

  return (
    <div className="border-b border-stone-line last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-cy="fileBrowserFolder"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 py-2.5 pr-1 text-left hover:bg-muted/40"
        style={{ paddingLeft: `${depth * 22}px` }}
      >
        {open ? (
          <LuChevronDown className="size-3.5 shrink-0 text-ink-muted" />
        ) : (
          <LuChevronRight className="size-3.5 shrink-0 text-ink-muted" />
        )}
        <Icon className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span
          className={
            depth === 0
              ? 'min-w-0 flex-1 truncate text-sm font-semibold text-ink'
              : 'min-w-0 flex-1 truncate text-sm text-ink'
          }
        >
          {label}
        </span>
        <span className="shrink-0 rounded-full border border-stone-line bg-muted/60 px-2 text-label tabular-nums text-ink-muted">
          {count}
        </span>
      </button>

      {open ? (
        isLeaf ? (
          <div style={{ paddingLeft: `${depth * 22 + 22}px` }} className="pb-2 pr-1">
            {isFetching && !files.length ? (
              <div className="py-2 text-label italic text-ink-muted">
                {t('Loading...')}
              </div>
            ) : (
              <>
                <ul>
                  {files.map((doc) => (
                    <FileRow
                      key={doc._id}
                      doc={doc}
                      onRename={onRename}
                      onDelete={onDelete}
                    />
                  ))}
                </ul>
                {files.length < count ? (
                  <button
                    type="button"
                    onClick={() => setPages((p) => p + 1)}
                    disabled={isFetching}
                    data-cy="fileBrowserShowMore"
                    className="mt-1 text-label text-ink-muted underline underline-offset-2 hover:text-ink"
                  >
                    {isFetching
                      ? t('Loading...')
                      : t('Show more ({{shown}} of {{total}})', {
                          shown: String(files.length),
                          total: String(count)
                        })}
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div>{children}</div>
        )
      ) : null}
    </div>
  );
}

function Files() {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [toDelete, setToDelete] = useState(null);

  // The ONLY request on page open.
  const { data: tree, isLoading } = useQuery({
    queryKey: [QueryKeys.DOCUMENTS, 'tree'],
    queryFn: () => fetchDocumentTree()
  });

  // Needed to turn a building into its apartment / tenant id sets. Both are queries
  // the app already caches for other pages, so this is usually free — and neither
  // carries document bodies.
  const { data: buildings = [] } = useQuery({
    queryKey: [QueryKeys.BUILDINGS],
    queryFn: () => fetchBuildings()
  });
  const { data: tenants = [] } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: () => fetchTenants()
  });

  const idsByBuilding = useMemo(() => {
    const propertyIds = new Map();
    const buildingOfProperty = new Map();
    for (const b of Array.isArray(buildings) ? buildings : []) {
      const bid = String(b._id);
      const ids = (b.units || [])
        .map((u) => (u.propertyId ? String(u.propertyId) : null))
        .filter(Boolean);
      propertyIds.set(bid, ids);
      for (const pid of ids) buildingOfProperty.set(pid, bid);
    }
    const tenantIds = new Map();
    for (const tn of Array.isArray(tenants) ? tenants : []) {
      for (const tp of tn.properties || []) {
        const bid = tp?.propertyId
          ? buildingOfProperty.get(String(tp.propertyId))
          : null;
        if (!bid) continue;
        if (!tenantIds.has(bid)) tenantIds.set(bid, []);
        tenantIds.get(bid).push(String(tn._id));
        break;
      }
    }
    return { propertyIds, tenantIds };
  }, [buildings, tenants]);

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

  const total = Number(tree?.total) || 0;
  const buildingNodes = tree?.buildings || [];
  const rowProps = { onRename: handleRename, onDelete: setToDelete };

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
            {total === 0
              ? t('No documents uploaded yet')
              : // `count` must be a NUMBER: next-translate selects the `_one` variant
                // from its type, so passing String(total) defeated pluralisation and
                // the page read «1 αρχεία» — plural, for one file.
                t('{{count}} files — open a folder to load it', {
                  count: total
                })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {total === 0 ? null : (
            <div>
              {buildingNodes.map((node) => {
                const bid = node.buildingId;
                const propertyIds = idsByBuilding.propertyIds.get(bid) || [];
                const tenantIds = idsByBuilding.tenantIds.get(bid) || [];
                const folderCount = (key) =>
                  Number((node.folders || []).find((f) => f.key === key)?.count) || 0;
                return (
                  <Folder
                    key={bid}
                    label={node.name || t('Building')}
                    icon={LuBuilding2}
                    count={node.count}
                    cacheKey={`building:${bid}`}
                  >
                    <Folder
                      label={t('Bills and receipts')}
                      icon={LuFileText}
                      count={folderCount('building')}
                      depth={1}
                      cacheKey={`b:${bid}`}
                      fetchPage={({ limit, skip }) =>
                        fetchDocumentPage({ buildingId: bid, limit, skip })
                      }
                      {...rowProps}
                    />
                    <Folder
                      label={t('Apartments')}
                      icon={LuDoorOpen}
                      count={folderCount('properties')}
                      depth={1}
                      cacheKey={`p:${bid}`}
                      fetchPage={({ limit, skip }) =>
                        // The count came from the server; if the client cannot resolve
                        // the id set (buildings still loading) return nothing rather
                        // than an UNFILTERED request, which is how the apartment tab
                        // once listed the whole realm.
                        propertyIds.length
                          ? fetchDocumentPage({ propertyIds, limit, skip })
                          : Promise.resolve([])
                      }
                      {...rowProps}
                    />
                    <Folder
                      label={t('Tenants')}
                      icon={LuUser}
                      count={folderCount('tenants')}
                      depth={1}
                      cacheKey={`t:${bid}`}
                      fetchPage={({ limit, skip }) =>
                        tenantIds.length
                          ? fetchDocumentPage({ tenantIds, limit, skip })
                          : Promise.resolve([])
                      }
                      {...rowProps}
                    />
                  </Folder>
                );
              })}
              <Folder
                label={t('Owners')}
                icon={LuUsers}
                count={Number(tree?.owners?.count) || 0}
                cacheKey="owners"
                fetchPage={({ limit, skip }) =>
                  fetchDocumentPage({ bucket: 'owners', limit, skip })
                }
                {...rowProps}
              />
              <Folder
                label={t('Not linked to anything')}
                icon={LuFileQuestion}
                count={Number(tree?.unattached?.count) || 0}
                cacheKey="unattached"
                fetchPage={({ limit, skip }) =>
                  fetchDocumentPage({ bucket: 'unattached', limit, skip })
                }
                {...rowProps}
              />
              {/* Dangling: an entity id that no longer resolves. Reported as a count
                  and NOT as a folder — it cannot be listed by a cheap predicate, and
                  pretending it opens would be worse than saying plainly that these
                  files exist. Hiding them entirely is the absent-representation trap:
                  the page would read as "everything is accounted for" while storage
                  holds files nothing can reach. */}
              {Number(tree?.dangling?.count) > 0 ? (
                <div
                  className="flex items-center gap-2.5 py-2.5 text-label text-oxide"
                  data-cy="fileBrowserDangling"
                >
                  <LuFileQuestion className="size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    {t('Files whose building, apartment or tenant no longer exists')}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {tree.dangling.count}
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}

export default withAuthentication(Files);
