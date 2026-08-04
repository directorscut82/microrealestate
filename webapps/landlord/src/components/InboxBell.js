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
  LuCalendarClock,
  LuCheck,
  LuCoins,
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

// Provider → building expense `type` suggestion for the pre-filled form
// (same map as BillImportDialog).
const PROVIDER_TYPE = {
  deh: 'electricity_common',
  eydap: 'water_common',
  epa: 'heating'
};

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

function InboxCard({ item, buildings, onGone }) {
  const { t, lang } = useTranslation('common');
  const queryClient = useQueryClient();
  const [assignment, setAssignment] = useState(null); // {buildingId, expenseId}
  const [charge, setCharge] = useState(false);
  const [error, setError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  const parsed = useMemo(() => item.parsed || {}, [item.parsed]);
  const match = item.suggestedMatch;
  const buildingId = match?.buildingId || assignment?.buildingId || '';
  const expenseId = match?.expenseId || assignment?.expenseId || '';
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
  const createPrefill = useMemo(
    () => ({
      name: parsed.provider ? parsed.provider.toUpperCase() : '',
      type: PROVIDER_TYPE[parsed.provider] || 'other',
      amount: 0,
      allocationMethod: 'equal',
      isRecurring: true,
      chargeOwnerWhenVacant: true,
      billingId: parsed.billingId || ''
    }),
    [parsed]
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
            {t('No expense found with this billing ID')}
          </div>
          <div className="flex gap-2">
            <Select
              value={assignment?.buildingId || undefined}
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
              value={assignment?.expenseId || undefined}
              disabled={!buildingId}
              onValueChange={(val) => {
                if (val === '__new__') {
                  setCreateOpen(true);
                } else {
                  setAssignment((prev) => ({ ...prev, expenseId: val }));
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
