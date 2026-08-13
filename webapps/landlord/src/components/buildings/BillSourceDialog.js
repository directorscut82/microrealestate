import { useEffect, useMemo, useState } from 'react';
import { LuDownload, LuFileText, LuScanLine } from 'react-icons/lu';
import { Button } from '../ui/button';
import { fetchDocumentObjectUrl } from '../../utils/fetch';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import ResponsiveDialog from '../ResponsiveDialog';
import { providerLabel } from '../../utils/billExpensePrefill';
import useTranslation from 'next-translate/useTranslation';

/**
 * The archived λογαριασμός (or απόδειξη) beside the data that was read off it.
 *
 * Layout is a spec, not a preference: the document on the LEFT, the extracted
 * fields on the RIGHT. Same arrangement as the import card, deliberately — the
 * landlord approved that one and a second layout for the same job would be a
 * second thing to keep consistent.
 *
 * WHERE THE BYTES AND THE DATA LIVE (measured on the live realm 2026-08-13):
 *   · bytes  → Backblaze B2, key `<realm name>-<realmId>/bills/<billId>/<file>`,
 *              stored on `Bill.pdfUrl` (or `receipts[].proofUrl` for an απόδειξη).
 *   · data   → the same Bill document: provider, billingId, totalAmount, period,
 *              issueDate, dueDate, term, rfCode, paymentCode, and `ocrText`
 *              (the raw OCR, ~1.7KB on the real ΔΕΗ bill).
 *   · served → `GET /documents/by-key`, which 403s any key outside the realm's own
 *              prefix. That prefix is the tenant-isolation boundary, so the key is
 *              always the one stored on the Bill and never assembled here.
 *
 * A PDF cannot be rendered as an <img>, so it goes in an <iframe> — the browser's
 * own viewer. An image (a bot photo / phone scan) renders directly.
 */
