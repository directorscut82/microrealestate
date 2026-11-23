// A tenant's share of a building charge whose own month is CLOSED for that tenant
// (DEFERRED_DECISIONS D-10): the pieces around the rent engine.
//
// The engine decides where such a share is billed, every time a month is priced, from
// the tenant's stored ledger (businesslogic/tasks/1_base.ts `_carriedInto`). Nothing
// about «where» is stored. What lives here, with no database access so that it can be
// tested as plain functions:
//   · what the statement save notes on the rows it rebuilds (`statementRowsBefore`,
//     `statementRowIdentity`), and what keeps a client from setting the mark
//     (`chargesWithStoredMarks`);
//   · reading a tenant's ledger BACK after the recompute, to report what is really on
//     it (`shareOutcomes`) — nothing is called «charged» unless a rent holds it, and
//     which line stands for which share is decided where the engine decides it
//     (businesslogic/carriedshares.ts `coverRows`);
//   · the key a payment attribution uses for a building line (`buildingLineKey`,
//     `buildingLineOf`).
import { coverRows, heldLinesOf } from '../businesslogic/carriedshares.js';
import type { HeldLine, ShareRow } from '../businesslogic/carriedshares.js';
import moment from 'moment';
import { isClosedRent } from './contract.js';

type AnyRecord = Record<string, any>;

/**
 * What each expense's statement row of a unit-month WAS before the statement save
 * stripped it: its `_id` and its `carry` mark, by expense. The first row of an expense
 * wins (there is one per expense; a second is damage this save repairs).
 */
export function statementRowsBefore(
  rows: AnyRecord[]
): Map<string, { _id: unknown; carry: boolean }> {
  const before = new Map<string, { _id: unknown; carry: boolean }>();
  for (const row of rows || []) {
    if (!row || !row.expenseId) continue;
    const key = String(row.expenseId);
    if (before.has(key)) continue;
    before.set(key, { _id: row._id, carry: row.carry === true });
  }
  return before;
}

/**
 * What a rebuilt statement row keeps of the row it replaces — and what a row that
 * replaces nothing starts with.
 *
 * A share that existed before keeps its `_id` (the carried lines of a rent are ordered
 * by it) and its mark exactly as it was. A share that did NOT exist before this save
 * is marked `carry`: it may be billed on the tenant's next open month when its own is
 * closed for them. Rows written before the mark existed therefore never gain it by
 * being saved again — an old loss is not billed out of the blue, on top of whatever
 * the landlord re-entered by hand since.
 *
 * Each previous row is handed out once: a second row for the same expense in one save
 * is a new share. A row of NO expense is not a share of one: it is never marked.
 */
export function statementRowIdentity(
  before: Map<string, { _id: unknown; carry: boolean }>,
  expenseId: unknown
): { _id?: unknown; carry?: true } {
  if (!expenseId) return {};
  const key = String(expenseId);
  const previous = before.get(key);
  if (!previous) return { carry: true };
  before.delete(key);
  return {
    ...(previous._id !== undefined && previous._id !== null
      ? { _id: previous._id }
      : {}),
    ...(previous.carry ? { carry: true as const } : {})
  };
}

/**
 * A unit's rows as a client sent them, with every `carry` as the STORED row has it.
 *
 * `carry` is the statement save's own mark. The unit endpoints (create a building with
 * its units, add a unit, update a unit) take `monthlyCharges` from the request as it
 * is, so without this a request could put the mark on a row from before the mark
 * existed — and an old share that reached no rent would be billed out of the blue on
 * the tenant's next open month — or take it off a share that is waiting for one.
 *
 * A row keeps the mark only when the stored row with the same `_id` has it AND is the
 * same share (same month, same expense) — and only one row per stored mark. A row that
 * is not stored yet never has it. Anything that is not a list of rows is handed back
 * untouched: the endpoints refuse it first (`unitRowsProblem`).
 */
