import {
  attachBillSource,
  confirmBills,
  fetchBuildings,
  parseBillPdfs,
  QueryKeys
} from '../../utils/restcalls';
import {
  LuAlertTriangle,
  LuCheckCircle,
  LuFileWarning,
  LuPlusCircle,
  LuReceipt
} from 'react-icons/lu';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Badge } from '../ui/badge';
import {
  buildExpensePrefill,
  providerLabel
} from '../../utils/billExpensePrefill';
import {
  billTargetLabel,
  buildingLabel,
  buildingOptionLabels,
  unitLabel
} from '../../utils/entityLabels';
import { Button } from '../ui/button';
import { ExpenseFormDialog } from './ExpenseFormDialog';
import FileDropZone from '../ui/file-drop-zone';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { parseGreekMoney } from '../../utils/numberformat';
import ResponsiveDialog from '../ResponsiveDialog';
import { Switch } from '../ui/switch';
import { termMonthYearAccusative } from '../../utils/greekMonths';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';

// Allocation method → the same label keys ExpenseFormDialog uses, so the charge
// preview names the split with the words the landlord already sees in the expense
// form. Kept as a literal map (not imported) because ExpenseFormDialog does not
// export it; the jest unit asserts the two lists agree.
const ALLOCATION_METHOD_LABEL = {
  general_thousandths: 'General Thousandths',
  heating_thousandths: 'Heating Thousandths',
  elevator_thousandths: 'Elevator Thousandths',
  equal: 'Equal',
  by_surface: 'By Surface',
  fixed: 'Fixed',
  custom_ratio: 'Custom Ratio',
  custom_percentage: 'Custom Percentage',
  single_unit: 'Single Unit'
};

/**
 * The amount as the landlord would write it — «120,00», not «120».
 *
 * Safe to seed in Greek form because the confirm path parses it back with
 * parseGreekMoney, which handles both «1.234,56» and «1234.56». Untouched values
 * therefore round-trip exactly; only the DISPLAY changes.
 */
function formatSeedAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2).replace('.', ',');
}

// H4: key per-result state by a stable synthetic uid, NOT filename. Two uploaded
// files can share a name (the server keeps both), and a filename key made their
// cards collide onto one state entry — assigning one drove the other, routing
// both bills to the same expense. `_uid` is stamped on each result at parse time.
const keyOf = (result) => result._uid;

// Server-emitted field CODES (billparser PartialBillFields.missingFields) → the
// i18n keys this dialog already uses for the same fields on the success card, so
// the «Not read» list renders in the operator's locale. An unknown code falls
// through to its raw value rather than rendering blank.
const MISSING_FIELD_LABEL = {
  billingId: 'Billing ID',
  totalAmount: 'Amount',
  period: 'Period'
};

