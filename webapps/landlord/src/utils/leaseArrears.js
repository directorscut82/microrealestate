const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const yearMonth = (term) => Math.floor(Number(term || 0) / 10000);

// A stored amount is a figure when it is a finite number, or text holding one.
const figure = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// The rows of a ledger in month order, each reduced to its own bill and what
// was paid on its page.
function monthsOf(rents) {
  return [...(rents || [])]
    .filter((r) => r && Number.isFinite(Number(r.term)))
    .sort((a, b) => Number(a.term) - Number(b.term))
    .map((r) => {
      // The month's own bill: its total without what it carried in. A row
      // whose total holds no figure says nothing about its bill; counted as
      // «total 0» it would read as a credit of everything it carried in.
      const total = figure(r.totalToPay);
      return {
        term: Number(r.term),
        own: total === null ? 0 : round2(total - (Number(r.balance) || 0)),
        paid: round2(Number(r.payment) || 0)
      };
    });
}

// Bills in month order; every euro there is — `money` brought in from outside,
// what was paid on any of these months, and a month whose own bill is negative
// (a discount larger than the bill is money in the tenant's favour, exactly
// like a payment) — settles the oldest unpaid bill first.
function settle(months, money = 0) {
  let available = round2(
    money + months.reduce((sum, m) => sum + m.paid + Math.max(0, -m.own), 0)
  );
  const unpaid = months.map((m) => {
    const bill = Math.max(0, m.own);
    const settled = Math.min(bill, available);
    available = round2(available - settled);
    return { term: m.term, own: m.own, unpaid: round2(bill - settled) };
  });
  return { unpaid, left: Math.max(0, available) };
}

/**
 * What each month of a rent ledger still owes, read as ONE account.
 *
 * Rows are what `/rents/tenant/:id` returns: `term`, `totalToPay` (the month's
 * total INCLUDING what it carried in), `balance` (what it carried in) and
 * `payment` (what was paid on that month's page).
 *
 * A row cannot be read on its own. A tenant who is a month behind and pays both
 * months on the second month's page has paid the first month too, yet the first
 * row still says "nothing paid". Asking each row separately counted that month
 * as unpaid: the terminate window offered to write off money that was already
 * in the till, and with the write-off recorded the tenant ended up in credit
 * for money never paid (measured: 800 € really owed, 1.200 € offered and
 * written off, 400 € phantom credit).
 *
 * So: bills in month order, and every euro paid — on whatever month — settles
 * the oldest unpaid bill first. What is left sits on the most recent months,
 * which is where the rents page shows it too.
 *
 * Returns one entry per row, in month order: `{ term, own, unpaid }`. The
 * `unpaid` amounts add up to exactly what the last row still owes
 * (`max(0, totalToPay − payment)`) on a ledger whose carried balances add up.
 */
export function unpaidByMonth(rents) {
  return settle(monthsOf(rents)).unpaid;
}

const tally = (months) =>
  months.reduce(
    (side, m) =>
      m.unpaid > 0.005
        ? { months: side.months + 1, amount: round2(side.amount + m.unpaid) }
        : side,
    { months: 0, amount: 0 }
  );

// The rows that stay on the ledger when the lease ends in `cutYearMonth`.
const keptRows = (rents, cutYearMonth) =>
  (rents || []).filter((r) => r && yearMonth(r.term) <= cutYearMonth);

/**
 * What is still unpaid when a lease is terminated in the month `cutYearMonth`
 * (YYYYMM; null = no date picked yet), split by what the termination does to it:
 * months up to the termination stay on the ledger (`kept`), months after it are
 * deleted (`dropped`). Each side is `{ months, amount }`.
 *
 * `kept` is read from the months that stay, and from nothing else: the months
 * after the termination are deleted with everything on them, so nothing on them
 * can pay for a month that stays. (A credit there — a month whose own bill is
 * negative — goes with its month; a payment there makes the server refuse the
 * termination.) Counting them offered 300 € on a 400 € debt and left 100 € owed
 * on a lease the landlord had asked to write off in full. `kept.amount` is so
 * what the last month that stays will still show once the others are gone.
 *
 * `dropped` is read after it: what the months that stay leave over (an
 * overpayment) does cover the months after them, so a later month an earlier
 * overpayment already covers is not listed as a debt the termination deletes.
 */
export function unpaidAtTermination(rents, cutYearMonth) {
  const months = monthsOf(rents);
  const stays = (m) =>
    cutYearMonth === null ||
    cutYearMonth === undefined ||
    yearMonth(m.term) <= cutYearMonth;
  const kept = settle(months.filter(stays));
  const dropped = settle(
    months.filter((m) => !stays(m)),
    kept.left
  );
  return { kept: tally(kept.unpaid), dropped: tally(dropped.unpaid) };
}

