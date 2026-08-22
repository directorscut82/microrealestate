import {
  confirmInboxItem,
  dismissInboxItem,
  fetchBuildings,
  fetchInbox,
  QueryKeys
} from '../utils/restcalls';
import {
  LuAlertTriangle,
  LuBell,
  LuBuilding2,
  LuCalendarClock,
  LuCheck,
  LuCoins,
  LuFileText,
  LuFileWarning,
  LuHome,
  LuPlusCircle,
  LuReceipt,
  LuTimer,
  LuTrash2,
  LuWallet
} from 'react-icons/lu';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select';
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildExpensePrefill } from '../utils/billExpensePrefill';
import { Button } from './ui/button';
import { ExpenseFormDialog } from './buildings/ExpenseFormDialog';
import { Label } from './ui/label';
import moment from 'moment';
import NumberFormat from './NumberFormat';
import { Switch } from './ui/switch';
import { termMonthYearAccusative } from '../utils/greekMonths';
import useTranslation from 'next-translate/useTranslation';

/*
 * InboxBell — U4/U5 (Slice 4). Built against an approved local mock
 * (inbox-bell-popover.html), which is NOT in the repo: the mockups render real
 * tenant/owner data and are gitignored. This comment is the surviving spec.
 *
 * Bell + count badge in the top bar; popover lists pending InboxItems (bills
 * that arrived at the Telegram bot, parsed server-side by
 * telegramInboxScanner). Three card states:
 *   - matched: parsed fields + «✓ Αντιστοιχεί» + charge toggle → Καταχώρηση
 *   - no-match: building/expense selects + «➕ Νέα δαπάνη» (full parity with
 *     the import dialog — reuses the extracted ExpenseFormDialog pre-filled
 *     from OCR)
 *   - unreadable (parseError): explanation + dismiss-only
 * A failed confirm (e.g. duplicate bill → 409) shows inline on the card; the
 * item stays pending so nothing is lost.
 */

// Provider → expense `type` used to live here as a second copy of
// BillImportDialog's map, beside a second copy of its allocation logic. Both now
// come from utils/billExpensePrefill.

// Provider code → display name. These are Greek utility brands; the Greek
// name is the correct render in every locale (approved mock shows «ΔΕΗ»,
// not the raw code «DEH»).
const PROVIDER_LABEL = {
  deh: 'ΔΕΗ',
  eydap: 'ΕΥΔΑΠ',
  epa: 'ΕΠΑ'
};

// Icon per server notice code — falls back to the bell for unknown codes so a
// future server-side code renders sensibly before the client catches up.
const NOTICE_ICON = {
  'lease-expiry': LuCalendarClock,
  'energy-cert': LuFileWarning,
  'bill-due': LuReceipt,
  'unpaid-rents': LuTimer,
  'deposit-unreturned': LuWallet,
  'holdover-lease': LuCoins,
  'unit-vacant': LuHome,
  'inbox-ttl': LuTrash2
};

/*
 * NoticeCard — a kind:'notice' InboxItem. The message arrives server-composed
 * in Greek (the same string that went to Telegram), so it renders as-is, NOT
 * through t(). Only two actions exist: open the linked surface (when the
 * notice carries a link) and dismiss. Confirm/charge belong to bills only —
 * the server 422s a confirm on a notice.
 */
