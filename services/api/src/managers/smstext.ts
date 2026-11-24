import moment from 'moment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

const _fmt = (n: number) =>
  n.toLocaleString('el-GR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }) + '€';

const _sum = (lines: AnyRecord[]) =>
  lines.reduce((s: number, c: AnyRecord) => s + (c.amount || 0), 0);

/**
 * The month a building-charge line is FOR, as `MM/YYYY`, when the line is a share
 * CARRIED onto this rent from an older month (`forTerm`, DEFERRED_DECISIONS D-10) —
 * else null. The test is the one the printed notice, the e-mail and the landlord's
 * screens use (`Number.isInteger(forTerm)`: pdfgenerator invoicebody.ejs, emailer
 * rentcall bodies, landlord utils/lineLabels.js), so the SMS names a month exactly
 * where they do. On top of it, a `forTerm` that is the rent's own month or is no real
 * month is not a carried share: the line then counts with the month's own charges, and
 * the SMS never prints a date it could not read.
 */
function _carriedMonth(line: AnyRecord, rentTerm: number): string | null {
  const forTerm = line?.forTerm;
  if (!Number.isInteger(forTerm) || forTerm === Number(rentTerm)) return null;
  // strict: ten digits that are a real month, or nothing
  const month = moment.utc(String(forTerm), 'YYYYMMDDHH', true);
  return month.isValid() ? month.format('MM/YYYY') : null;
}

/**
 * The amounts in brackets of the rent SMS, built from the tenant's stored rent of the
 * month: « (Ενοίκιο: 400€, Κοινόχρ: 40€, Κοινόχρ 10/2026: 30€, ΣΥΝΟΛΟ: 470€)».
 *
 * A share carried in from an older month is shown on its own, with the month it is
 * for (owner's decision, 24/11/2026): folded into «Κοινόχρ» it made the month's common
 * charges look higher than the tenant is used to, and the SMS was the one place that
 * did not name the month — the printed notice and the e-mail say «· για Οκτώβριο 2026».
 * One item per month, oldest first.
 *
 * N4 (audit-2026-07): grandTotal = preTaxAmount + charges + buildingCharges + debts −
 * discount + vat + balance (businesslogic 7_total). The items only cover rent +
 * building charges + balance, so everything else is folded into one «Άλλα» remainder
 * computed as (grandTotal − shown items): the breakdown always adds up to ΣΥΝΟΛΟ,
 * whatever the tax / charge mix.
 */
export function rentSmsAmounts(
  rentRecord: AnyRecord | null | undefined
): string {
  if (!rentRecord) return '';
  const grandTotal = rentRecord.total?.grandTotal ?? 0;
  const parts: string[] = [];
  const rentAmount = rentRecord.total?.preTaxAmount ?? 0;
  const buildingCharges = (rentRecord.buildingCharges || []) as AnyRecord[];
  const repairs = buildingCharges.filter((c: AnyRecord) => c.type === 'repair');
  const koinoxrhsta = buildingCharges.filter(
    (c: AnyRecord) => c.type !== 'repair'
  );
  const koinoSum = _sum(koinoxrhsta);
  const repairSum = _sum(repairs);
  const balance = rentRecord.total?.balance ?? 0;

  // the month's own common charges, then each older month's share on its own
  const carried = new Map<string, { term: number; lines: AnyRecord[] }>();
  const own: AnyRecord[] = [];
  for (const line of koinoxrhsta) {
    const month = _carriedMonth(line, rentRecord.term);
    if (!month) {
      own.push(line);
      continue;
    }
    const entry = carried.get(month) || {
      term: Number(line.forTerm),
      lines: []
    };
    entry.lines.push(line);
    carried.set(month, entry);
  }
  const ownSum = _sum(own);

  if (rentAmount) parts.push(`Ενοίκιο: ${_fmt(rentAmount)}`);
  if (ownSum) parts.push(`Κοινόχρ: ${_fmt(ownSum)}`);
  [...carried.entries()]
    .sort((a, b) => a[1].term - b[1].term)
    .forEach(([month, { lines }]) => {
      const sum = _sum(lines);
      if (sum) parts.push(`Κοινόχρ ${month}: ${_fmt(sum)}`);
    });
  if (repairSum) parts.push(`Επισκευή: ${_fmt(repairSum)}`);
  if (balance > 0) parts.push(`Υπόλοιπο: ${_fmt(balance)}`);

  const shownSum =
    rentAmount + koinoSum + repairSum + (balance > 0 ? balance : 0);
  const other = Math.round((grandTotal - shownSum) * 100) / 100;
  if (Math.abs(other) > 0.005) parts.push(`Άλλα: ${_fmt(other)}`);

  return parts.length > 1
    ? ` (${parts.join(', ')}, ΣΥΝΟΛΟ: ${_fmt(grandTotal)})`
    : ` (${_fmt(grandTotal)})`;
}