export default function BillSourceDialog({ open, setOpen, bill, kind = 'bill' }) {
  const { t } = useTranslation('common');
  const [objectUrl, setObjectUrl] = useState(null);
  const [mimeType, setMimeType] = useState('');
  const [error, setError] = useState(null);

  const key = useMemo(() => {
    if (!bill) return null;
    if (kind === 'receipt') {
      // Newest receipt first — installments append, and the most recent proof is
      // the one a landlord opening «Απόδειξη» expects to see.
      const proofs = (bill.receipts || [])
        .filter((r) => r?.proofUrl)
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      // `paymentProofUrl` is the pre-installments single-shot field; still the only
      // proof on bills confirmed before Slice 6, so it must remain a fallback.
      return proofs[0]?.proofUrl || bill.paymentProofUrl || null;
    }
    return bill.pdfUrl || null;
  }, [bill, kind]);

  useEffect(() => {
    if (!open || !key) return;
    let revoked = false;
    let created = null;
    setError(null);
    setObjectUrl(null);
    fetchDocumentObjectUrl(key)
      .then(({ url, mimeType: mt }) => {
        if (revoked) {
          // The dialog closed while the fetch was in flight. Revoke immediately or
          // the blob is held for the life of the tab with no handle to free it.
          URL.revokeObjectURL(url);
          return;
        }
        created = url;
        setObjectUrl(url);
        setMimeType(mt);
      })
      .catch((err) => {
        // Say WHICH failure. A 403 means the key is outside this realm's prefix
        // (a data problem worth reporting); a 404 means the object is gone from B2
        // while the Bill still points at it — silently showing an empty frame for
        // either would read as "the bill has no document".
        const status = err?.response?.status;
        setError(
          status === 404
            ? t('The file is no longer in storage')
            : status === 403
              ? t('You are not allowed to open this file')
              : t('The file could not be opened')
        );
      });
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [open, key, t]);

  const isPdf =
    mimeType === 'application/pdf' || /\.pdf$/i.test(String(key || ''));
  // «OCR» when the source is a photograph, «PDF» when it is the issuer's file.
  // The distinction matters to the landlord: an OCR'd figure was read off an
  // image and is worth double-checking against the picture beside it.
  const sourceLabel = isPdf ? t('PDF') : t('OCR');

  const fmtDate = (d) => (d ? moment(d).format('DD/MM/YYYY') : '—');

  const rows = useMemo(() => {
    if (!bill) return [];
    const period =
      bill.periodStart || bill.periodEnd
        ? `${fmtDate(bill.periodStart)} – ${fmtDate(bill.periodEnd)}`
        : null;
    return [
      [t('Provider'), providerLabel(bill.provider) || bill.provider || '—'],
      [t('Supply number'), bill.billingId || '—'],
      [t('Billing period'), period],
      [t('Issue date'), bill.issueDate ? fmtDate(bill.issueDate) : null],
      [t('Due date'), bill.dueDate ? fmtDate(bill.dueDate) : null],
      [t('Payment code'), bill.paymentCode || null],
      [t('RF code'), bill.rfCode || null]
      // Rows whose value is null are dropped below rather than rendered as «—»:
      // an absent field on the document should not look like a field that was read
      // and came back empty.
    ].filter(([, v]) => v !== null && v !== undefined);
  }, [bill, t]);

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      className="sm:max-w-4xl"
      renderHeader={() => (
        <div className="flex items-center gap-2 min-w-0">
          {isPdf ? (
            <LuFileText className="size-4 shrink-0 text-ink-muted" />
          ) : (
            <LuScanLine className="size-4 shrink-0 text-ink-muted" />
          )}
          <span className="truncate">
            {kind === 'receipt' ? t('Payment receipt') : t('Bill')}
            {' · '}
            {sourceLabel}
          </span>
        </div>
      )}
      renderContent={() => (
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-5">
          {/* LEFT — the document itself. */}
          <div className="min-w-0">
            {error ? (
              <div className="rounded-md border border-stone-line bg-muted/30 p-6 text-sm text-oxide">
                {error}
              </div>
            ) : !objectUrl ? (
              <div className="rounded-md border border-stone-line bg-muted/30 h-80 flex items-center justify-center text-sm text-ink-muted">
                {t('Loading...')}
              </div>
            ) : isPdf ? (
              <div className="space-y-2">
                <iframe
                  src={objectUrl}
                  title={t('Bill')}
                  data-cy="billPdfFrame"
                  className="w-full h-[70vh] min-h-80 rounded-md border border-stone-line bg-white"
                />
                {/* A PDF in an <iframe> renders through the BROWSER's own viewer,
                    which some builds ship without (headless Chromium has none at
                    all, which is why an automated screenshot shows this pane
                    blank). Never leave the document unreachable when that happens:
                    this opens the same blob in a tab, where the viewer is the
                    user's own. */}
                <a
                  href={objectUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-cy="billOpenInTab"
                  className="text-label text-ink-muted underline underline-offset-2 hover:text-ink"
                >
                  {t('Open in a new tab')}
                </a>
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={objectUrl}
                alt={t('Bill')}
                className="w-full max-h-[70vh] object-contain rounded-md border border-stone-line bg-white"
              />
            )}
          </div>

          {/* RIGHT — what was extracted from it. */}
          <div className="min-w-0 space-y-4">
            <div>
              <div className="text-label text-ink-muted">{t('Total')}</div>
              <div className="text-display font-display text-ink tabular-nums">
                <NumberFormat value={bill?.totalAmount} />
              </div>
            </div>

            {/* `min-w-0` on the grid AND on the value cell: without it the 1fr
                column refuses to shrink below its content, so a billing period
                rendered as «31/05/202» and a 25-character RF code lost its last
                six characters instead of wrapping. A truncated payment code is
                worse than useless — it looks like a value the landlord can read
                off and type into their bank. */}
            <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              {rows.map(([label, value]) => (
                <DataRow key={label} label={label} value={value} />
              ))}
            </dl>

            {objectUrl ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // Reuse the blob already in memory rather than re-requesting the
                  // object — the file is up to ~845KB.
                  const a = document.createElement('a');
                  a.href = objectUrl;
                  a.download = String(key).split('/').pop() || 'bill';
                  a.click();
                }}
              >
                <LuDownload className="mr-1.5 size-4" />
                {t('Download')}
              </Button>
            ) : null}

            {bill?.ocrText ? (
              <details className="text-label">
                <summary className="cursor-pointer text-ink-muted hover:text-ink">
                  {t('Recognised text')}
                </summary>
                {/* The raw OCR, so a figure that looks wrong can be checked against
                    what the recogniser actually read — not just against the image. */}
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-stone-line bg-muted/30 p-2 text-[11px] leading-snug text-ink-muted">
                  {bill.ocrText}
                </pre>
              </details>
            ) : null}
          </div>
        </div>
      )}
    />
  );
}

/** One label/value pair of the extracted-data list. */
function DataRow({ label, value }) {
  return (
    <>
      <dt className="text-ink-muted whitespace-nowrap">{label}</dt>
      <dd className="min-w-0 break-words text-ink tabular-nums">{value}</dd>
    </>
  );
}