export function chargesWithStoredMarks(
  incoming: unknown,
  stored: AnyRecord[] | undefined
): unknown {
  if (!Array.isArray(incoming)) return incoming;
  // ids are compared as the database stores them: text, in lower case
  const idOf = (value: unknown) => String(value).toLowerCase();
  const marked = new Map<string, AnyRecord>();
  for (const row of Array.isArray(stored) ? stored : []) {
    if (row && row.carry === true && row._id !== undefined && row._id !== null) {
      marked.set(idOf(row._id), row);
    }
  }
  return incoming.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const { carry: _fromTheClient, ...rest } = row as AnyRecord;
    const id =
      rest._id !== undefined && rest._id !== null ? idOf(rest._id) : null;
    const before = id === null ? undefined : marked.get(id);
    if (
      !before ||
      Number(before.term) !== Number(rest.term) ||
      String(before.expenseId ?? '') !== String(rest.expenseId ?? '')
    ) {
      return rest;
    }
    // one stored mark, one row: the same id sent twice does not make a second share
    marked.delete(id as string);
    return { ...rest, carry: true };
  });
}

/**
 * Is `body` — a unit as a client sent it — free of any way to reach a row's `carry`
 * that `chargesWithStoredMarks` does not see, and of rows the database would hold
 * otherwise than they were sent? Returns what is wrong, or null.
 *
 *   · The rows must be a LIST of row objects: the schema turns a single row object
 *     into a list of one, behind the back of that function.
 *   · Nothing may address them by path (`monthlyCharges.0.carry`).
 *   · A row's `_id` and `expenseId` are text, its `term` a number or text: the schema
 *     casts `{ _id: X }` back to X, so such a row kept its identity while the function
 *     above, which had read it as another row, took its mark away.
 *   · No two rows share an `_id`: a row is removed by its id, and removing one of two
 *     that share it removes both — the other one's share with it.
 */
export function unitRowsProblem(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const unit = body as AnyRecord;
  if (
    Object.keys(unit).some(
      (key) => key !== 'monthlyCharges' && key.split('.')[0] === 'monthlyCharges'
    )
  ) {
    return 'monthlyCharges cannot be addressed by path';
  }
  if (unit.monthlyCharges === undefined) return null;
  if (
    !Array.isArray(unit.monthlyCharges) ||
    unit.monthlyCharges.some(
      (row) => !row || typeof row !== 'object' || Array.isArray(row)
    )
  ) {
    return 'monthlyCharges must be a list of rows';
  }
  // (text as a request sends it; or the database's own id object, which only code on
  // the server can hand over — a request cannot send a function)
  const text = (value: unknown) =>
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof (value as AnyRecord).toHexString === 'function';
  const seen = new Set<string>();
  for (const row of unit.monthlyCharges as AnyRecord[]) {
    if (
      !text(row._id) ||
      !text(row.expenseId) ||
      !text(row.repairId) ||
      !(text(row.term) || typeof row.term === 'number')
    ) {
      return 'the _id, expenseId, repairId and term of a monthlyCharges row must be plain values';
    }
    if (row._id === undefined || row._id === null) continue;
    // (the schema reads a text of twelve characters as an id too — as another id than
    // the one it is compared with here)
    if (typeof row._id === 'string' && !/^[0-9a-fA-F]{24}$/.test(row._id)) {
      return 'the _id of a monthlyCharges row must be 24 hex characters';
    }
    const id = String(row._id).toLowerCase();
    if (seen.has(id)) return 'two monthlyCharges rows have the same _id';
    seen.add(id);
  }
  return null;
}

/**
 * A row that carries the mark is a share of a monthly statement: the statement save
 * wrote it, and only the statement save may make it another share. What a request may
 * change on it is its amount. Its month, its expense and its description say WHICH
 * share it is — the description is what an old rent line is recognised by — and a
 * request that changed one of them either kept the mark on what was now another share
 * (billed as a late share of a month it never belonged to, or billed twice) or lost it
 * for good when the change was undone (found by review, each way).
 *
 * `changed`: the row as the request wants it — only the fields it sends. `stored`: the
 * row as it is. Returns what is wrong, or null.
 */
