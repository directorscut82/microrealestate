import { parseDehBill } from '../managers/billparser/deh.js';
import {
  detectProvider,
  looksLikeFullBillText
} from '../managers/billparser/index.js';
import { normalizeBillingId } from '../managers/billparser/types.js';

// Simulated text extraction from the actual DEH bill PDF
const DEH_BILL_TEXT = `999000935031
ΑΔΜΗΕ-ΔΕΔΔΗΕ ....: 15,69
ΥΚΩ..............: 13,13
ΕΤΜΕΑΡ...........: 12,24
ΔΕΗ A.E.
Χαλκοκονδύλη 30, 104 32 Αθήνα,
Α.Φ.Μ. 090000045, Δ.Ο.Υ. ΦΑΕ ΑΘΗΝΩΝ
dei.gr
ΔΟΚΙΜΗ ΚΑΠΠΑ
ΟΔΟΣ ΗΤΑ 24
199 47 ΔΟΚΙΜΑΙ
Κωδικός ηλεκτρονικής πληρωμής
RF33999000000000000000001
000000186,21 3
Εκκαθαριστικός λογαριασμός
Τιμολόγιο: Γ21 Επαγγελματικό
Διεύθυνση ακινήτου: ΟΔΟΣ ΗΤΑ 24 199 47 ΔΟΚΙΜΑΙ
Αριθμός παροχής 9 99000935-03 2
Χρεώσεις προμήθειας ΔΕΗ 115,81€
Ρυθμιζόμενες χρεώσεις 41,06€
Διάφορα - Δήμος - ΕΡΤ 19,71€
ΦΠΑ 9,63€
Συνολικό ποσό πληρωμής *186,21€
ΠΟΣΟ ΠΛΗΡΩΜΗΣ *186,21€
ΕΞΟΦΛΗΣΗ ΕΩΣ 22/04/2026
Κατανάλωση Ηλεκτρικής Ενέργειας 720 kWh
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026
Ημέρες 27
Ημ/νία Έκδοσης 27/03/2026
Α/Α Λογαριασμού 1485399694`;

const DEH_BILL_TEXT_ABBREVIATED = `ΔΕΗ A.E.
dei.gr
Αρ. παροχής: 9 99000935-03 2
Συνολικό ποσό πληρωμής *1.186,21€
ΕΞΟΦΛΗΣΗ ΕΩΣ 22/04/2026
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026
Ημ/νία Έκδοσης 27/03/2026
RF33999000000000000000001`;

const DEH_BILL_TEXT_LARGE_AMOUNT = `ΔΕΗ A.E.
dei.gr
Αριθμός παροχής 9 99000935-03 2
Συνολικό ποσό πληρωμής *12.345,67€
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026
Ημ/νία Έκδοσης 27/03/2026`;

const DEH_BILL_TEXT_SPACED_AMOUNTS = `ΔΕΗ A.E.
dei.gr
Αριθμός παροχής 9 99000935-03 2
Συνολικό ποσό πληρωμής * 186 , 21€
ΕΞΟΦΛΗΣΗ ΕΩΣ 22/04/2026
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026
Ημ/νία Έκδοσης 27/03/2026
RF33999000000000000000001`;

