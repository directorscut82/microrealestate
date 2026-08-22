import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  confirmInboxItem,
  fetchInboxImportPayload,
  fetchInboxOriginal,
  QueryKeys
} from '../utils/restcalls';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

/**
 * Normalise the server's Ε9 preview into the shape ImportE9Dialog's own state
 * owns. Exported and PURE so the contract test exercises this code rather than
 * a copy of it: the dialog renders `preview.owners` (PLURAL — its upload path
 * aggregates one owner per file across a batch), while the single-document
 * server view returns `owner` singular. Handing the raw response through threw
 * at render and ErrorBoundary took the page with it.
 */
export function normalizeE9Preview(preview) {
  if (!preview) return null;
  return { ...preview, owners: preview.owner ? [preview.owner] : [] };
}

/**
 * Deep-link handler for Telegram document imports.
 *
 * The bell's «Άνοιγμα» navigates to the page that already MOUNTS the import
 * dialog, carrying `?inboxImport=<itemId>`. This hook, used by that page:
 *   1. fetches the stored parse (+ fresh classification/preview) and the
 *      original PDF bytes;
 *   2. exposes `initialImport` for the dialog plus `open` once ready;
 *   3. `onImported` (wired INTO initialImport) consumes the inbox item so the
 *      bell clears — success only; closing without importing leaves the item
 *      pending, and `clear` strips the query param either way so a reopened
 *      page does not resurrect the dialog.
 *
 * `expectedKind` guards cross-kind links: a leaseImport id pasted onto the
 * buildings page must not open the Ε9 dialog over lease data.
 *
 * `requireOriginal` (Ε9): the dialog's confirm re-uploads the file, so without
 * the bytes the dialog would render a working-looking preview whose confirm
 * cannot succeed — refuse loudly instead. The lease dialog only uses the file
 * to archive the original onto the tenant (best-effort), so it opens without.
 */
export default function useInboxImport({ expectedKind, requireOriginal }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslation('common');
  const inboxImportId =
    typeof router.query?.inboxImport === 'string'
      ? router.query.inboxImport
      : null;
  const [originalBlob, setOriginalBlob] = useState(null);
  const [originalFailed, setOriginalFailed] = useState(false);

  const clear = useCallback(() => {
    const query = { ...router.query };
    delete query.inboxImport;
    router.replace({ pathname: router.pathname, query }, undefined, {
      shallow: true
    });
    setOriginalBlob(null);
    setOriginalFailed(false);
  }, [router]);

  const { data: payload, error: payloadError } = useQuery({
    queryKey: ['inbox-import-payload', inboxImportId],
    queryFn: () => fetchInboxImportPayload(inboxImportId),
    enabled: !!inboxImportId,
    retry: false,
    // FETCH ONCE per item. The app's QueryClient defaults to staleTime 0 with
    // refetch-on-focus, and this endpoint deliberately RECOMPUTES the
    // classification and the Ε9 preview on every call — so tabbing away to
    // check the PDF and back could return a materially different payload, give
    // `payload` a new identity, and re-fire the dialogs' hydration effects,
    // resetting merge strategies the landlord had already chosen. A review
    // dialog whose source data changes underneath it is a data-loss surface.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  });

  useEffect(() => {
    if (!inboxImportId || !payload) return;
    let cancelled = false;
    fetchInboxOriginal(inboxImportId)
      .then((blob) => {
        if (!cancelled) setOriginalBlob(blob);
      })
      .catch(() => {
        if (!cancelled) setOriginalFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [inboxImportId, payload]);

  // A dead link (consumed/dismissed item, wrong realm) or a wrong-kind link
  // must FAIL VISIBLY and clean the URL — not leave a dialog that never opens.
  useEffect(() => {
    if (!inboxImportId) return;
    if (payloadError) {
      toast.error(
        t(
          'This notification is no longer available — it may have been handled already.'
        )
      );
      clear();
    } else if (payload && payload.kind !== expectedKind) {
      toast.error(t('This notification belongs to a different page.'));
      clear();
    } else if (payload && requireOriginal && originalFailed) {
      toast.error(
        t(
          'The original file is not available — import it from the app instead.'
        )
      );
      clear();
    }
  }, [
    inboxImportId,
    payload,
    payloadError,
    originalFailed,
    expectedKind,
    requireOriginal,
    clear,
    t
  ]);

  const onImported = useCallback(() => {
    // Consume, then refresh the bell. Errors are non-blocking: the import
    // itself SUCCEEDED, and a stuck-pending notification is dismissible.
    confirmInboxItem(inboxImportId, {})
      .catch(() => {})
      .finally(() => {
        queryClient.invalidateQueries({ queryKey: [QueryKeys.INBOX] });
      });
  }, [inboxImportId, queryClient]);

  // Stable object identity — the dialogs hydrate in an effect keyed on this.
  const initialImport = useMemo(() => {
    if (!inboxImportId || !payload || payload.kind !== expectedKind) {
      return null;
    }
    // Wait for the original fetch to SETTLE before opening either dialog:
    // exposing early and re-exposing when the blob lands would re-fire the
    // dialog's hydration effect and reset whatever the user already touched.
    if (!originalBlob && !originalFailed) return null;
    if (requireOriginal && !originalBlob) return null;
    return {
      // Identity for the dialogs' hydrate-once guard.
      itemId: inboxImportId,
      parsed: payload.parsed
        ? { ...payload.parsed, classification: payload.classification }
        : null,
      // See normalizeE9Preview above for why this cannot be the raw response.
      // buildE9Preview is NOT the place to fix it — that would change the
      // upload route's response contract.
      preview: normalizeE9Preview(payload.preview),
      fileName: payload.sourceFileName || null,
      fileBlob: originalBlob,
      onImported
    };
  }, [
    inboxImportId,
    payload,
    originalBlob,
    originalFailed,
    expectedKind,
    requireOriginal,
    onImported
  ]);

  return { initialImport, open: !!initialImport, clear };
}