export function markedRowProblem(
  changed: AnyRecord,
  stored: AnyRecord | undefined | null
): string | null {
  if (!stored || stored.carry !== true || !changed) return null;
  const differs =
    ('term' in changed && Number(changed.term) !== Number(stored.term)) ||
    ('expenseId' in changed &&
      String(changed.expenseId ?? '') !== String(stored.expenseId ?? '')) ||
    ('repairId' in changed &&
      String(changed.repairId ?? '') !== String(stored.repairId ?? '')) ||
    ('description' in changed &&
      String(changed.description ?? '') !== String(stored.description ?? ''));
  return differs
    ? 'a share of a monthly statement can only change its amount here: its month, expense and description are changed by saving the monthly statement'
    : null;
}

/**
 * The same for a unit's rows as a request sends them: each against the stored row with
 * its `_id`. The unit endpoints REPLACE a unit's rows by the ones sent, so a field that
 * a row leaves out is a field it changes — to nothing: a marked row sent back without
 * its description would no longer read like the old line that covers it.
 */
export function markedRowsProblem(
  incoming: unknown,
  stored: AnyRecord[] | undefined
): string | null {
  if (!Array.isArray(incoming)) return null;
  const byId = new Map<string, AnyRecord>();
  for (const row of Array.isArray(stored) ? stored : []) {
    if (row && row._id !== undefined && row._id !== null) {
      byId.set(String(row._id).toLowerCase(), row);
    }
  }
  for (const row of incoming as AnyRecord[]) {
    if (!row || typeof row !== 'object' || row._id === undefined || row._id === null) {
      continue;
    }
    const problem = markedRowProblem(
      {
        term: row.term,
        expenseId: row.expenseId,
        repairId: row.repairId,
        description: row.description
      },
      byId.get(String(row._id).toLowerCase())
    );
    if (problem) return problem;
  }
  return null;
}

/**
 * The key a payment attribution uses for a building line of a rent.
 *
 * A line of the month itself is named by its position (`building:<i>`), as it always
 * was. A share carried in from an earlier month comes after those lines and can be
 * joined or left by others at any time (another late bill, a figure saved as 0), so a
 * position would end up pointing at another line: it is named by what it IS —
 * `building:<propertyId>:<expenseId>:<YYMM>`, the month it is for as two digits of
 * the year and two of the month (`…:2610` = October 2026).
 *
 * SHORT ON PURPOSE. With database ids this is 63 characters. Every version of the app
 * refuses, when a month's payments are saved again, an attribution key longer than 64
 * (rentmanager.ts) — so a key with the full ten-digit month (69 characters), once
 * stored, would lock the payments of that month for good after a rollback to any
 * earlier version. Nothing reads the parts back: a key is only ever compared whole.
 *
 * The landlord app builds the same keys (webapps/landlord/src/utils/paymentAllocation.js
 * `buildingLineKey`): keep the two in step.
 */
export function buildingLineKey(line: AnyRecord, index: number): string {
  return Number.isInteger(line?.forTerm) && line?.expenseId && line?.propertyId
    ? `building:${line.propertyId}:${line.expenseId}:${_yearMonth(line.forTerm)}`
    : `building:${index}`;
}

// 2026100100 → «2610»
const _yearMonth = (term: number): string =>
  String(Math.floor(term / 10000) % 10000).padStart(4, '0');

/**
 * The building line of `rent` that a saved attribution key names, or null when the
 * line has gone. A position names a line of the month itself only — never a carried
 * one that has since slid into that position — and is read as the number it is, as it
 * always was (`building:01` is position 1).
 */
export function buildingLineOf(
  rent: AnyRecord,
  lineKey: unknown
): AnyRecord | null {
  const lines: AnyRecord[] = Array.isArray(rent?.buildingCharges)
    ? rent.buildingCharges
    : [];
  const key = String(lineKey ?? '');
  const position = /^building:(\d+)$/.exec(key);
  if (position) {
    const index = Number(position[1]);
    const line = lines[index];
    return line && buildingLineKey(line, index) === `building:${index}`
      ? line
      : null;
  }
  const at = lines.findIndex(
    (line, index) => buildingLineKey(line, index) === key
  );
  return at === -1 ? null : lines[at];
}