describe('DEH Bill Parser', () => {
  describe('parseDehBill', () => {
    it('should parse billing ID correctly', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.success).toBe(true);
      expect(result.bill?.billingId).toBe('9 99000935-03 2');
    });

    it('should normalize billing ID', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.billingIdNormalized).toBe('999000935032');
    });

    it('should extract total amount', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.totalAmount).toBe(186.21);
    });

    it('should handle spaced amounts (186 , 21)', () => {
      const result = parseDehBill(DEH_BILL_TEXT_SPACED_AMOUNTS);
      expect(result.success).toBe(true);
      expect(result.bill?.totalAmount).toBe(186.21);
    });

    it('should handle abbreviated billing ID format (Αρ. παροχής:)', () => {
      const result = parseDehBill(DEH_BILL_TEXT_ABBREVIATED);
      expect(result.success).toBe(true);
      expect(result.bill?.billingId).toBe('9 99000935-03 2');
    });

    it('should parse amounts >= 1000 with dot as thousands separator', () => {
      const result = parseDehBill(DEH_BILL_TEXT_ABBREVIATED);
      expect(result.success).toBe(true);
      expect(result.bill?.totalAmount).toBe(1186.21);
    });

    it('should parse large amounts with multiple dots (12.345,67)', () => {
      const result = parseDehBill(DEH_BILL_TEXT_LARGE_AMOUNT);
      expect(result.success).toBe(true);
      expect(result.bill?.totalAmount).toBe(12345.67);
    });

    it('should extract consumption period', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.periodStart).toEqual(new Date(Date.UTC(2026, 1, 25)));
      expect(result.bill?.periodEnd).toEqual(new Date(Date.UTC(2026, 2, 23)));
    });

    it('should extract issue date', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.issueDate).toEqual(new Date(Date.UTC(2026, 2, 27)));
    });

    it('should extract due date', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.dueDate).toEqual(new Date(Date.UTC(2026, 3, 22)));
    });

    it('should parse dates in UTC (regression: term must not land on wrong month)', () => {
      // C4 regression guard: parseGreekDate must use Date.UTC, not local time.
      // On Athens summer (UTC+3), a local Date for 01/08/2026 becomes
      // 2026-07-31T21:00Z, whose getUTCMonth() is JULY not AUGUST — landing the
      // bill on the wrong month. Assert the UTC hour is 0 so the date is anchored
      // to UTC midnight regardless of the machine's timezone.
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.periodStart.getUTCHours()).toBe(0);
      expect(result.bill?.periodStart.getUTCDate()).toBe(25);
      expect(result.bill?.periodStart.getUTCMonth()).toBe(1); // February
      expect(result.bill?.periodEnd.getUTCMonth()).toBe(2); // March
    });

    it('should extract RF code', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.rfCode).toBe('RF33999000000000000000001');
    });

    it('should extract payment code', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.paymentCode).toBe('000000186213');
    });

    // O5 — a checksum-invalid RF (OCR digit swap) must NOT be accepted; it
    // would otherwise be encoded into the IRIS payment QR → bank transfer to a
    // wrong reference. rfCode comes back undefined; the rest still parses.
    it('O5: rejects an RF that fails the ISO-11649 mod-97 checksum', () => {
      const bad = DEH_BILL_TEXT.replace(
        'RF33999000000000000000001',
        'RF36999000000000000959051' // last digit swapped → checksum fails
      );
      const result = parseDehBill(bad);
      expect(result.success).toBe(true);
      expect(result.bill?.rfCode).toBeUndefined();
    });

    // O8 — a calendar-invalid OCR date must be rejected, not rolled over
    // (31/02 → March 3 would mis-term the charge one month late).
    it('O8: rejects a calendar-invalid consumption-period date (no rollover)', () => {
      const text = DEH_BILL_TEXT.replace(
        'Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026',
        'Περίοδος Κατανάλωσης 25/02/2026 - 31/02/2026'
      );
      const result = parseDehBill(text);
      // periodEnd 31/02 is invalid → not silently rolled to March 3.
      expect(result.bill?.periodEnd).not.toEqual(
        new Date(Date.UTC(2026, 2, 3))
      );
    });

    it('should set provider to deh', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.provider).toBe('deh');
    });

    it('should fail if no billing ID found', () => {
      const result = parseDehBill('Some random text without data');
      expect(result.success).toBe(false);
      expect(result.error).toContain('αριθμός παροχής');
    });

    it('should fail if no period found', () => {
      const text = `ΔΕΗ A.E.
Αριθμός παροχής 9 99000935-03 2
Συνολικό ποσό πληρωμής *186,21€`;
      const result = parseDehBill(text);
      expect(result.success).toBe(false);
      expect(result.error).toContain('περίοδος');
    });

    it('should fail if no amount found', () => {
      const text = `ΔΕΗ A.E.
Αριθμός παροχής 9 99000935-03 2
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026`;
      const result = parseDehBill(text);
      expect(result.success).toBe(false);
      expect(result.error).toContain('ποσό');
    });

    it('should NOT swallow the next line into the billing ID on the OCR path (regression)', () => {
      // OCR joins page lines with \n. The billing-ID value class must stop at
      // the line end — a following numeric line (a code, a meter reading) must
      // not be absorbed into the provision number. Before the [ \t] fix, the
      // \s class crossed the newline and captured "9 99000935-03 2\n123 45678".
      const text = `ΔΕΗ A.E.
Αριθμός παροχής 9 99000935-03 2
123 45678
Συνολικό ποσό πληρωμής *186,21€
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026`;
      const result = parseDehBill(text);
      expect(result.success).toBe(true);
      expect(result.bill.billingId).toBe('9 99000935-03 2');
      expect(result.bill.billingIdNormalized).toBe('999000935032');
    });
  });

  describe('normalizeBillingId', () => {
    it('should strip spaces', () => {
      expect(normalizeBillingId('9 99000935-03 2')).toBe('999000935032');
    });

    it('should strip dashes', () => {
      expect(normalizeBillingId('9-990-009-35')).toBe('999000935');
    });

    it('should strip dots', () => {
      expect(normalizeBillingId('12.345.678')).toBe('12345678');
    });

    it('should handle already normalized IDs', () => {
      expect(normalizeBillingId('99900093503')).toBe('99900093503');
    });

    it('should match normalized stored vs parsed IDs', () => {
      const stored = normalizeBillingId('9 99000935-03');
      const parsed = normalizeBillingId('9 99000935-03 2');
      // Stored may be a prefix of parsed (check digit variation)
      expect(parsed.startsWith(stored)).toBe(true);
    });
  });

  // Step-7 (recapture-hijack follow-up): the recapture gate treats "a provider
  // marker was recognized" as "this photo IS a full utility bill" so it is NOT
  // swallowed as a single-code re-shot on an unbound session. detectProvider is
  // that signal, and it must fire for EYDAP/EPA too — not just the fully-parsed
  // DEH — or those (ubiquitous) bills leak through the gate.
  describe('detectProvider (recapture-gate signal)', () => {
    it('detects DEH', () => {
      expect(detectProvider(DEH_BILL_TEXT)).toBe('deh');
    });

    it('detects EYDAP (unsupported-but-recognized water bill)', () => {
      expect(detectProvider('ΕΥΔΑΠ Α.Ε.\nΛογαριασμός Ύδρευσης\neydap.gr')).toBe(
        'eydap'
      );
    });

    it('detects EPA / ΔΕΠΑ (unsupported-but-recognized gas bill)', () => {
      expect(detectProvider('Φυσικό Αέριο Αττικής\nΔΕΠΑ')).toBe('epa');
      expect(detectProvider('epa.gr λογαριασμός')).toBe('epa');
    });

    it('returns null for a payment receipt / single-code zoom (no bill marker)', () => {
      // A receipt or an RF-line zoom carries no provider marker → not a bill →
      // the gate must let it through as a possible re-shot.
      expect(
        detectProvider('ΑΠΟΔΕΙΞΗ ΠΛΗΡΩΜΗΣ\nRF33999000000000000000001\n186,21€')
      ).toBeNull();
      expect(detectProvider('RF33999000000000000000001')).toBeNull();
    });
  });

  // Step-7 round-4 residual C: provider-AGNOSTIC full-bill signal. A garbled-OCR
  // DEH scan or an unlisted retailer (no provider marker) must still be caught
  // as a full bill by text VOLUME, so it isn't swallowed as a re-shot on an open
  // recapture session — without false-rejecting a genuine short code-line zoom.
  describe('looksLikeFullBillText (provider-agnostic backstop)', () => {
    it('true for a full DEH bill (hundreds of chars)', () => {
      expect(looksLikeFullBillText(DEH_BILL_TEXT)).toBe(true);
    });

    it('true for an UNLISTED-provider full bill (no marker, still document-sized)', () => {
      // ~400 chars of a bill from a retailer detectProvider does not know.
      const unlisted =
        'ELPEDISON ΛΟΓΑΡΙΑΣΜΟΣ ΡΕΥΜΑΤΟΣ '.repeat(15) +
        'RF12000000000000000000000';
      expect(detectProvider(unlisted)).toBeNull(); // marker gate misses it
      expect(looksLikeFullBillText(unlisted)).toBe(true); // volume gate catches it
    });

    it('false for a genuine single RF-line zoom (short)', () => {
      expect(looksLikeFullBillText('RF33999000000000000000001')).toBe(false);
    });

    it('false for a small multi-line code crop (still under the threshold)', () => {
      expect(
        looksLikeFullBillText(
          'Κωδικός πληρωμής\nRF33999000000000000000001\nGR3301109999990000000000001'
        )
      ).toBe(false);
    });

    it('false for empty / undefined', () => {
      expect(looksLikeFullBillText('')).toBe(false);
      expect(looksLikeFullBillText(undefined)).toBe(false);
    });
  });
});