function NoticeCard({ item, onGone, onNavigate }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const organization = router.query?.organization;
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);

  const dismissMutation = useMutation({
    mutationFn: () => dismissInboxItem(item._id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.INBOX] });
      onGone();
    },
    onError: (err) => {
      setError(err?.response?.data?.message || t('Something went wrong'));
    }
  });

  const Icon = NOTICE_ICON[item.notice?.code] || LuBell;
  // The server composes ONE Greek string per notice and sends it to BOTH
  // Telegram and this bell. Telegram has no icon column, so the writers prefix
  // an emoji (⏱ 💰 ⚠️ 💶 🔴 🗑 ⏳ 📜) to carry the same signal there. In the
  // bell that emoji lands right next to NOTICE_ICON's own glyph and reads as
  // two clocks side by side (user-reported). Strip a LEADING pictograph here —
  // client-side, so Telegram keeps its prefix — and let the icon do the work.
  // Anchored to the start and bounded to the first few chars so an emoji inside
  // the sentence (or a Greek/€ character) is never touched.
  const message = String(item.notice?.message || '').replace(
    /^[⌚-⏿■-➿⬀-⯿️\u{1F300}-\u{1FAFF}]{1,3}\s*/u,
    ''
  );
  // notice.link comes off a server document and is interpolated into an href.
  // Today every writer builds it from an ObjectId or a formatted term
  // (`/tenants/{id}`, `/rents/2026.07`) and no HTTP route can write a notice —
  // so this is not currently reachable. But "not reachable today" is one
  // refactor away from "reachable", and an href is the wrong place to find out:
  // a stored `javascript:…` or `//evil.example` would navigate off-app.
  // Accept only an app-relative single-slash path.
  const rawLink = item.notice?.link;
  const safeLink =
    typeof rawLink === 'string' && /^\/(?!\/)[A-Za-z0-9._~/-]*$/.test(rawLink)
      ? rawLink
      : null;
  const link = organization && safeLink ? `/${organization}${safeLink}` : null;

  return (
    <div className="p-4 space-y-2 border-b last:border-b-0">
      {/* The message gets the FULL width. The timestamp used to sit in this row
          and «λίγα δευτερόλεπτα πριν» is wide in Greek, so it squeezed a
          3-line message into 4 wrapped lines and read as part of the sentence.
          It now shares the action row, which is otherwise empty on the left. */}
      <div className="flex items-start gap-2.5">
        <Icon className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
        {/* `leading-relaxed` + `break-words`: a digest notice is one long
            server-composed sentence («Απλήρωτα ενοίκια … : 8 — ΝΑΜΕ (524,00 €),
            …») that wrapped to 7 tight lines and read as a wall of text. The
            looser line-height makes it scannable; break-words stops a long
            unspaced token (an ΑΤΑΚ, an IBAN) from overflowing the 420px
            popover. */}
        <div className="min-w-0 flex-1 text-sm leading-relaxed text-ink break-words">
          {message}
        </div>
      </div>
      {error && (
        <div className="text-xs rounded-md bg-destructive/5 border border-destructive/30 p-2 text-destructive">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {moment(item.createdDate).fromNow()}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={dismissMutation.isPending}
            onClick={() => {
              setError(null);
              dismissMutation.mutate();
            }}
          >
            {t('Dismiss')}
          </Button>
          {link && (
            <Link href={link} passHref legacyBehavior>
              <Button asChild size="sm" variant="secondary">
                {/* Close the popover on navigate. InboxBell is mounted in
                  Layout (outside the page component), so a client-side route
                  change does NOT unmount it — without this the 420px popover
                  stays portaled over the destination page. */}
                <a onClick={onNavigate}>{t('Open')}</a>
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/*
 * ImportDocCard — kind:'leaseImport' / 'e9Import'. Built against the approved
 * ASCII mock (2026-08-22, in-chat): title/summary lines from the
 * server-composed importDoc.summary, a classification line for leases, and
 * «Άνοιγμα» deep-linking to the page that mounts the REAL import dialog
 * (?inboxImport=<id> → useInboxImport → the same review the in-app upload
 * shows). No import logic lives here — this card is a doorway, so a wrong
 * classification can only cost a dismiss.
 */
const LEASE_CLASSIFICATION_LABEL = {
  extension: 'Ανανέωση υπάρχοντος μισθωτηρίου',
  update: 'Ενημέρωση υπάρχοντος ενοικιαστή',
  new: 'Νέος ενοικιαστής',
  review: 'Χρειάζεται έλεγχο — αμφισημία αντιστοίχισης'
};

function ImportDocCard({ item, onGone, onNavigate }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const organization = router.query?.organization;
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);

  const dismissMutation = useMutation({
    mutationFn: () => dismissInboxItem(item._id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.INBOX] });
      onGone();
    },
    onError: (err) => {
      setError(err?.response?.data?.message || t('Something went wrong'));
    }
  });

  const isLease = item.kind === 'leaseImport';
  const Icon = isLease ? LuFileText : LuBuilding2;
  const summary = item.importDoc?.summary || {};
  const targetPath = isLease ? 'tenants' : 'buildings';
  const link = organization
    ? `/${organization}/${targetPath}?inboxImport=${item._id}`
    : null;

  // PROCESSING: the document arrived and the parser is still reading it. Same
  // shape as the bill processing card, named for what it is.
  if (item.status === 'processing') {
    return (
      <div
        className="p-4 space-y-2 border-b last:border-b-0"
        data-cy="inboxDocProcessing"
      >
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 text-sm font-medium text-ink">
            {t('Reading the document…')}
          </span>
          <span className="shrink-0 text-[11px] border rounded px-1.5 text-muted-foreground">
            Telegram
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative inline-block h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-ink/70 motion-safe:animate-inbox-scan" />
          </span>
          <span className="min-w-0 truncate">
            {item.sourceFileName || t('File')}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={dismissMutation.isPending}
            onClick={() => dismissMutation.mutate()}
          >
            {t('Dismiss')}
          </Button>
        </div>
      </div>
    );
  }

  // Unreadable: the parser refused — the parseError is server-composed Greek
  // naming what failed AND where to import manually.
  if (item.parseError) {
    return (
      <div className="p-4 space-y-2 border-b last:border-b-0">
        <div className="flex items-baseline gap-2">
          {/* Same uppercase as the pending card — the two are states of ONE
              card family and must not read as different kinds. */}
          <span className="text-sm font-medium uppercase text-muted-foreground">
            {isLease ? t('Lease declaration') : t('E9 declaration')}
          </span>
          <span className="text-[11px] border rounded px-1.5 text-muted-foreground">
            Telegram
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {moment(item.createdDate).fromNow()}
          </span>
        </div>
        <div className="text-sm rounded-md bg-destructive/5 border border-destructive/30 p-2.5 text-destructive">
          {item.parseError}
        </div>
        {item.sourceFileName && (
          <div className="text-xs text-muted-foreground font-mono">
            {item.sourceFileName}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={dismissMutation.isPending}
            onClick={() => dismissMutation.mutate()}
          >
            {t('Dismiss')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-4 space-y-2 border-b last:border-b-0"
      data-cy="inboxDocCard"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold uppercase">
          {isLease ? t('Lease declaration') : t('E9 declaration')}
        </span>
        <span className="text-[11px] border rounded px-1.5 text-muted-foreground">
          Telegram
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {moment(item.createdDate).fromNow()}
        </span>
      </div>
      <div className="flex items-start gap-2.5">
        <Icon className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          {summary.title && (
            <div className="text-sm font-medium text-ink break-words">
              {summary.title}
            </div>
          )}
          {summary.subtitle && (
            <div className="text-xs text-muted-foreground break-words">
              {summary.subtitle}
            </div>
          )}
        </div>
      </div>
      {isLease && summary.classification && (
        <div className="flex items-center gap-1.5 rounded-md bg-success/10 text-success text-xs px-2.5 py-1.5">
          <LuCheck className="size-3.5 shrink-0" />
          <span>
            {LEASE_CLASSIFICATION_LABEL[summary.classification] ||
              summary.classification}
          </span>
        </div>
      )}
      {error && (
        <div className="text-xs rounded-md bg-destructive/5 border border-destructive/30 p-2 text-destructive">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {t('Nothing is imported until you review it.')}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={dismissMutation.isPending}
            onClick={() => {
              setError(null);
              dismissMutation.mutate();
            }}
          >
            {t('Dismiss')}
          </Button>
          {link && (
            <Link href={link} passHref legacyBehavior>
              <Button asChild size="sm" variant="secondary">
                {/* Close the popover on navigate — InboxBell is mounted in
                    Layout, so a client-side route change does not unmount it. */}
                <a onClick={onNavigate}>{t('Open')}</a>
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function InboxCard({ item, buildings, onGone }) {
  const { t, lang } = useTranslation('common');
  const queryClient = useQueryClient();
  const [assignment, setAssignment] = useState(null); // {buildingId, expenseId}
  const [charge, setCharge] = useState(false);
  const [error, setError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  const parsed = useMemo(() => item.parsed || {}, [item.parsed]);
  // A suggestion is only a MATCH when it names an expense. A κοινόχρηστος
  // shared-meter hit identifies the BUILDING but has no δαπάνη yet (the poller
  // returns expenseId:''), so it must render the no-match card — which offers the
  // building/expense selects and «Νέα δαπάνη» — rather than a green «Αντιστοιχεί»
  // with an empty expense name. `buildingId` below still consumes the suggestion,
  // so the building arrives pre-selected either way.
  const rawSuggestion = item.suggestedMatch;
  const match = rawSuggestion?.expenseId ? rawSuggestion : null;
  // ASSIGNMENT FIRST, suggestion second. The suggestion is a PROPOSAL; once the
  // landlord touches the select, their choice is the answer. Reading the
  // suggestion first made the shared-meter building unoverridable: picking
  // building C left `buildingId` on the suggested B, the select still listed B's
  // expenses, and confirm posted {buildingId: B, expenseId: <B's>} — the bill
  // charged a building the landlord never chose.
  const buildingId = assignment?.buildingId || rawSuggestion?.buildingId || '';
  const expenseId = assignment?.expenseId || match?.expenseId || '';
  const selectedBuilding = (buildings || []).find(
    (b) => String(b._id) === String(buildingId)
  );
  const expenseOptions = (selectedBuilding?.expenses || []).filter(
    (e) => !e.endTerm
  );

  const invalidateAfterConfirm = useCallback(
    (charged) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.INBOX] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BILLS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      if (charged) {
        // Same set the import dialog invalidates after a tenant charge.
        queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
        queryClient.invalidateQueries({ queryKey: ['expense-breakdown'] });
        // C1 (destructive-write audit 2026-07): the bell is mounted on every
        // page, so a PropertyExpensesCard can be visible when a bill charge
        // lands. Its useFetchPropertyExpenses key was never invalidated, so it
        // kept pre-charge figures until navigation. Invalidate it here.
        queryClient.invalidateQueries({ queryKey: ['property-expenses'] });
      }
    },
    [queryClient]
  );

  const confirmMutation = useMutation({
    mutationFn: () =>
      confirmInboxItem(item._id, {
        buildingId,
        expenseId,
        chargeThisMonth: charge,
        expenseName:
          match?.expenseName ||
          expenseOptions.find((e) => String(e._id) === String(expenseId))?.name
      }),
    onSuccess: (row) => {
      invalidateAfterConfirm(charge);
      if (row?.chargeError) {
        setError(
          t(
            'Bills saved. {{failed}} could not charge tenants — charge them from the building statement.',
            { failed: 1 }
          )
        );
      }
      onGone();
    },
    onError: (err) => {
      setError(err?.response?.data?.message || t('Failed to save bills'));
    }
  });

  const dismissMutation = useMutation({
    mutationFn: () => dismissInboxItem(item._id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.INBOX] });
      onGone();
    },
    onError: (err) => {
      setError(err?.response?.data?.message || t('Something went wrong'));
    }
  });

  // Pre-filled synthetic expense for «➕ Νέα δαπάνη» (NO _id → add mode).
  //
  // This used to hardcode `allocationMethod: 'equal'` while the upload dialog ran a
  // thousandths-aware three-way for the SAME bills — so a κοινόχρηστο routed
  // through the bell split equally instead of by χιλιοστά (€50/50/50/50 where the
  // correct split over 400/300/200/100‰ is €80/60/40/20), silently, every month.
  // Both surfaces now call one helper; the reasoning lives there.
  const createPrefill = useMemo(
    () =>
      buildExpensePrefill({
        building: selectedBuilding,
        provider: parsed.provider,
        billingId: parsed.billingId,
        // A κοινόχρηστος hit carries no expense (expenseId:''), and the poller
        // sends the meter's own provider/label alongside it.
        sharedMatch: rawSuggestion?.sharedProvider
          ? {
              provider: rawSuggestion.sharedProvider,
              label: rawSuggestion.sharedLabel
            }
          : null,
        // An APARTMENT-meter hit targets that single flat (`single_unit`). Scoped
        // to the resolved building: a propertyId from another building fails the
        // server's cross-building guard with an undiagnosable toast, so if the
        // landlord overrides the building, fall back to an equal split.
        unitMatch:
          rawSuggestion?.unitPropertyId &&
          String(rawSuggestion.buildingId) === String(buildingId)
            ? { propertyId: rawSuggestion.unitPropertyId }
            : null
      }),
    [parsed, selectedBuilding, rawSuggestion, buildingId]
  );

  const handleExpenseCreated = useCallback(
    (updatedBuilding) => {
      if (!updatedBuilding) return;
      const expenses = updatedBuilding.expenses || [];
      const created =
        expenses.find(
          (e) =>
            parsed.billingId &&
            e.billingId &&
            e.billingId.replace(/[\s\-.]/g, '') ===
              parsed.billingId.replace(/[\s\-.]/g, '')
        ) || expenses[expenses.length - 1];
      if (created) {
        setAssignment({
          buildingId: String(updatedBuilding._id),
          expenseId: String(created._id)
        });
      }
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
    },
    [parsed.billingId, queryClient]
  );

  const busy = confirmMutation.isPending || dismissMutation.isPending;

  /**
   * PROCESSING card: the file has arrived and the OCR is still running.
   *
   * This state exists because the row is now written at RECEIPT rather than after the
   * parse. Before, the bell showed nothing for up to a minute and the landlord could not
   * tell «not received» from «still working» — so they re-sent bills, which minted
   * duplicate items to dismiss. It must come BEFORE the parseError branch and before the
   * normal card: a processing row has no parsed amount, so the normal card would render an
   * empty bill with a live «Καταχώρηση» button that the server (correctly) refuses.
   *
   * Dismiss stays available — a mis-sent file should be cancellable without waiting for a
   * parse to finish.
   */
  if (item.status === 'processing') {
    return (
      <div
        className="p-4 space-y-2 border-b last:border-b-0"
        data-cy="inboxProcessing"
      >
        {/* The title must not be truncated by the badge — «Διαβάζω τον λογαριασμό…» is
            longer than the panel is wide, and the first version rendered it as
            «Διαβάζω τον λογαριασμό…» clipped mid-word with the badge pushing it. The badge
            shrinks instead of the sentence. */}
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 text-sm font-medium text-ink">
            {t('Reading the bill…')}
          </span>
          <span className="shrink-0 text-[11px] border rounded px-1.5 text-muted-foreground">
            Telegram
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {/* A bar that MOVES. The first version used animate-pulse on a third-width block,
              which at this size rendered as a faint static line indistinguishable from a
              divider — the one signal this whole state exists to give, invisible. A
              travelling indeterminate bar reads as progress at a glance. */}
          <span className="relative inline-block h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-ink/70 motion-safe:animate-inbox-scan" />
          </span>
          <span className="min-w-0 truncate">
            {item.sourceFileName || t('File')}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {t('This can take up to a minute for a scanned page.')}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => dismissMutation.mutate()}
          >
            {t('Dismiss')}
          </Button>
        </div>
      </div>
    );
  }

  // Unreadable card: parse failed server-side — explain + dismiss only.
  if (item.parseError) {
    return (
      <div className="p-4 space-y-2 border-b last:border-b-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            {t('Unreadable')}
          </span>
          <span className="text-[11px] border rounded px-1.5 text-muted-foreground">
            Telegram
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {moment(item.createdDate).fromNow()}
          </span>
        </div>
        <div className="text-sm rounded-md bg-destructive/5 border border-destructive/30 p-2.5 text-destructive">
          {t(
            'The photo could not be read: {{error}}. Send a clearer shot to the bot or record the bill manually.',
            { error: item.parseError }
          )}
        </div>
        {item.sourceFileName && (
          <div className="text-xs text-muted-foreground font-mono">
            {item.sourceFileName}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => dismissMutation.mutate()}
          >
            {t('Dismiss')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3 border-b last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold uppercase">
          {PROVIDER_LABEL[parsed.provider] || parsed.provider || t('Bill')}
        </span>
        <span className="text-[11px] border rounded px-1.5 text-muted-foreground">
          Telegram
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {moment(item.createdDate).fromNow()}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div className="text-muted-foreground">{t('Amount')}</div>
        <div className="font-medium">
          <NumberFormat value={parsed.totalAmount} />
        </div>
        {parsed.billingId && (
          <>
            <div className="text-muted-foreground">{t('Billing ID')}</div>
            <div className="font-mono text-xs">{parsed.billingId}</div>
          </>
        )}
        {parsed.periodStart && parsed.periodEnd && (
          <>
            <div className="text-muted-foreground">{t('Period')}</div>
            <div>
              {moment(parsed.periodStart).format('L')} –{' '}
              {moment(parsed.periodEnd).format('L')}
            </div>
          </>
        )}
        {parsed.dueDate && (
          <>
            <div className="text-muted-foreground">{t('Due Date')}</div>
            <div>{moment(parsed.dueDate).format('L')}</div>
          </>
        )}
      </div>

      {/* BILL-IDENTITY (bill-OCR audit 2026-07): this same physical bill is
          already stored under a DIFFERENT term. Confirming from the bell would
          insert a second Bill and charge the tenants in a second month. The
          server computes it at read time (inboxmanager.list) so it is never
          stale, and only when the item already has a suggestedMatch scope. */}
      {item.duplicate && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-xs dark:bg-amber-950/30 dark:border-amber-800">
          <div className="flex items-start gap-1.5">
            <LuAlertTriangle className="size-3.5 shrink-0 mt-0.5 text-amber-600" />
            <div className="text-amber-800 dark:text-amber-200">
              <div className="font-medium">
                {t('This bill appears to be already imported')}
              </div>
              <div className="text-amber-700/80 dark:text-amber-300/80">
                {t('Already imported for {{month}}', {
                  // term is YYYYMMDDHH → first 6 chars are the month.
                  // The el carrier is «Έχει καταχωρηθεί για {{month}}» and
                  // «για» governs the ACCUSATIVE, so moment's nominative
                  // «Ιούλιος» would read «για Ιούλιος 2026». Must be
                  // «για Ιούλιο 2026» — hence the shared helper.
                  month: termMonthYearAccusative(item.duplicate.term, lang)
                })}
                {' — '}
                <NumberFormat value={item.duplicate.totalAmount} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* WARNINGS the ingest attached to the item.
          The Telegram scanner records these — currently the one that matters most:
          the bill's month falls OUTSIDE its expense's active range, so the engine
          charges that expense for no month at all and the amount lands on no
          surface. They were persisted onto the InboxItem and returned by GET /inbox
          (the handler returns the lean doc), and this component never read them — so
          the warning existed in the database and nowhere the landlord could see it.
          Which is the same absent-representation defect the warning itself exists to
          announce.
          The strings are already Greek: they are composed server-side beside the
          expense name and the month, the same way `parseError` is. */}
      {Array.isArray(item.warnings) && item.warnings.length > 0 && (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950/30"
          data-cy="inboxItemWarnings"
        >
          {item.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <LuAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              <div className="text-amber-800 dark:text-amber-200">
                {/* A warning is `{level, code, message}` per the schema. Rendering the
                    object itself — which the first version did — throws «Objects are
                    not valid as a React child» and takes the whole bell down, so this
                    surface was broken in BOTH directions at once. The string branch is
                    for any row written by an older build. */}
                {typeof w === 'string' ? w : w?.message || w?.code || ''}
              </div>
            </div>
          ))}
        </div>
      )}

      {match ? (
        <div className="flex items-center gap-1.5 rounded-md bg-success/10 text-success text-xs px-2.5 py-1.5">
          <LuCheck className="size-3.5 shrink-0" />
          <span>
            {t('Matches')}:{' '}
            <span className="font-semibold">
              {match.buildingName} · {match.expenseName}
            </span>
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 rounded-md bg-destructive/5 text-destructive text-xs px-2.5 py-1.5">
            <LuAlertTriangle className="size-3.5 shrink-0" />
            {/* AMBIGUOUS is not "not found" — saying «δεν βρέθηκε» when several
                δαπάνες DO carry this παροχή invites the landlord to create yet
                another one, which makes the collision permanent on every ingest
                path. Name the real problem and the real remedy. */}
            {rawSuggestion?.ambiguous === 'expense'
              ? t(
                  'This billing ID is on more than one expense — pick which one, or remove the duplicate'
                )
              : rawSuggestion?.ambiguous === 'sharedMeter'
                ? t(
                    'This supply number is registered as a shared meter on more than one building — fix the duplicate in the building details'
                  )
                : rawSuggestion?.ambiguous === 'unit'
                  ? t(
                      'This supply number is on more than one apartment — fix the duplicate on the units, then re-import'
                    )
                  : t('No expense found with this billing ID')}
          </div>
          <div className="flex gap-2">
            <Select
              // Show the resolved building, not just the touched one — a
              // κοινόχρηστος shared-meter hit pre-selects it, and a select that
              // silently drives a hidden value is how the wrong building gets
              // charged.
              value={buildingId || undefined}
              onValueChange={(val) =>
                setAssignment({ buildingId: val, expenseId: '' })
              }
            >
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={t('Select a building')} />
              </SelectTrigger>
              <SelectContent>
                {(buildings || []).map((b) => (
                  <SelectItem key={b._id} value={String(b._id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={expenseId || undefined}
              disabled={!buildingId}
              onValueChange={(val) => {
                if (val === '__new__') {
                  setCreateOpen(true);
                } else {
                  // Carry the RESOLVED buildingId: when the building came from
                  // the suggestion, `prev` is null, so spreading it alone would
                  // post an expense with no building.
                  setAssignment((prev) => ({
                    ...prev,
                    buildingId: prev?.buildingId || buildingId,
                    expenseId: val
                  }));
                }
              }}
            >
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={t('Select an expense')} />
              </SelectTrigger>
              <SelectContent>
                {expenseOptions.map((e) => (
                  <SelectItem key={e._id} value={String(e._id)}>
                    {e.name}
                  </SelectItem>
                ))}
                <SelectItem value="__new__">
                  <span className="flex items-center gap-1.5 text-primary">
                    <LuPlusCircle className="size-3.5" />
                    {t('Create new expense')}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {error && (
        <div className="text-xs rounded-md bg-destructive/5 border border-destructive/30 p-2 text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <Label
          htmlFor={`inbox-charge-${item._id}`}
          className="flex items-center gap-2 text-xs cursor-pointer text-muted-foreground"
        >
          <Switch
            id={`inbox-charge-${item._id}`}
            checked={charge}
            onCheckedChange={setCharge}
          />
          {t('Charge tenants this month')}
        </Label>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => dismissMutation.mutate()}
          >
            {t('Dismiss')}
          </Button>
          <Button
            size="sm"
            disabled={busy || !buildingId || !expenseId}
            onClick={() => {
              setError(null);
              confirmMutation.mutate();
            }}
          >
            {t('Record bill')}
          </Button>
        </div>
      </div>

      {createOpen && selectedBuilding && (
        <ExpenseFormDialog
          open={createOpen}
          setOpen={setCreateOpen}
          expense={createPrefill}
          building={selectedBuilding}
          onCreated={handleExpenseCreated}
        />
      )}
    </div>
  );
}

export default function InboxBell() {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);

  const { data: items } = useQuery({
    queryKey: [QueryKeys.INBOX],
    queryFn: fetchInbox,
    // Matches the server poller cadence — a bill sent to the bot appears in
    // the bell within ~2 minutes worst-case without a reload.
    refetchInterval: 60_000
  });

  const { data: buildings } = useQuery({
    queryKey: [QueryKeys.BUILDINGS],
    queryFn: fetchBuildings,
    enabled: open
  });

  const pending = Array.isArray(items) ? items : [];
  const count = pending.length;
  // The badge and the «N εκκρεμούν» label mean "needs your action", which is
  // true of a bill (confirm/dismiss) but NOT of a notice — a notice is an
  // FYI, and one condition legitimately produces several of them (a bill
  // warns at 7/1/0/-3 days). Counting notices made the badge read 4 for one
  // unpaid bill. Bills drive the number; notices only add the dot.
  const billCount = pending.filter((i) => i.kind !== 'notice').length;
  const noticeCount = count - billCount;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('Notifications')}
          className="relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-background hover:bg-accent"
        >
          <LuBell className="size-[19px] text-muted-foreground" />
          {billCount > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-destructive px-1 font-mono text-[11px] font-semibold text-destructive-foreground">
              {billCount}
            </span>
          ) : noticeCount > 0 ? (
            // Notices present but nothing to action: a plain dot, no number.
            <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-oxide" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] p-0">
        <div className="flex items-baseline justify-between border-b px-4 py-3">
          <span className="font-medium">{t('Notifications')}</span>
          {billCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('{{count}} pending', { count: billCount })}
            </span>
          )}
        </div>
        <div className="max-h-[520px] overflow-y-auto">
          {count === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              <div>{t('No pending notifications.')}</div>
              <div className="mt-1 text-xs">
                {t(
                  'Bills sent to the Telegram bot and app alerts appear here.'
                )}
              </div>
            </div>
          ) : (
            pending.map((item) =>
              item.kind === 'notice' ? (
                <NoticeCard
                  key={item._id}
                  item={item}
                  onGone={() => {
                    if (count <= 1) setOpen(false);
                  }}
                  onNavigate={() => setOpen(false)}
                />
              ) : item.kind === 'leaseImport' || item.kind === 'e9Import' ? (
                <ImportDocCard
                  key={item._id}
                  item={item}
                  onGone={() => {
                    if (count <= 1) setOpen(false);
                  }}
                  onNavigate={() => setOpen(false)}
                />
              ) : (
                <InboxCard
                  key={item._id}
                  item={item}
                  buildings={buildings}
                  onGone={() => {
                    if (count <= 1) setOpen(false);
                  }}
                />
              )
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