const _month = (term: unknown): moment.Moment =>
  moment.utc(String(term), 'YYYYMMDDHH', true);

/** Does the tenant's own window for `propertyId` contain the month `term`? */
export function heldUnitIn(
  tenant: AnyRecord,
  propertyId: string,
  term: number
): boolean {
  const month = _month(term);
  if (!month.isValid()) return false;
  return (tenant?.properties || []).some((p: AnyRecord) => {
    if (!p || String(p.propertyId) !== propertyId) return false;
    return month.isBetween(
      moment.utc(p.entryDate).startOf('day'),
      moment.utc(p.exitDate).endOf('day'),
      'months',
      '[]'
    );
  });
}

export type ShareOutcome = {
  propertyId: string;
  tenantId: string;
  tenantName: string;
  expenseId: string;
  // the month the share is for
  term: number;
  // the unit's share as the building holds it
  amount: number;
  // billed: on its own month · moved: on a later month · notCharged: on no rent, and
  // none is going to take it · missing: it should be on a rent and is not
  status: 'billed' | 'moved' | 'notCharged' | 'missing';
  // the month whose rent holds it, and the amount on that rent
  billedTerm: number | null;
  billedAmount: number | null;
  // why it is not on its own month / not on any
  // (`unclear`: an old line of the month — stored before lines carried ids, or of a
  // deleted expense — may be for this share or for another; it is shown against the
  // likeliest and the others, of which this is one, are not billed again)
  reason?:
    | 'monthPaid'
    | 'monthClosed'
    | 'leaseEnded'
    | 'notCarried'
    | 'unclear'
    | 'recomputeFailed';
};

/**
 * What became of the statement rows of the month `term`, per unit and per tenant who
 * held the unit that month — read from the tenants' STORED rents, after the recompute.
 *
 * Which line of a tenant's ledger stands for which row is the engine's own answer
 * (`coverRows`): a line covers the row of its own unit, and one line covers one row. So
 * a share is never reported as charged on the strength of ANOTHER unit's line while
 * that unit has a row of its own, and one line is never reported twice. All the
 * tenant's units in `units` are looked at together for that reason. A share that an
 * old line MAY be for (`unsure`) is reported as not charged (`unclear`): the engine
 * does not bill it again, and nothing says it was billed.
 *
 * On top of the engine's answer, and for REPORTING only: a line stored before lines
 * carried ids that no row has taken, on the share's own month, with the share's exact
 * amount, is taken to be that share. It is what still recognises such a line after the
 * expense or the building was renamed — wrongly reporting an old share as «not
 * charged» invites charging it again by hand. (The engine never goes by the amount:
 * there a wrong «already billed» loses money.) Two kinds of line are never taken that
 * way, because they are somebody else's: a line that names a unit, and the line of an
 * expense that is billed LIVE that month (`billedLiveNames`).
 *
 * Only monthly leases are looked at (the only ones a share is carried on). A tenant
 * with no rent for that month was not billed for it at all and is left out.
 *
 * `units`: the building's units that are linked to a property, each with its stored
 * rows. `expenseIds`: the expenses the building has today. `billedLiveNames`: the
 * names of the expenses the engine bills live in `term`.
 */