/**
 * True when a month AFTER the termination carries something the landlord
 * recorded on it: a payment, a discount, an extra charge or a note. The server
 * does not delete such a month, so it refuses the termination — the rule is
 * `_isPayment` in services/api/src/managers/contract.ts; keep the two in step —
 * and nothing may be written off before it is asked: the write-off would stay
 * on a lease that was not terminated.
 */
export function recordedAfterTermination(rents, cutYearMonth) {
  return (rents || []).some(
    (r) =>
      yearMonth(r?.term) > cutYearMonth &&
      ((r?.payments || []).some((p) => Number(p?.amount) > 0) ||
        Number(r?.promo) > 0 ||
        Number(r?.extracharge) > 0 ||
        !!r?.description)
  );
}

/**
 * The next month to write off when a lease is terminated in `cutYearMonth`, and
 * the amount, from a FRESH read of the ledger: `{ term, amount }`, or null when
 * nothing is left. `done` holds the terms already written off in this run; each
 * month is written off once. Only the months that stay are read (see
 * unpaidAtTermination).
 *
 * Read the ledger again before every write-off. A write-off on a month changes
 * what every later month carries in, and on a VAT lease it can land a cent off
 * the amount asked for (it is entered gross and stored as a net discount plus
 * its VAT, each rounded). So:
 *   · the amount is never more than the month's total still shows — the server
 *     refuses a discount above it, and above it would be a credit nobody paid;
 *   · what a month already written off in this run still owes (normally a cent
 *     of that rounding) is added to the next one, whose total carries it, so the
 *     lease does not end owing it.
 */
export function nextWriteOff(rents, cutYearMonth, done) {
  const kept = unpaidByMonth(keptRows(rents, cutYearMonth));
  const next = kept.find((m) => !done.has(m.term) && m.unpaid > 0.005);
  if (!next) return null;
  const leftBehind = kept
    .filter((m) => done.has(m.term))
    .reduce((sum, m) => sum + m.unpaid, 0);
  const row = (rents || []).find((r) => Number(r?.term) === next.term);
  const stillShown = Math.max(
    0,
    (Number(row?.totalToPay) || 0) - (Number(row?.payment) || 0)
  );
  return {
    term: next.term,
    amount: round2(Math.min(stillShown, next.unpaid + leftBehind))
  };
}

/**
 * The request that writes `amount` off on one month, for `payRent`:
 * `{ term, payment }`. `row` is that month as the API returns it.
 *
 * The request REPLACES what is stored for the month (rentmanager
 * `_updateByTerm`), so the payments already on it are sent back as they are:
 * a payment left out is deleted, with its date, reference and attribution.
 *
 * The write-off is a discount (`promo`); it becomes a settlement discount on
 * the month and so survives the rebuild the termination then performs. The
 * server honours a month-level discount ONLY when no payment carries one of its
 * own — on such a month a month-level one is silently dropped — so there it is
 * added to the first payment's discount instead.
 */
export function writeOffRequest(row, amount, { tenantId, note }) {
  const term = String(row.term);
  const existing = (row.payments || [])
    .filter((p) => Number(p?.amount) > 0)
    .map((p) => ({
      amount: Number(p.amount) || 0,
      date: p.date || '',
      type: p.type || 'transfer',
      reference: p.reference || '',
      description: p.description || '',
      promo: Number(p.promo) || 0,
      notepromo: p.notepromo || '',
      extracharge: Number(p.extracharge) || 0,
      noteextracharge: p.noteextracharge || '',
      allocation: Array.isArray(p.allocation) ? p.allocation : []
    }));
  const payment = {
    _id: tenantId,
    month: Number(term.slice(4, 6)),
    year: Number(term.slice(0, 4)),
    description: row.description || '',
    extracharge: 0,
    noteextracharge: '',
    promo: 0,
    notepromo: ''
  };
  if (existing.some((p) => p.promo > 0)) {
    payment.payments = existing.map((p, i) =>
      i === 0
        ? {
            ...p,
            promo: round2(p.promo + amount),
            notepromo: p.notepromo ? `${p.notepromo}; ${note}` : note
          }
        : p
    );
  } else {
    payment.payments = existing;
    payment.promo = amount;
    payment.notepromo = note;
  }
  return { term, payment };
}

/**
 * Write off, one month at a time and oldest first, what is still unpaid up to
 * the termination month. `readLedger()` resolves with the rows of the ledger as
 * they are NOW; `record({ term, payment })` sends one month's request. Resolves
 * with the terms it wrote off.
 *
 * The ledger is read again before every month (nextWriteOff says why) — never
 * a copy from before the window was submitted: it may be stale, and a stale
 * `payments` list here would be REPLACED onto the month.
 *
 * It stops, writing nothing more, as soon as the server is going to refuse the
 * termination (recordedAfterTermination).
 *
 * Every pass writes off a month that was not written off before, so it ends
 * within the ledger, however long that is.
 */
