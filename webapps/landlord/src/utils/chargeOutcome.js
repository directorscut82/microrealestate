import moment from 'moment';

/**
 * What the bill upload window and the Telegram bell say about a tenant's share of a
 * bill after it is saved. The server reads every share back from the tenants' rents
 * and answers with one entry per unit and tenant (`chargeOutcome` on a confirmed bill:
 * services/api/src/managers/chargecarry.ts, `ShareOutcome`). These helpers turn an
 * entry into what the list shows — in one place, for both surfaces.
 */

/** The name a unit goes by on the building page: its property's name, else its own. */
export function unitNameOf(building, propertyId) {
  // (only units that ARE linked to a property: one that is not has no `propertyId`,
  // and an entry that names no property would be given that unit's name)
  const unit = (building?.units || []).find(
    (u) => u && u.propertyId && String(u.propertyId) === String(propertyId)
  );
  return String(unit?.property?.name || unit?.name || '').trim();
}

// A rent term that names a month — `YYYYMMDDHH`, as a number or as its ten digits in
// text — as a number; null for anything else. What passes is named by greekMonths.js
// from those same digits, so a «✓» is never followed by an empty month. (Text that
// only BEGINS like a month is no term: found by review.)
const monthTerm = (term) => {
  if (typeof term !== 'number' && typeof term !== 'string') return null;
  const n = Number(term);
  const digits = String(n);
  return /^\d{10}$/.test(digits) &&
    moment(digits.slice(0, 6), 'YYYYMM', true).isValid()
    ? n
    : null;
};

/**
 * The month before `term` (YYYYMMDDHH), as a term; null when `term` is no month, or
 * when the month before it is one no term can name.
 */
export function previousTerm(term) {
  const m = moment(String(term ?? '').slice(0, 6), 'YYYYMM', true);
  return m.isValid()
    ? monthTerm(`${m.subtract(1, 'month').format('YYYYMM')}0100`)
    : null;
}

// A finite number — minus zero as zero: «-0,00 €» is no amount — else null.
const figure = (n) => {
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n;
};

/**
 * An amount that can be shown: a finite number, or plain decimal text — else null,
 * which the lists show as «—». Not '', not a boolean, not a list: `Number()` makes 0
 * of those, and «0,00 €» would be a figure nobody gave.
 */
export function amountOf(value) {
  if (typeof value === 'number') return figure(value);
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    return null;
  }
  return figure(Number(value));
}

/**
 * One share, as the lists show it.
 *   charged      it is on a rent (`term`: which month's). Only an entry that says
 *                `billed` or `moved` AND names a month: anything else — a status this
 *                version does not know, a month that is none — reads «not charged»
 *   otherAmount  what that rent holds when that is not the share's amount (the figure
 *                was changed after that rent was closed: a closed rent keeps what it
 *                billed) — else null
 *   why          'monthPaid': it is on the month after `paidTerm`, which the tenant has
 *                paid in full · 'leaseEnded': it is on no rent and none will take it ·
 *                null: nothing more to say (also for a share that is on no rent for
 *                another reason — the list says «not charged» and no more)
 */
export function outcomeView(outcome) {
  const o = outcome || {};
  const term =
    o.status === 'billed' || o.status === 'moved'
      ? monthTerm(o.billedTerm)
      : null;
  if (term === null) {
    return {
      charged: false,
      term: null,
      otherAmount: null,
      why:
        o.status === 'notCharged' && o.reason === 'leaseEnded'
          ? 'leaseEnded'
          : null,
      paidTerm: null
    };
  }
  // (also when the share's own amount is no figure: what the rent holds is still true)
  const held = amountOf(o.billedAmount);
  const own = amountOf(o.amount);
  const otherAmount =
    held !== null && (own === null || Math.abs(held - own) >= 0.005)
      ? held
      : null;
  // («has paid the month before» is said only with a month to name)
  const paidTerm =
    o.status === 'moved' && o.reason === 'monthPaid'
      ? previousTerm(term)
      : null;
  return {
    charged: true,
    term,
    otherAmount,
    why: paidTerm !== null ? 'monthPaid' : null,
    paidTerm
  };
}

/**
 * «The month is closed for the tenants; each one's share went on their next open
 * rent» holds for the whole list: every share went on a LATER rent, or reached none
 * because its tenant's lease has ended (the picture the owner approved has one of
 * each), and at least one did go on a later rent. Not with a share on the bill's own
 * month (that month is not closed for its tenant), and not with one that is on no
 * rent for another reason — in doubt, from before the change, not there yet: of that
 * one the sentence would not be true (found by review).
 */
export function monthClosedForAll(outcomes) {
  // (an empty entry is not listed — ChargeOutcomeList — and is not counted here)
  const list = Array.isArray(outcomes) ? outcomes.filter(Boolean) : [];
  const wentOn = (o) => o.status === 'moved' && outcomeView(o).charged;
  const ended = (o) => outcomeView(o).why === 'leaseEnded';
  return (
    list.length > 0 &&
    list.every((o) => wentOn(o) || ended(o)) &&
    list.some(wentOn)
  );
}