export function shareOutcomes(input: {
  term: number;
  currentTerm: number;
  buildingName?: string;
  units: { propertyId: string; rows: AnyRecord[] }[];
  expenseIds: Iterable<string>;
  // The names of the expenses the engine bills LIVE in `term` — from the expense's own
  // definition (a monthly amount, or fixed amounts per unit) and not from a figure
  // typed in for the month. Such an expense has no row to take its line, so its line
  // is not a share's. Left out, NO line is recognised by its amount.
  billedLiveNames: Iterable<string>;
  tenants: AnyRecord[];
}): ShareOutcome[] {
  const { term, currentTerm } = input;
  const units = (input.units || []).filter((u) => u && u.propertyId);
  const live = new Set(Array.from(input.expenseIds || [], String));
  const billedLive =
    input.billedLiveNames === undefined || input.billedLiveNames === null
      ? null
      : new Set(Array.from(input.billedLiveNames, String));
  const ofThisBuilding = new Set(units.map((u) => String(u.propertyId)));
  const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
  // `unitAt`: which entry of `units` the row is on — two entries can name one property
  // (a known shape of this data), and each row is reported once, with its own entry.
  // `reported`: the tenant held the unit that month. A row of a unit of the tenant's
  // that they did NOT hold that month (an exit date recorded after the month was
  // billed) is asked about all the same — it is what a line of that month was billed
  // for — and is not reported.
  type Share = ShareRow & { amount: number; unitAt: number; reported: boolean };

  const perTenant = (input.tenants || []).map((tenant) => {
    if (!tenant || (tenant.frequency || 'months') !== 'months') return null;
    const rents: AnyRecord[] = Array.isArray(tenant.rents) ? tenant.rents : [];
    const itsMonth = rents.find((r) => Number(r?.term) === term);
    if (!itsMonth) return null;
    const tenantUnits = new Set<string>(
      (Array.isArray(tenant.properties) ? tenant.properties : [])
        .filter((p: AnyRecord) => p && p.propertyId)
        .map((p: AnyRecord) => String(p.propertyId))
    );
    const shares: Share[] = [];
    for (const [unitAt, unit] of units.entries()) {
      const propertyId = String(unit.propertyId);
      if (!tenantUnits.has(propertyId)) continue;
      const reported = heldUnitIn(tenant, propertyId, term);
      for (const row of unit.rows || []) {
        if (!row || Number(row.term) !== term || !row.expenseId || row.repairId) {
          continue;
        }
        const amount = Math.round((Number(row.amount) || 0) * 100) / 100;
        if (amount <= 0) continue;
        shares.push({
          propertyId,
          expenseId: String(row.expenseId),
          month: term,
          marked: row.carry === true,
          description: row.description || 'Building charges',
          buildingName: String(input.buildingName ?? ''),
          created: String(row._id ?? ''),
          amount,
          unitAt,
          reported,
          held: reported
        });
      }
    }
    if (!shares.some((share) => share.reported)) return null;
    // The tenant's lines — without the ones that name a unit of ANOTHER building: seen
    // from here their expense is not among this building's, and they would be taken
    // for lines of a deleted expense and matched by name.
    const held = heldLinesOf(rents).filter(
      (line) => !line.propertyId || ofThisBuilding.has(line.propertyId)
    );
    const { covered: at, unsure } = coverRows(shares, held, live, {
      tenantUnits
    });
    // Reporting only: an old line of the share's own month, by its exact amount — a
    // line that no row has taken because the expense, or the building, was RENAMED
    // since. Not a line that names a unit (it was written after lines carried ids: it
    // is no renamed old line), and not the line of an expense that is billed LIVE that
    // month (its own line: it has no row to take it) — either of them, at the share's
    // amount by chance, called a share that no rent holds «charged» (found by review).
    // Whatever building name such a line carries: after the BUILDING is renamed, every
    // line of its fixed expenses is under the old name.
    // A name that another expense merely HAS today — one whose figure is typed in every
    // month, a new one, one that had ended — hides no renamed line: that expense billed
    // nothing live that month, and the share that WAS billed under the name must not
    // read «not charged» (found by the next review). Nor for a share an old line may
    // be for. With no word on what is billed live, nothing is recognised.
    const taken = new Set<HeldLine>(at.values());
    const renamedSince = (line: HeldLine) =>
      !!billedLive && !line.propertyId && !billedLive.has(line.description);
    for (const share of shares) {
      if (at.has(share) || unsure.has(share) || !share.reported) continue;
      const old = held.find(
        (line) =>
          !taken.has(line) &&
          !line.expenseId &&
          renamedSince(line) &&
          line.rentTerm === term &&
          cents(line.amount) > 0 &&
          cents(line.amount) === cents(share.amount)
      );
      if (old) {
        at.set(share, old);
        taken.add(old);
      }
    }
    return {
      tenant,
      shares: shares.filter((share) => share.reported),
      at,
      unsure,
      monthIsClosed: isClosedRent(itsMonth, currentTerm),
      hasOpenMonth: rents.some(
        (r) =>
          Number(r?.term) >= currentTerm &&
          Number(r?.term) > term &&
          !isClosedRent(r, currentTerm)
      )
    };
  });

  const outcomes: ShareOutcome[] = [];
  for (const [unitAt, unit] of units.entries()) {
    const propertyId = String(unit.propertyId);
    for (const read of perTenant) {
      if (!read) continue;
      for (const share of read.shares) {
        if (share.unitAt !== unitAt) continue;
        const base = {
          propertyId,
          tenantId: String(read.tenant._id),
          tenantName: String(read.tenant.name ?? ''),
          expenseId: share.expenseId,
          term,
          amount: share.amount
        };
        const line = read.at.get(share);
        if (line) {
          const moved = line.rentTerm !== term;
          outcomes.push({
            ...base,
            status: moved ? 'moved' : 'billed',
            billedTerm: line.rentTerm,
            billedAmount: Math.round(line.amount * 100) / 100,
            ...(moved
              ? {
                  reason:
                    term === currentTerm
                      ? ('monthPaid' as const)
                      : ('monthClosed' as const)
                }
              : {})
          });
        } else if (read.unsure.has(share)) {
          // An old line of the month may be for it, or for another: not billed again.
          // Said before anything else — also on a month that is open, or whose rent
          // is stored with its month as text: «missing» would mean a recompute failed.
          outcomes.push({
            ...base,
            status: 'notCharged',
            billedTerm: null,
            billedAmount: null,
            reason: 'unclear'
          });
        } else if (!read.monthIsClosed) {
          // an open month is priced from the building: the line should be there
          outcomes.push({
            ...base,
            status: 'missing',
            billedTerm: null,
            billedAmount: null,
            reason: 'recomputeFailed'
          });
        } else if (!share.marked) {
          // a row from before shares were carried: its closed month never took it
          outcomes.push({
            ...base,
            status: 'notCharged',
            billedTerm: null,
            billedAmount: null,
            reason: 'notCarried'
          });
        } else if (read.hasOpenMonth) {
          outcomes.push({
            ...base,
            status: 'missing',
            billedTerm: null,
            billedAmount: null,
            reason: 'recomputeFailed'
          });
        } else {
          outcomes.push({
            ...base,
            status: 'notCharged',
            billedTerm: null,
            billedAmount: null,
            reason: 'leaseEnded'
          });
        }
      }
    }
  }
  return outcomes;
}