export async function writeOffUpToTermination({
  cutYearMonth,
  readLedger,
  record,
  tenantId,
  note
}) {
  const done = new Set();
  const written = [];
  for (;;) {
    const rows = (await readLedger()) || [];
    if (recordedAfterTermination(rows, cutYearMonth)) break;
    const next = nextWriteOff(rows, cutYearMonth, done);
    if (!next) break;
    done.add(next.term);
    if (next.amount <= 0.005) continue;
    const row = rows.find((r) => Number(r?.term) === next.term);
    await record(writeOffRequest(row, next.amount, { tenantId, note }));
    written.push(next.term);
  }
  return written;
}

/**
 * What «Τερματισμός» does once the form is valid: write off first when asked,
 * then terminate. Resolves with what `io.terminate` resolves with; rejects with
 * whatever the server refused.
 *
 *   io.readLedger()               the tenant's ledger as GET /rents/tenant/:id
 *                                 returns it NOW: { rents, … }
 *   io.record({ term, payment })  one month's write-off; resolves with the
 *                                 server's answer, which names the version it
 *                                 left the tenant at (`_tenantVersion`)
 *   io.terminate(tenant)          the tenant update that ends the lease
 *
 * Write off FIRST: once the lease is terminated the months after it are gone,
 * and a write-off recorded before it survives the rebuild (it is a settlement
 * discount, and those are replayed).
 *
 * THE VERSION. Every request here — each write-off and the termination — is
 * sent at the version (`__v`) this window KNOWS the tenant at, and the server
 * refuses (409) a request that names a version which is not the tenant's. The
 * window knows the tenant at the version of the copy it holds; every write-off
 * the server confirms moves that on to the version the answer names. So the
 * chain skips over nothing: once the tenant is saved from anywhere else in a
 * way that moves its version, the next request of this run is refused, and the
 * termination — which saves the whole tenant the window holds — cannot
 * overwrite that edit.
 * (The version was once read back from the server before terminating. That
 * also waved through an edit made in another window: the old copy went out
 * with the new version and was saved over it. And before that, the termination
 * simply went out N versions behind and was refused: measured in the api log,
 * 4× PATCH 200, then the 409.)
 * Two limits, both older than this chain. A save that does not move the
 * version (archiving, the marks of the lease-expiry notices) is not seen, here
 * or by any other save of a tenant. And a copy that names NO version — a
 * tenant stored without one, which the app itself never creates — cannot pin
 * its first write-off: that one goes out as it always did, and the chain
 * starts from its answer.
 *
 * `memory` — `{ wroteOffFor: null, version: null }` to start with, kept for as
 * long as the window is open — holds the version the last confirmed write-off
 * left, for a LATER press: when the first press wrote off and was then refused
 * (a refund above the deposit, say), the second has nothing left to write off,
 * and the copy the window holds is still the old one. If the window has been
 * handed the tenant again since, and that copy is at least as new, the copy is
 * sent as it is. When any request is refused as stale (409) the window no
 * longer knows the tenant's version — the tenant was saved elsewhere, or a
 * write-off of this window was saved without the window learning the version
 * it left (its answer never arrived, or named none): what is remembered is
 * dropped, and the next press sends the tenant as the window then holds it.
 */
export async function terminateLease({
  tenant,
  writeOff,
  cutYearMonth,
  note,
  memory,
  io
}) {
  // The version of the copy the window holds; null when the copy names none.
  const held = figure(tenant.__v);
  const remembered =
    memory.wroteOffFor === tenant._id ? figure(memory.version) : null;
  // The version this window knows the tenant at: the newer of the copy it holds
  // and what its own write-offs left.
  let known = held;
  if (remembered !== null && (held === null || remembered > held)) {
    known = remembered;
  }
  try {
    if (writeOff) {
      await writeOffUpToTermination({
        cutYearMonth,
        tenantId: tenant._id,
        note,
        readLedger: async () => (await io.readLedger())?.rents || [],
        record: async ({ term, payment }) => {
          const saved = await io.record({
            term,
            payment: known === null ? payment : { ...payment, __v: known }
          });
          const left = figure(saved?._tenantVersion);
          if (left === null) {
            // Nothing more can be sent safely: not the next month, not the
            // termination. The ledger is as the server left it.
            memory.wroteOffFor = null;
            memory.version = null;
            throw new Error(
              'The write-off was sent, but its answer does not name the version it left the tenant at.'
            );
          }
          known = left;
          memory.wroteOffFor = tenant._id;
          memory.version = left;
          return saved;
        }
      });
    }
    return await io.terminate(
      known !== null && known !== held ? { ...tenant, __v: known } : tenant
    );
  } catch (error) {
    if (error?.response?.status === 409) {
      memory.wroteOffFor = null;
      memory.version = null;
    }
    throw error;
  }
}