function ResultCard({
  result,
  buildings,
  // The building whose page the dialog was opened from. Needed because a bill's
  // παροχή can identify a DIFFERENT building, and until now that was re-pointed
  // silently — the landlord created the δαπάνη on one building while looking at
  // another, then went hunting for it.
  openedFromBuilding,
  assignment,
  onAssignBuilding,
  onAssignExpense,
  onCreateExpense,
  onToggleReplace,
  replaceFlags,
  chargeFlags,
  onToggleCharge,
  amountOverride,
  onAmountChange
}) {
  const { t, lang } = useTranslation('common');

  // Shared by BOTH branches below (the parse-fail card returns early). Qualified
  // only where two options would otherwise read the same — the old code appended
  // the street to every option, which rendered «ΟΔΟΣ ΑΛΦΑ 1 — ΟΔΟΣ ΑΛΦΑ 1».
  const buildingLabels = buildingOptionLabels(buildings);

  if (!result.success) {
    // PARSE-FAIL SURFACE (2026-08-09). This card used to be the filename plus a
    // one-line error, discarding everything the OCR had read: three real ΔΕΗ
    // bills failed on the παροχή alone after ~51s each while their amount,
    // period, dates and RF were all parsed correctly. It now shows what WAS
    // read, names what was not, and — only when the bill did NOT match an
    // already-configured έξοδο — offers to create one.
    const p = result.partial || {};
    const salvaged = [
      p.totalAmount !== undefined && p.totalAmount !== null
        ? {
            label: t('Amount'),
            // showZero: a genuine «*0,00€» bill (fully credited) parses to 0, and
            // without this NumberFormat renders «—» — the SAME glyph as "not
            // read", while the «Δεν διαβάστηκαν» list correctly omits the field.
            // Both surfaces would then disagree about whether the OCR read it.
            value: <NumberFormat value={p.totalAmount} showZero />
          }
        : null,
      p.periodStart && p.periodEnd
        ? {
            label: t('Period'),
            value: `${moment(p.periodStart).format('L')} – ${moment(
              p.periodEnd
            ).format('L')}`
          }
        : null,
      p.issueDate
        ? { label: t('Issue date'), value: moment(p.issueDate).format('L') }
        : null,
      p.dueDate
        ? { label: t('Due Date'), value: moment(p.dueDate).format('L') }
        : null,
      p.billingId
        ? {
            label: t('Billing ID'),
            value: <span className="font-mono text-xs">{p.billingId}</span>
          }
        : null,
      p.rfCode
        ? {
            label: t('RF Code'),
            value: <span className="font-mono text-xs">{p.rfCode}</span>
          }
        : null
    ].filter(Boolean);

    const selectedBuildingForFail = buildings?.find(
      (b) => String(b._id) === String(assignment?.buildingId || '')
    );
    // Was an expense already created (or picked) for this failed row? Resolved
    // from the freshly-refetched buildings list, so it reflects the server.
    const createdExpenseName = assignment?.expenseId
      ? (selectedBuildingForFail?.expenses || []).find(
          (e) => String(e._id) === String(assignment.expenseId)
        )?.name
      : undefined;

    return (
      <div className="border rounded-md p-4 space-y-3 border-destructive/30 bg-destructive/5">
        <div className="flex items-start gap-2">
          <LuFileWarning className="size-5 text-destructive shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-medium text-sm">{result.filename}</div>
            <div className="text-sm text-destructive">{result.error}</div>
          </div>
        </div>

        {salvaged.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-ink-muted uppercase tracking-wide">
              {t('Read from the document')}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {salvaged.map((f) => (
                <Fragment key={f.label}>
                  <div className="text-muted-foreground">{f.label}</div>
                  <div className="font-medium">{f.value}</div>
                </Fragment>
              ))}
            </div>
          </div>
        )}

        {p.missingFields?.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-ink-muted uppercase tracking-wide">
              {t('Not read')}
            </div>
            <ul className="text-sm text-muted-foreground list-disc list-inside">
              {p.missingFields.map((f) => (
                <li key={f}>{MISSING_FIELD_LABEL[f] ? t(MISSING_FIELD_LABEL[f]) : f}</li>
              ))}
            </ul>
          </div>
        )}

        {/* The bill's παροχή IS already configured on an expense — so this is a
            parse problem on a KNOWN bill, not an unknown one. Creating a second
            έξοδο here would duplicate it, so we name the existing one instead
            (per the user's instruction: offer create ONLY when unmatched). */}
        {result.match ? (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            {t('This supply number already belongs to an expense')}:{' '}
            <span className="font-medium">{result.match.expenseName}</span>
            {result.match.buildingName ? ` — ${result.match.buildingName}` : ''}
            <div className="text-xs text-muted-foreground mt-1">
              {t(
                'Fix the amount or period on that expense by hand — this file could not be read in full.'
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
            {/* WHY there is no match. «Could not be matched» is the wrong sentence when
                the truth is that SEVERAL things matched and the operator has to choose:
                its obvious remedy — create another έξοδο for the same παροχή — makes
                the ambiguity permanent. The server has always known the difference and
                now reports it as `matchAmbiguous`; until this block existed the field
                had no reader, so an ambiguous bill read exactly like an unmatched one.
                The bell has said this since the matcher was unified. */}
            <div className="text-sm text-muted-foreground">
              {result.matchAmbiguous === 'expense'
                ? t(
                    'This billing ID is on more than one expense — pick which one, or remove the duplicate'
                  )
                : result.matchAmbiguous === 'sharedMeter'
                  ? t(
                      'This supply number is registered as a shared meter on more than one building — fix the duplicate in the building details'
                    )
                  : t(
                      'This bill could not be matched automatically. Register it by hand:'
                    )}
            </div>
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">
                {t('Building')}
              </label>
              <Select
                value={assignment?.buildingId || undefined}
                onValueChange={(val) => onAssignBuilding(keyOf(result), val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select a building')} />
                </SelectTrigger>
                <SelectContent>
                  {/* Same list-aware labels as the success card — never «X — X». */}
                  {(buildings || []).map((b) => (
                    <SelectItem key={b._id} value={String(b._id)}>
                      {buildingLabels.get(String(b._id)) || buildingLabel(b)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Once an expense HAS been created from this card, show it instead of
                the button.

                The button gave no feedback at all: ExpenseFormDialog emits no
                success toast, this branch never read `assignment.expenseId`, and
                `results` is not refetched — so the card re-rendered byte-identically
                and the click looked like it had done nothing. Pressing again created
                a SECOND identical expense (buildingmanager.addExpense has no
                duplicate guard and `billingId` carries no unique index), both
                active and recurring, so every tenant in the building would be
                charged twice, every month. Naming the created expense both confirms
                the action and removes the double-press bait. */}
            {createdExpenseName ? (
              <div className="flex items-center gap-1.5 text-sm">
                <LuCheckCircle className="size-3.5 text-primary shrink-0" />
                <span>
                  {t('Expense created')}:{' '}
                  <span className="font-medium">{createdExpenseName}</span>
                </span>
              </div>
            ) : (
              assignment?.buildingId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onCreateExpense(keyOf(result), selectedBuildingForFail)
                  }
                >
                  <LuPlusCircle className="size-3.5 mr-1.5" />
                  {t('Create new expense')}
                </Button>
              )
            )}
          </div>
        )}

        {result.ocrText ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {t('OCR text')}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[0.6875rem] scrollbar-branded">
              {result.ocrText}
            </pre>
          </details>
        ) : null}
      </div>
    );
  }

  const { parsed, match, existingAmount, duplicate } = result;
  // Effective assignment: an exact server match wins; otherwise the user's
  // in-dialog selection (assignment). An unmatched result is confirmable only
  // once BOTH building and expense are chosen.
  const buildingId = match?.buildingId || assignment?.buildingId || '';
  const expenseId = match?.expenseId || assignment?.expenseId || '';
  const selectedBuilding = buildings?.find(
    (b) => String(b._id) === String(buildingId)
  );
  const expenseOptions = (selectedBuilding?.expenses || []).filter(
    // hide soft-deleted expenses (endTerm in the past)
    (e) => !e.endTerm
  );
  // WHAT THE παροχή IDENTIFIED. The server returns these and the dialog used them
  // only to preselect the building and seed the create-expense form — it never
  // SHOWED them, so the landlord could not tell which apartment a bill was for
  // without opening «Νέα δαπάνη».
  const identifiedShared = result.sharedMeterMatch || null;
  const identifiedUnit = result.unitMatch || null;
  const identifiedBuildingId =
    match?.buildingId ||
    identifiedShared?.buildingId ||
    identifiedUnit?.buildingId ||
    '';
  const identifiedBuilding = buildings?.find(
    (b) => String(b._id) === String(identifiedBuildingId)
  );
  const identifiedUnitRow = identifiedUnit
    ? (identifiedBuilding?.units || []).find(
        (u) =>
          String(u.propertyId ?? u._id) === String(identifiedUnit.propertyId)
      )
    : null;
  const targetLabel = identifiedBuilding
    ? billTargetLabel({
        building: identifiedBuilding,
        unit: identifiedUnitRow,
        shared: !!identifiedShared
      })
    : '';
  // The expense this bill will actually be charged against — needed so the charge
  // toggle can SAY what it will do (T12) instead of asking blind.
  const targetExpense =
    (selectedBuilding?.expenses || []).find(
      (e) => String(e._id) === String(expenseId)
    ) || null;
  // For a `single_unit` expense, WHICH apartment. Its customAllocations carry the
  // propertyId; render the same `name (ΑΤΑΚ)` label used everywhere else.
  const singleUnitTargetLabel = (() => {
    if (targetExpense?.allocationMethod !== 'single_unit') return '';
    const pid = (targetExpense.customAllocations || [])[0]?.propertyId;
    if (!pid) return '';
    const row = (selectedBuilding?.units || []).find(
      (u) => String(u.propertyId ?? u._id) === String(pid)
    );
    return row ? unitLabel(row) : '';
  })();

  // The term this bill will be posted to (YYYYMMDDHH), and whether the target
  // expense even exists that month.
  const billTerm = parsed.proposedTerm ?? null;
  const startsAfterBillTerm =
    !!targetExpense?.startTerm &&
    !!billTerm &&
    Number(targetExpense.startTerm) > Number(billTerm);

  // The bill belongs somewhere OTHER than the page we came from.
  const wrongBuilding =
    !!identifiedBuildingId &&
    !!openedFromBuilding?._id &&
    String(identifiedBuildingId) !== String(openedFromBuilding._id);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* ─ HEADER ────────────────────────────────────────────────────────────
          One line of identity: the file, then the provider and the month this
          bill will POST TO. The month used to be absent even though two of the
          warnings below argue about months, which made them unreadable. The
          expense-name badge that used to sit on the right is gone — it repeated
          what the target row already says, so «DEH», «ΔΕΗ» and «Έξοδο: DEH» all
          appeared within 40px of each other. */}
      <div className="flex items-start gap-3 border-b border-border bg-muted/20 px-4 py-3">
        <LuReceipt className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={result.filename}>
            {result.filename}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {providerLabel(parsed.provider) || parsed.provider}
            {billTerm ? (
              <>
                {' · '}
                {termMonthYearAccusative(billTerm, lang)}
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {/* ─ TARGET ────────────────────────────────────────────────────────
            WHERE the money lands, stated once. Per the landlord's rule a
            κοινόχρηστο is identified by its address and an apartment bill must
            also carry the flat's ΑΤΑΚ. */}
        {targetLabel && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="text-muted-foreground">
              {identifiedShared
                ? t('Shared meter')
                : identifiedUnit
                  ? t('Apartment')
                  : t('Expense')}
            </span>
            <span className="font-medium">
              {match?.expenseName
                ? `${match.expenseName} · ${targetLabel}`
                : targetLabel}
              {/* The matched branch has no unitMatch (the server stops looking once an
                  expense hits), so without this a per-apartment bill named its building
                  and never its flat — the one fact the landlord is checking. */}
              {!identifiedUnit && singleUnitTargetLabel ? (
                <>
                  {' · '}
                  {/* Units in this realm can have no `name`, in which case the label
                      is the bare ΑΤΑΚ — an 11-digit number with nothing saying it is
                      an apartment. Prefix it when that is all we have. */}
                  {/^\d+$/.test(singleUnitTargetLabel)
                    ? `${t('Apartment')} ${singleUnitTargetLabel}`
                    : singleUnitTargetLabel}
                </>
              ) : null}
            </span>
            {identifiedShared?.label ? (
              <span className="text-xs text-muted-foreground">
                ({identifiedShared.label})
              </span>
            ) : null}
          </div>
        )}

        {/* ─ WARNINGS, ALL OF THEM, IN ONE PLACE ───────────────────────────
            These used to be three separate amber boxes with the QR, the field
            grid and the charge toggle interleaved between them, so the card read
            as a pile of alarms rather than one bill. Collected into a single
            block: same information, one location, ordered by how badly each one
            can cost money. The «replace» switch stays INSIDE its own row because
            it is the remedy for that specific warning. */}
        {(wrongBuilding ||
          startsAfterBillTerm ||
          existingAmount !== undefined ||
          duplicate) && (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-800 dark:bg-amber-950/30">
            {wrongBuilding && (
              <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
                <LuAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <span>
                  {t(
                    'This bill belongs to {{building}}, not the building you are viewing ({{current}}). It will be recorded there.',
                    {
                      building: buildingLabel(identifiedBuilding),
                      current: buildingLabel(openedFromBuilding)
                    }
                  )}
                </span>
              </div>
            )}

            {startsAfterBillTerm && (
              <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
                <LuAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <span>
                  {t(
                    'The expense starts in {{start}} but this bill is for {{bill}} — it will not appear on that month’s statement.',
                    {
                      start: termMonthYearAccusative(
                        targetExpense.startTerm,
                        lang
                      ),
                      bill: termMonthYearAccusative(billTerm, lang)
                    }
                  )}
                </span>
              </div>
            )}

            {/* Same term, different amount: offer the upsert, because replacing
                at THIS term is exactly the right remedy here. */}
            {existingAmount !== undefined && (
              <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
                <LuAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <div>
                    {t('A bill already exists for this period')}
                    {' — '}
                    {t('Existing amount')}:{' '}
                    <NumberFormat value={existingAmount} />
                  </div>
                  <label
                    htmlFor={`replace-${keyOf(result)}`}
                    className="mt-1.5 flex cursor-pointer items-center gap-2"
                  >
                    <Switch
                      id={`replace-${keyOf(result)}`}
                      checked={!!replaceFlags[keyOf(result)]}
                      onCheckedChange={() => onToggleReplace(keyOf(result))}
                    />
                    <span>{t('Replace the existing bill')}</span>
                  </label>
                </div>
              </div>
            )}

            {/* DIFFERENT term, same physical bill. Deliberately no replace
                button: replaceExisting upserts at THIS file's term and would
                leave the other month's bill untouched — a button that looks like
                it resolves the duplicate while silently creating a second one. */}
            {duplicate && existingAmount === undefined && (
              <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
                <LuAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <div>
                  <div>
                    {t('This bill appears to be already imported')}
                    {' — '}
                    {t('Already imported for {{month}}', {
                      month: termMonthYearAccusative(duplicate.term, lang)
                    })}
                    {' · '}
                    <NumberFormat value={duplicate.totalAmount} />
                  </div>
                  <div className="mt-0.5 text-amber-700/80 dark:text-amber-300/80">
                    {t(
                      'Check that month before confirming — deselect this file if it is a duplicate'
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─ WHAT WAS READ ─────────────────────────────────────────────────
            QR left at a readable-but-not-dominant size, values right.

            The grid is `max-content 1fr`, NOT two equal columns: at 50/50 the
            labels claimed half the width and every value was squeezed, so the
            παροχή broke mid-number across two lines, the period split a single
            range across three, and both the amount input and the RF code were
            clipped off the right edge (with a horizontal scrollbar to prove it).
            Values now get all the remaining space, long codes truncate with the
            full value on hover instead of being cut, and nothing overflows. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {/* The scannable payment code, on the left. ΔΕΗ prints an IRIS QR; ΕΥΔΑΠ
              prints a BARCODE instead (its scannable code is the 41-digit run under
              the barcode beside the ΑΠΟΚΟΜΜΑ ΤΑΜΕΙΟΥ) and no RF code at all, so the
              IRIS generator declines and this block used to render nothing for a
              ΕΥΔΑΠ bill. A Code 128 is wide, not square: showing it in the QR's
              `size-40` box squashes it into an unscannable smear, which is worse
              than showing none — so the kind decides the box. */}
          {parsed.irisCodeBase64 ? (
            parsed.paymentCodeKind === 'barcode' ? (
              <div className="w-full shrink-0 sm:w-72">
                <img
                  src={`data:image/png;base64,${parsed.irisCodeBase64}`}
                  alt={t('Payment barcode')}
                  className="h-20 w-full rounded border border-border bg-white object-contain p-2"
                />
                <div className="mt-1 text-center text-[0.6875rem] leading-tight text-muted-foreground">
                  {t('Scan to pay')}
                </div>
              </div>
            ) : (
              <div className="shrink-0">
                <img
                  src={`data:image/png;base64,${parsed.irisCodeBase64}`}
                  alt={t('IRIS payment QR code')}
                  className="size-40 rounded border border-border bg-white p-2"
                />
                <div className="mt-1 w-40 text-center text-[0.6875rem] leading-tight text-muted-foreground">
                  {t('Scan to pay (IRIS)')}
                </div>
              </div>
            )
          ) : null}

          <div className="min-w-0 flex-1">
            <div className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted">
              {/* WHERE the values came from. A figure lifted verbatim from a PDF's
                  own text layer is trustworthy in a way an OCR'd one is not, and this
                  label is the only thing on the card that says which.
                  It is read from `textSource`, which the PARSER reports, because both
                  previous attempts to infer it produced a CONSTANT: testing
                  `result.ocrText` (set only on a failed parse) labelled every
                  successfully-parsed photo «Από το PDF», and testing
                  `parsed.ocrText` — which the server sets unconditionally from
                  rawText, and all three parser routes assign it — labelled every bill
                  «Από την εικόνα (OCR)», including digital PDFs. Three distinct modes
                  need three labels; a scanned PDF is OCR'd and must not be presented
                  as a text-layer read. */}
              {result.parsed?.textSource === 'pdf-text'
                ? t('Read from the PDF text')
                : result.parsed?.textSource === 'pdf-ocr'
                  ? t('Read from a scanned PDF (OCR)')
                  : result.parsed?.textSource === 'image-ocr'
                    ? t('Read from the image (OCR)')
                    : // No textSource: an OLD result shape, or a failed parse whose
                      // partial fields are shown. Fall back to the FILENAME rather
                      // than to a guess that reads as certainty.
                      /\.pdf$/i.test(result.filename || '')
                      ? t('Read from the PDF')
                      : t('Read from the image (OCR)')}
            </div>

            <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t('Amount')}</dt>
              <dd className="min-w-0">
                {/* Editable: an OCR misread of the total («186,21» as «18621»)
                    would otherwise flow verbatim into the bill and, via «Χρέωση
                    ενοικιαστών», into every tenant's rent. */}
                <span className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    inputMode="decimal"
                    className="h-8 w-28 text-sm tabular-nums"
                    value={
                      amountOverride !== undefined
                        ? amountOverride
                        : formatSeedAmount(parsed.totalAmount)
                    }
                    onChange={(e) => onAmountChange(result._uid, e.target.value)}
                    aria-label={t('Amount')}
                  />
                  <span className="text-muted-foreground">€</span>
                </span>
              </dd>

              <dt className="text-muted-foreground">{t('Supply number')}</dt>
              <dd className="min-w-0 whitespace-nowrap font-mono text-xs tabular-nums">
                {parsed.billingId}
              </dd>

              <dt className="text-muted-foreground">{t('Period')}</dt>
              <dd className="min-w-0 whitespace-nowrap tabular-nums">
                {parsed.periodStart
                  ? moment(parsed.periodStart).format('L')
                  : '—'}
                {' – '}
                {parsed.periodEnd ? moment(parsed.periodEnd).format('L') : '—'}
              </dd>

              {/* Issue date was simply absent from this card, though the parser
                  reads it and it is what the landlord cross-checks against the
                  paper bill. */}
              {parsed.issueDate && (
                <>
                  <dt className="text-muted-foreground">{t('Issue Date')}</dt>
                  <dd className="min-w-0 whitespace-nowrap tabular-nums">
                    {moment(parsed.issueDate).format('L')}
                  </dd>
                </>
              )}

              {parsed.dueDate && (
                <>
                  <dt className="text-muted-foreground">{t('Due Date')}</dt>
                  <dd className="min-w-0 whitespace-nowrap tabular-nums">
                    {moment(parsed.dueDate).format('L')}
                  </dd>
                </>
              )}

              {parsed.rfCode && (
                <>
                  <dt className="text-muted-foreground">{t('RF Code')}</dt>
                  {/* break-all, NOT truncate: the landlord pays from this code, so
                      hiding its tail behind a tooltip is the clipping bug again in a
                      politer form. At this width it fits on one line anyway. */}
                  <dd className="min-w-0 break-all font-mono text-xs">
                    {parsed.rfCode}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </div>

        {/* ─ ASSIGN (unmatched only) ───────────────────────────────────────── */}
        {!match && (
          <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
            <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted">
              {t('Assign to')}
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('Building')}
              </label>
              <Select
                value={buildingId || undefined}
                onValueChange={(val) => onAssignBuilding(keyOf(result), val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select a building')} />
                </SelectTrigger>
                <SelectContent>
                  {(buildings || []).map((b) => (
                    <SelectItem key={b._id} value={String(b._id)}>
                      {buildingLabels.get(String(b._id)) || buildingLabel(b)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {buildingId && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  {t('Expense')}
                </label>
                <Select
                  value={expenseId || undefined}
                  onValueChange={(val) => {
                    if (val === '__new__') {
                      onCreateExpense(keyOf(result), selectedBuilding);
                    } else {
                      onAssignExpense(keyOf(result), val);
                    }
                  }}
                >
                  <SelectTrigger>
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
            )}
          </div>
        )}

        {/* ─ CHARGE ────────────────────────────────────────────────────────
            The toggle authorises money, so it states what it will do. It does
            NOT re-offer the expense form's controls (the expense owns those, and
            two owners of one money rule is this area's recurring defect) and does
            NOT compute a per-unit split — that arithmetic lives in the server's
            allocation engine, and a second implementation would drift from it. */}
        {expenseId && (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
            <label
              htmlFor={`charge-${keyOf(result)}`}
              className="flex cursor-pointer items-center justify-between gap-3"
            >
              {/* «this month» was a lie: the charge posts to the BILL's term
                  (parsed.proposedTerm), not the current month — a June bill charges
                  June even in August. Name the month so the toggle cannot be
                  misread, and fall back to the old wording only if the parse gave
                  us no term to name. */}
              <span className="text-sm">
                {billTerm
                  ? t('Charge tenants for {{month}}', {
                      month: termMonthYearAccusative(billTerm, lang)
                    })
                  : t('Charge tenants this month')}
              </span>
              <Switch
                id={`charge-${keyOf(result)}`}
                checked={!!chargeFlags[keyOf(result)]}
                onCheckedChange={() => onToggleCharge(keyOf(result))}
              />
            </label>

            {chargeFlags[keyOf(result)] && targetExpense && (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 border-t border-border pt-2 text-xs">
                <dt className="text-muted-foreground">{t('Split')}</dt>
                <dd className="min-w-0">
                  <span className="font-medium">
                    {ALLOCATION_METHOD_LABEL[targetExpense.allocationMethod]
                      ? t(
                          ALLOCATION_METHOD_LABEL[
                            targetExpense.allocationMethod
                          ]
                        )
                      : targetExpense.allocationMethod}
                  </span>
                  {targetExpense.allocationMethod === 'single_unit' &&
                  singleUnitTargetLabel ? (
                    <span className="text-muted-foreground">
                      {' — '}
                      {singleUnitTargetLabel}
                    </span>
                  ) : null}
                </dd>
                <dt className="text-muted-foreground">{t('Vacant')}</dt>
                <dd className="min-w-0 text-muted-foreground">
                  {targetExpense.chargeOwnerWhenVacant
                    ? t('A vacant apartment is charged to its owner')
                    : t('A vacant apartment is not charged')}
                </dd>
              </dl>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function BillImportDialog({ open, setOpen, building }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle');
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [replaceFlags, setReplaceFlags] = useState({});
  // O3: per-result edited amount (raw string as typed) overriding the parsed
  // total when the operator corrects an OCR misread. {_uid: '123,45'}
  const [amountOverrides, setAmountOverrides] = useState({});
  const handleAmountChange = useCallback((uid, raw) => {
    setAmountOverrides((prev) => ({ ...prev, [uid]: raw }));
  }, []);
  // Per-result «charge tenants this month» toggle: {_uid: boolean}
  const [chargeFlags, setChargeFlags] = useState({});
  // Per-result manual assignment for unmatched bills: {_uid: {buildingId, expenseId}}
  const [assignments, setAssignments] = useState({});
  // Inline "create expense" flow: which result triggered it + which building.
  const [createFor, setCreateFor] = useState(null); // {uid, building} | null

  // All realm buildings — a parsed bill may match a DIFFERENT building than the
  // one being viewed, and the no-match dropdown lists them all (§2.1c).
  const { data: buildings } = useQuery({
    queryKey: [QueryKeys.BUILDINGS],
    queryFn: fetchBuildings,
    enabled: open
  });

  useEffect(() => {
    if (!open) {
      setState('idle');
      setFiles([]);
      setResults([]);
      setReplaceFlags({});
      setChargeFlags({});
      setAssignments({});
      setAmountOverrides({});
      setCreateFor(null);
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleParse = useCallback(async () => {
    if (files.length === 0) return;
    setState('loading');

    try {
      const data = await parseBillPdfs(files);
      // H4: stamp a stable per-result uid so state maps don't collide on filename.
      const rows = (data || []).map((r, i) => ({
        ...r,
        _uid: `${i}:${r.filename}`
      }));
      setResults(rows);
      // Pre-select the building for no-match bills whose αριθμός παροχής
      // identified an apartment — the landlord lands on the right building with
      // only the expense left to create/pick.
      const seededAssign = {};
      for (const r of rows) {
        // NOT gated on `r.success` (adversarial review): a FAILED row can also
        // carry a unitMatch now, and `createPrefill` reads that unitMatch
        // ungated to build a `single_unit` allocation. With seeding gated but the
        // prefill not, a failed row had NO pre-selected building — so picking any
        // other building shipped the identified building's propertyId into a
        // DIFFERENT building's expense: the unit picker rendered blank, zod passed
        // (it only checks the id is truthy), and the server 422'd as the generic
        // «Κάτι πήγε λάθος». Seeding both branches keeps the default and the
        // prefill talking about the same building.
        // Either identification pre-selects the building: a shared (κοινόχρηστος)
        // meter or a specific apartment's meter. They are mutually exclusive
        // server-side; shared wins here for the same reason it is tried first.
        const identified = r.sharedMeterMatch || r.unitMatch;
        if (!r.match && identified?.buildingId) {
          seededAssign[r._uid] = {
            buildingId: identified.buildingId,
            expenseId: ''
          };
        }
      }
      if (Object.keys(seededAssign).length) {
        setAssignments((prev) => ({ ...seededAssign, ...prev }));
      }
      setState('preview');
    } catch (error) {
      console.error('Bill parse error:', error);
      // SHOW THE SERVER'S MESSAGE. It returns {status, message} on every rejection and
      // the messages are specific and already Greek — «Ο συνολικός όγκος των αρχείων
      // υπερβαίνει τα 45MB. Ανεβάστε λιγότερα αρχεία τη φορά.», «Only PDF or image
      // files allowed», «Invalid file content: <name>». This catch discarded all of
      // them for one generic sentence that also says PDF on the dialog built for
      // photographs, so a landlord whose batch was too large was told the parse failed
      // and reasonably retried the identical batch. ImportE9Dialog in this same
      // directory has always read it (ImportE9Dialog.js:192).
      const serverMessage = error?.response?.data?.message;
      const status = error?.response?.status;
      toast.error(
        serverMessage ||
          (status === 413
            ? t('The files are too large — upload fewer at a time')
            : status === 504
              ? t('The upload timed out — try fewer files at a time')
              : t('Failed to parse bill PDFs'))
      );
      setState('idle');
    }
  }, [files, t]);

  const assignBuilding = useCallback((uid, buildingId) => {
    // changing the building clears any stale expense selection
    setAssignments((prev) => ({
      ...prev,
      [uid]: { buildingId, expenseId: '' }
    }));
  }, []);

  const assignExpense = useCallback((uid, expenseId) => {
    setAssignments((prev) => ({
      ...prev,
      [uid]: { ...(prev[uid] || {}), expenseId }
    }));
  }, []);

  const handleCreateExpense = useCallback((uid, selectedBuilding) => {
    setCreateFor({ uid, building: selectedBuilding });
  }, []);

  // The pre-filled synthetic expense (NO _id → add mode in ExpenseFormDialog).
  // The allocation three-way (shared → χιλιοστά, unit → single_unit, else equal)
  // and every reason each branch matters live in ONE place, shared with InboxBell:
  // utils/billExpensePrefill.js. It used to live only here, so the same bill routed
  // through the Telegram bell got a flat equal split and mis-billed every unit.
  const createPrefill = useMemo(() => {
    if (!createFor) return null;
    const result = results.find((r) => r._uid === createFor.uid);
    const parsed = result?.parsed;
    // Only use the identified unit when the expense is being created on the SAME
    // building that unit belongs to. The operator can pick any building in the
    // select, and a `single_unit` allocation pointing at another building's
    // propertyId fails the server's cross-building guard with an undiagnosable
    // generic toast (and renders a blank unit picker on the way there). Falling
    // back to an equal split is the honest default for the wrong building.
    const rawUnitMatch = result?.unitMatch;
    const unitMatch =
      rawUnitMatch &&
      String(rawUnitMatch.buildingId) === String(createFor.building?._id)
        ? rawUnitMatch
        : null;
    // A SHARED (κοινόχρηστος) meter match is the opposite case: the bill belongs
    // to the whole building, so it must NEVER become `single_unit` (which bills
    // 100% to one apartment — see 1_base.ts). Same building-scoping as above.
    const rawShared = result?.sharedMeterMatch;
    const sharedMatch =
      rawShared &&
      String(rawShared.buildingId) === String(createFor.building?._id)
        ? rawShared
        : null;
    // A FAILED parse has no `parsed`, but may carry `partial` (what the OCR did
    // read) and `detectedProvider`. Without this fallback the create-expense form
    // opened blank for exactly the files that need it most — the whole point of
    // the parse-fail surface is that the salvaged data is reusable.
    const partial = result?.success ? null : result?.partial;
    return buildExpensePrefill({
      building: createFor.building,
      provider: parsed?.provider || result?.detectedProvider || '',
      billingId: parsed?.billingId || partial?.billingId || '',
      sharedMatch,
      unitMatch
    });
  }, [createFor, results]);

  // After the new expense is created, the server returns the updated building.
  // Find the new expense (by billingId, else the last one) and auto-select it.
  const handleExpenseCreated = useCallback(
    (updatedBuilding) => {
      if (!createFor || !updatedBuilding) return;
      const parsed = results.find((r) => r._uid === createFor.uid)?.parsed;
      const expenses = updatedBuilding.expenses || [];
      const created =
        expenses.find(
          (e) =>
            parsed?.billingId &&
            e.billingId &&
            e.billingId.replace(/[\s\-.]/g, '') ===
              parsed.billingId.replace(/[\s\-.]/g, '')
        ) || expenses[expenses.length - 1];
      if (created) {
        setAssignments((prev) => ({
          ...prev,
          [createFor.uid]: {
            buildingId: String(updatedBuilding._id),
            expenseId: String(created._id)
          }
        }));
      }
      // refresh the buildings list so the dropdown shows the new expense
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      setCreateFor(null);
    },
    [createFor, results, queryClient]
  );

  // A result is confirmable if it has an exact match OR a full manual assignment.
  const resolvedAssignment = useCallback(
    (result) => {
      if (result.match) {
        return {
          buildingId: result.match.buildingId,
          expenseId: result.match.expenseId
        };
      }
      const a = assignments[result._uid];
      return a?.buildingId && a?.expenseId ? a : null;
    },
    [assignments]
  );

  const handleConfirm = useCallback(async () => {
    const confirmable = results
      .filter((r) => r.success)
      .map((r) => ({ r, a: resolvedAssignment(r) }))
      .filter(({ a }) => !!a);
    if (confirmable.length === 0) return;

    // O3: resolve the effective amount (operator override → parsed) per bill
    // and refuse to confirm if any is non-positive, so an OCR misread the user
    // failed to correct can't silently reach the ledger.
    const effectiveAmount = (r) => {
      const raw = amountOverrides[r._uid];
      if (raw !== undefined && String(raw).trim() !== '') {
        return parseGreekMoney(raw);
      }
      return Number(r.parsed.totalAmount);
    };
    const badAmount = confirmable.find(({ r }) => {
      const v = effectiveAmount(r);
      return !Number.isFinite(v) || v <= 0.005;
    });
    if (badAmount) {
      toast.error(
        t('Please enter a valid amount for {{name}}', {
          name: badAmount.r.filename || badAmount.r.parsed?.billingId || ''
        })
      );
      return;
    }

    setState('confirming');

    try {
      const billsToConfirm = confirmable.map(({ r, a }) => {
        const b = buildings?.find(
          (bld) => String(bld._id) === String(a.buildingId)
        );
        const expenseName =
          r.match?.expenseName ||
          (b?.expenses || []).find((e) => String(e._id) === String(a.expenseId))
            ?.name ||
          r.parsed.provider;
        return {
          buildingId: a.buildingId,
          expenseId: a.expenseId,
          provider: r.parsed.provider,
          billingId: r.parsed.billingId,
          totalAmount: effectiveAmount(r),
          periodStart: r.parsed.periodStart,
          periodEnd: r.parsed.periodEnd,
          issueDate: r.parsed.issueDate,
          dueDate: r.parsed.dueDate,
          term: r.parsed.proposedTerm,
          rfCode: r.parsed.rfCode,
          paymentCode: r.parsed.paymentCode,
          irisCodeBase64: r.parsed.irisCodeBase64,
          paymentCodeKind: r.parsed.paymentCodeKind,
          // Slice 6 — carry the raw OCR text to persist on the Bill for later
          // απόδειξη matching (the server rebuilds the match bag from it).
          ocrText: r.parsed.ocrText,
          replaceExisting: !!replaceFlags[r._uid],
          chargeThisMonth: !!chargeFlags[r._uid],
          expenseName
        };
      });

      const savedBills = await confirmBills(billsToConfirm);

      // Slice 5: archive each saved bill's SOURCE file to B2. The source can't
      // ride the JSON /confirm (100kb cap), so we re-send it per bill now that
      // we have the bill _id — and only for bills that actually saved (no
      // orphaned uploads). Index-aligned: savedBills[k] ↔ confirmable[k].
      // Best-effort: a failed archive never blocks the import outcome, but it
      // must NOT fail silently — log it and count so the user can be told the
      // source PDF wasn't stored (the bill itself saved fine).
      const archiveResults = await Promise.all(
        (Array.isArray(savedBills) ? savedBills : []).map((row, k) => {
          if (!row || row.saveFailed || !row._id) return null;
          const uid = confirmable[k]?.r?._uid;
          const idx = uid ? Number(String(uid).split(':')[0]) : NaN;
          const file = Number.isInteger(idx) ? files[idx] : undefined;
          if (!file) return null;
          return attachBillSource(row._id, file)
            .then(() => true)
            .catch((err) => {
              console.error(
                `attachBillSource failed for bill ${row._id}:`,
                err
              );
              return false;
            });
        })
      );
      const archiveFailures = archiveResults.filter((x) => x === false).length;

      queryClient.invalidateQueries({ queryKey: [QueryKeys.BILLS] });
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.BUILDINGS, building?._id]
      });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BUILDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
      // M3: any bill that also CHARGED tenants went through the same
      // saveMonthlyStatement write as BuildingExpensePanel — mirror its full
      // invalidation set so rent/owner/breakdown surfaces don't show stale
      // figures until a manual refetch.
      const anyCharged = billsToConfirm.some((b) => b.chargeThisMonth);
      if (anyCharged) {
        queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.OWNERS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTING] });
        queryClient.invalidateQueries({ queryKey: ['expense-breakdown'] });
      }
      const rows = Array.isArray(savedBills) ? savedBills : [];
      // The batch is non-atomic: the server returns an index-aligned row per
      // bill, flagging per-bill save failures (saveFailed) and per-bill charge
      // failures (chargeError) rather than aborting. Report the real outcome.
      const saveFailures = rows.filter((b) => b && b.saveFailed);
      // H2: a bill can be SAVED yet fail to charge (bridge error).
      const chargeFailures = rows.filter((b) => b && b.chargeError);
      const savedOk = rows.filter((b) => b && !b.saveFailed).length;

      if (saveFailures.length > 0) {
        // Some bills could not be saved (e.g. duplicate for the period).
        toast.warning(
          t(
            '{{saved}} of {{total}} bills saved. {{failed}} could not be saved (already exist or invalid).',
            {
              saved: savedOk,
              total: rows.length,
              failed: saveFailures.length
            }
          )
        );
      } else if (chargeFailures.length > 0) {
        toast.warning(
          t(
            'Bills saved. {{failed}} could not charge tenants — charge them from the building statement.',
            { failed: chargeFailures.length }
          )
        );
      } else {
        toast.success(
          t('{{count}} bill(s) imported successfully', {
            count: savedOk || billsToConfirm.length
          })
        );
      }
      // The bills saved regardless, but if the source PDF archive failed for
      // some, tell the user (the file just isn't stored in the document
      // archive — they can re-attach it later).
      if (archiveFailures > 0) {
        toast.warning(
          t('{{failed}} source file(s) could not be archived.', {
            failed: archiveFailures
          })
        );
      }
      handleClose();
    } catch (error) {
      console.error('Bill confirm error:', error);
      toast.error(t('Failed to save bills'));
      setState('preview');
    }
  }, [
    results,
    files,
    resolvedAssignment,
    replaceFlags,
    chargeFlags,
    // Was MISSING: effectiveAmount() reads amountOverrides, so without it the
    // memoised callback closed over the pre-edit map and a corrected OCR amount
    // was silently discarded — the misread figure was saved and bridged into
    // every tenant's rent, while the input kept showing the correction and the
    // toast reported success. This defeated the whole point of the editable
    // amount field. (assignments is reached via resolvedAssignment, which
    // already depends on it.)
    amountOverrides,
    buildings,
    building,
    handleClose,
    queryClient,
    t
  ]);

  const handleToggleReplace = useCallback((uid) => {
    setReplaceFlags((prev) => ({
      ...prev,
      [uid]: !prev[uid]
    }));
  }, []);

  const handleToggleCharge = useCallback((uid) => {
    setChargeFlags((prev) => ({
      ...prev,
      [uid]: !prev[uid]
    }));
  }, []);

  const confirmableCount = results.filter(
    (r) => r.success && !!resolvedAssignment(r)
  ).length;
  const failedCount = results.filter((r) => !r.success).length;
  const unassignedCount = results.filter(
    (r) => r.success && !resolvedAssignment(r)
  ).length;
  const isLoading = state === 'loading' || state === 'confirming';

  // Elapsed seconds while parsing. Reset on each run; the interval is cleared on
  // unmount and whenever the state leaves 'loading', so it cannot outlive the
  // dialog or keep ticking behind a closed one.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (state !== 'loading') {
      setElapsedSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    const id = setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [state]);

  return (
    <>
      <ResponsiveDialog
        open={!!open}
        setOpen={setOpen}
        isLoading={isLoading}
        /* The shared default is `max-w-lg` (512px). MEASURED as the root cause of
           this card's proportions: at 512px a QR big enough to actually scan takes
           ~43% of the row, so every value was squeezed into the remainder — the
           παροχή broke mid-number, the period split across three lines, and both the
           amount input and the RF code were clipped off the right edge. Widened for
           this dialog only; the mobile drawer branch is unaffected. */
        className="sm:max-w-3xl"
        renderHeader={() => t('Import Bills')}
        renderContent={() => (
          <div className="pt-4 space-y-4">
            {(state === 'idle' || state === 'loading') && (
              <FileDropZone
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                files={files}
                onFilesChange={setFiles}
                disabled={isLoading}
                dropLabel={t('Drop PDF or photos here or click to browse')}
                description={t(
                  'Up to 5 files at a time — PDF, JPG, PNG or WEBP. Max 15MB per file, 45MB in total.'
                )}
              />
            )}

            {/* OCR is SLOW and the wait is otherwise unexplained: measured
                ~51s for a single scanned A4 page on the NAS (weak CPU; WASM
                threading verified working — 3 threads pinned at 100%). Without
                this the operator sees a spinner for minutes on a 7-file batch
                and reasonably concludes the app has hung. The count is real; a
                per-file bar is not possible because the batch is ONE request
                that returns all results together. */}
            {state === 'loading' && files.length > 0 && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-medium">
                    {t('Reading {{count}} file(s)…', { count: files.length })}
                  </div>
                  {/* A LIVE counter, not just a sentence. The measured wait is
                      ~50s for one page, and a static "about a minute" cannot tell
                      the landlord whether the request is still alive at second 45
                      — which is exactly when they start wondering if it hung. */}
                  <div className="font-mono text-xs text-muted-foreground tabular-nums">
                    {elapsedSeconds}s
                  </div>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t(
                    'Text recognition takes about a minute per file. Do not close this window.'
                  )}
                </div>
              </div>
            )}

            {state === 'preview' && results.length > 0 && (
              <div className="space-y-4 max-h-[60vh] overflow-y-auto">
                <div className="flex gap-2 flex-wrap">
                  {confirmableCount > 0 && (
                    <Badge variant="default" className="gap-1">
                      <LuCheckCircle className="size-3" />
                      {confirmableCount} {t('ready')}
                    </Badge>
                  )}
                  {unassignedCount > 0 && (
                    <Badge variant="secondary" className="gap-1">
                      <LuAlertTriangle className="size-3" />
                      {unassignedCount} {t('need assignment')}
                    </Badge>
                  )}
                  {failedCount > 0 && (
                    <Badge variant="destructive" className="gap-1">
                      <LuFileWarning className="size-3" />
                      {/* Greek needs the VERB to agree with the count: «1
                          απέτυχε» but «2 απέτυχαν». The bare `t('failed')` key
                          is an adjective/verb fragment shared with other
                          surfaces, and rendering "2 απέτυχε" is a visible
                          grammar error on the screen the landlord reads. */}
                      {t('{{count}} failed', { count: failedCount })}
                    </Badge>
                  )}
                </div>

                {results.map((result) => (
                  <ResultCard
                    key={result._uid}
                    result={result}
                    buildings={buildings}
                    openedFromBuilding={building}
                    assignment={assignments[result._uid]}
                    onAssignBuilding={assignBuilding}
                    onAssignExpense={assignExpense}
                    onCreateExpense={handleCreateExpense}
                    onToggleReplace={handleToggleReplace}
                    replaceFlags={replaceFlags}
                    chargeFlags={chargeFlags}
                    onToggleCharge={handleToggleCharge}
                    amountOverride={amountOverrides[result._uid]}
                    onAmountChange={handleAmountChange}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        renderFooter={() => (
          <>
            <Button variant="outline" onClick={handleClose}>
              {t('Cancel')}
            </Button>
            {state === 'idle' && files.length > 0 && (
              <Button onClick={handleParse} data-cy="parseBills">
                {t('Continue')}
              </Button>
            )}
            {state === 'preview' && confirmableCount > 0 && (
              <Button onClick={handleConfirm} data-cy="confirmBills">
                {t('Confirm Import')} ({confirmableCount})
              </Button>
            )}
          </>
        )}
      />

      {/* Inline create-expense: the SAME ExpenseFormDialog, pre-filled, add mode. */}
      {createFor && (
        <ExpenseFormDialog
          open={!!createFor}
          setOpen={(v) => {
            if (!v) setCreateFor(null);
          }}
          expense={createPrefill}
          building={createFor.building}
          onCreated={handleExpenseCreated}
        />
      )}
    </>
  );
}