export type MovedInShare = {
  tenantId: string;
  tenantName: string;
  propertyId: string;
  expenseId: string;
  // the month the share is FOR
  forTerm: number;
  amount: number;
  description: string;
  type: string;
};

/**
 * The shares of EARLIER months that the tenants' ledgers bill on the month `term`, for
 * the units in `propertyIds` — what the building page of `term` lists under the tenant
 * who is billed, each marked with the month it is for. Read from the stored rents.
 */
export function sharesMovedInto(input: {
  term: number;
  propertyIds: string[];
  tenants: AnyRecord[];
}): MovedInShare[] {
  const units = new Set((input.propertyIds || []).map(String));
  const moved: MovedInShare[] = [];
  for (const tenant of input.tenants || []) {
    const rent = (Array.isArray(tenant?.rents) ? tenant.rents : []).find(
      (r: AnyRecord) => Number(r?.term) === input.term
    );
    const lines: unknown = rent?.buildingCharges;
    for (const line of (Array.isArray(lines) ? lines : []) as AnyRecord[]) {
      if (
        !line ||
        typeof line !== 'object' ||
        !Number.isInteger(line.forTerm) ||
        !line.expenseId ||
        !units.has(String(line.propertyId ?? ''))
      ) {
        continue;
      }
      const amount = Math.round((Number(line.amount) || 0) * 100) / 100;
      if (amount <= 0) continue;
      moved.push({
        tenantId: String(tenant._id),
        tenantName: String(tenant.name ?? ''),
        propertyId: String(line.propertyId),
        expenseId: String(line.expenseId),
        forTerm: line.forTerm,
        amount,
        description: String(line.description ?? ''),
        type: String(line.type ?? '')
      });
    }
  }
  return moved;
}

