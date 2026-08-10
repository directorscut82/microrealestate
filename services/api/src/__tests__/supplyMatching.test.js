/**
 * ΔΕΗ αριθμός-παροχής matching — the money-routing key.
 *
 * WHY THIS EXISTS: on 2026-08-09 a real ΔΕΗ bill parsed perfectly and still
 * matched nothing. The bill prints the παροχή as a 9-digit body + 3-digit check
 * suffix («9 99935585-016»), while every supply number recorded in the live realm
 * is stored as the bare 9 digits (measured 2026-08-10: the length histogram is
 * {"9": 12} — all of them). Strict equality therefore could never link a ΔΕΗ bill
 * to the apartment it belongs to.
 *
 * The loosening is deliberately narrow, because this decides WHICH EXPENSE a bill
 * charges: same 9-digit body counts as the same meter, and nothing else. Callers
 * additionally refuse an AMBIGUOUS body — the live realm already contains two
 * units sharing one body (ΟΔΟΣ ΒΗΤΑ), and `single_unit` bills 100% of an
 * expense to one apartment, so guessing would put a whole bill on the wrong flat.
 */
import { sameSupply, supplyBody } from '../managers/billmanager.js';
import { normalizeBillingId } from '../managers/billparser/index.js';

describe('supplyBody', () => {
  it('takes the 9-digit body of a normalised παροχή', () => {
    expect(supplyBody('999935585016')).toBe('999935585');
    expect(supplyBody('999935585')).toBe('999935585');
  });

  it('refuses anything that is not a 9-12 digit run', () => {
    expect(supplyBody('')).toBeNull();
    expect(supplyBody('12345678')).toBeNull(); // 8 digits — too short
    expect(supplyBody('1234567890123')).toBeNull(); // 13 — too long
    expect(supplyBody('99993558X')).toBeNull(); // not all digits
  });
});

describe('sameSupply', () => {
  it('matches the real bill value against the real stored value', () => {
    // This exact pair is the reported bug: bill vs ΟΔΟΣ ΗΤΑ 24's stored unit.
    const fromBill = normalizeBillingId('9 99935585-016');
    const stored = normalizeBillingId('999935585');
    expect(fromBill).toBe('999935585016');
    expect(stored).toBe('999935585');
    expect(sameSupply(fromBill, stored)).toBe(true);
  });

  it('is insensitive to the printed spacing and dashes', () => {
    const a = normalizeBillingId('9 99935585-016');
    const b = normalizeBillingId('999935585-016');
    expect(sameSupply(a, b)).toBe(true);
  });

  it('still matches two identical values exactly', () => {
    expect(sameSupply('999935585016', '999935585016')).toBe(true);
  });

  it('does NOT match two different meters that share no body', () => {
    // Real neighbouring units on ΟΔΟΣ ΗΤΑ 24 differ in the last body digit.
    expect(sameSupply('999935585', '999935587')).toBe(false);
    expect(sameSupply('999935585016', '999935587016')).toBe(false);
  });

  it('does NOT treat a PREFIX as a match — only a suffix may differ', () => {
    // 8 digits is not a valid body, so a truncated number must never match.
    expect(sameSupply('99993558', '999935585')).toBe(false);
    // …and a longer-than-παροχή run (an ΕΥΔΑΠ document number) has no body.
    expect(sameSupply('202600099990000001', '999935585')).toBe(false);
  });

  it('never matches on empty input', () => {
    expect(sameSupply('', '999935585')).toBe(false);
    expect(sameSupply('999935585', '')).toBe(false);
    expect(sameSupply('', '')).toBe(false);
  });

  it('does not match a ΔΕΗ freephone number against a real παροχή', () => {
    // 800-900-1000 normalises to 9 digits and would otherwise have a "body".
    expect(sameSupply(normalizeBillingId('800-900-1000'), '999935585')).toBe(
      false
    );
  });
});