/**
 * The building page of the month `term`: the engine's breakdown rows, with what the
 * tenants' ledgers say about them.
 *   · A renter row whose share is NOT simply on that month's rent, at the amount the
 *     row shows, gets `billing` — one entry per tenant who held the unit that month:
 *     `billed` (on this month's rent), `moved` (with the month whose rent holds it),
 *     `notCharged` (`leaseEnded` | `notCarried`) or `missing` (it should be on a rent
 *     and is not: a recompute has not run); each with the amount that rent holds. A row
 *     with no `billing` is on its own month's rent as shown, or nothing certain is known
 *     about it (a live share of a fixed expense: the page says what it always said).
 *   · The shares of EARLIER months that are billed on `term` are added as renter rows
 *     of the tenant who is billed, with `forTerm` (the month each is for) and the
 *     calculation of that month. They sit under the unit's own tenant when that is who
 *     is billed (`groupKey` = the unit); a tenant who has left the unit gets a group of
 *     their own.
 *   · `tenantTotal` is what the tenants' rents of `term` hold: of a row with `billing`,
 *     what was billed on this month (nothing, when the share is on another month's rent
 *     or on none); the shares moved in are in it.
 * With nothing moved and nothing lost, rows and total are exactly the engine's.
 *
 * `units` are the building's units as the page has them (`propertyId`, `tenant`,
 * `property`, `monthlyCharges`); `expenseIds` the expenses the building has today;
 * `billedLiveNames` the names of the ones billed live in `term` (see `shareOutcomes`);
 * `rowOfItsMonth` gives the engine's breakdown row of a unit and expense for another
 * month.
 */
export function placeTenantShares(input: {
  term: number;
  currentTerm: number;
  buildingName?: string;
  units: AnyRecord[];
  expenseIds: Iterable<string>;
  billedLiveNames: Iterable<string>;
  rows: AnyRecord[];
  tenants: AnyRecord[];
  rowOfItsMonth: (
    forTerm: number,
    propertyId: string,
    expenseId: string
  ) => AnyRecord | undefined;
}): { rows: AnyRecord[]; tenantTotal: number } {
  const round = (n: number) => Math.round(n * 100) / 100;
  const rows = input.rows || [];
  const units = (input.units || []).filter((u) => u && u.propertyId);
  const engineTotal = round(
    rows
      .filter((r) => r.recipient === 'renter')
      .reduce((s, r) => s + (Number(r.amount) || 0), 0)
  );
  if (!units.length) return { rows, tenantTotal: engineTotal };

  const outcomes = shareOutcomes({
    term: input.term,
    currentTerm: input.currentTerm,
    buildingName: input.buildingName,
    units: units.map((unit) => ({
      propertyId: String(unit.propertyId),
      rows: ((unit.monthlyCharges || []) as AnyRecord[]).map((c) =>
        typeof c?.toObject === 'function' ? c.toObject() : c
      )
    })),
    expenseIds: input.expenseIds,
    billedLiveNames: input.billedLiveNames,
    tenants: input.tenants
  });
  const movedIn = sharesMovedInto({
    term: input.term,
    propertyIds: units.map((u) => String(u.propertyId)),
    tenants: input.tenants
  });

  // Which outcomes are a row's. A unit can hold two rows of one expense for the month
  // (two entries for it in one statement, or two units naming one property): the
  // outcomes come unit entry by unit entry and, for each tenant, row by row in the
  // order the rows are stored — the order the page's rows of that unit and expense
  // come in. So the n-th such row takes each tenant's n-th outcome. (Handing every row
  // all the outcomes of its unit and expense doubled the month's total.)
  const outcomesOfRow = new Map<string, ShareOutcome[][]>();
  const nthOf = new Map<string, number>();
  for (const o of outcomes) {
    const key = `${o.propertyId}|${o.expenseId}`;
    const n = nthOf.get(`${key}|${o.tenantId}`) || 0;
    nthOf.set(`${key}|${o.tenantId}`, n + 1);
    if (!outcomesOfRow.has(key)) outcomesOfRow.set(key, []);
    const perRow = outcomesOfRow.get(key)!;
    if (!perRow[n]) perRow[n] = [];
    perRow[n].push(o);
  }
  const rowsSeen = new Map<string, number>();

  // A row needs no word when every tenant who held the unit has it on this month's
  // rent at the amount shown. Anything else is said, tenant by tenant — the ones who
  // WERE billed here included: with one tenant billed and another not, leaving the
  // first out made the page read as if nobody had been.
  const placedRows = rows.map((row) => {
    if (row.recipient !== 'renter') return row;
    const key = `${String(row.propertyId)}|${String(row.expenseId)}`;
    const n = rowsSeen.get(key) || 0;
    rowsSeen.set(key, n + 1);
    const its = (outcomesOfRow.get(key) || [])[n] || [];
    const asShown = its.every(
      (o) =>
        o.status === 'billed' &&
        Math.abs((o.billedAmount ?? 0) - (Number(row.amount) || 0)) < 0.005
    );
    if (asShown) return row;
    return {
      ...row,
      billing: its.map((o) => ({
        tenantId: o.tenantId,
        tenantName: o.tenantName,
        status: o.status,
        billedTerm: o.billedTerm,
        billedAmount: o.billedAmount,
        ...(o.reason ? { reason: o.reason } : {})
      }))
    };
  });
  if (!movedIn.length && placedRows.every((row, i) => row === rows[i])) {
    return { rows, tenantTotal: engineTotal };
  }

  const movedRows = movedIn.map((share) => {
    const unit = units.find((u) => String(u.propertyId) === share.propertyId);
    const itsRow = input.rowOfItsMonth(
      share.forTerm,
      share.propertyId,
      share.expenseId
    );
    const sameTenant =
      !!unit?.tenant && String(unit.tenant._id) === share.tenantId;
    return {
      expenseId: share.expenseId,
      expenseName: itsRow?.expenseName || share.description,
      expenseType: itsRow?.expenseType || share.type || undefined,
      allocationMethod: itsRow?.allocationMethod || 'equal',
      propertyId: share.propertyId,
      propertyName:
        unit?.property?.name || unit?.name || String(share.propertyId),
      recipient: 'renter',
      recipientName: share.tenantName,
      tenantId: share.tenantId,
      groupKey: sameTenant
        ? share.propertyId
        : `${share.propertyId}|${share.tenantId}`,
      amount: share.amount,
      // the calculation of its month, only while that month's figure still gives
      // the amount that was billed
      basis:
        itsRow?.basis &&
        Math.abs((Number(itsRow.amount) || 0) - share.amount) < 0.005
          ? itsRow.basis
          : { kind: 'none' },
      forTerm: share.forTerm
    };
  });

  const billedHere = (row: AnyRecord): number =>
    Array.isArray(row.billing)
      ? row.billing
          .filter((b: AnyRecord) => b.status === 'billed')
          .reduce(
            (s: number, b: AnyRecord) => s + (Number(b.billedAmount) || 0),
            0
          )
      : Number(row.amount) || 0;
  const tenantTotal = round(
    placedRows
      .filter((r) => r.recipient === 'renter')
      .reduce((s, r) => s + billedHere(r), 0) +
      movedRows.reduce((s, r) => s + r.amount, 0)
  );
  return { rows: [...placedRows, ...movedRows], tenantTotal };
}
