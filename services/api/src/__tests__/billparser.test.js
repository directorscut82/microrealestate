import { parseDehBill } from '../managers/billparser/deh.js';
import { normalizeBillingId } from '../managers/billparser/types.js';

// Simulated text extraction from the actual DEH bill PDF
const DEH_BILL_TEXT = `700935585031
ΑΔΜΗΕ-ΔΕΔΔΗΕ ....: 15,69
ΥΚΩ..............: 13,13
ΕΤΜΕΑΡ...........: 12,24
ΔΕΗ A.E.
Χαλκοκονδύλη 30, 104 32 Αθήνα,
Α.Φ.Μ. 090000045, Δ.Ο.Υ. ΦΑΕ ΑΘΗΝΩΝ
dei.gr
ΕΠΙΤΡΟΠΟΥ ΑΝΤΩΝΙΟΣ
ΚΑΛΑΜΩΝ 24
111 47 ΓΑΛΑΤΣΙ
Κωδικός ηλεκτρονικής πληρωμής
RF36907738000300008959050
000000186,21 3
Εκκαθαριστικός λογαριασμός
Τιμολόγιο: Γ21 Επαγγελματικό
Διεύθυνση ακινήτου: ΚΑΛΑΜΩΝ 24 111 47 ΓΑΛΑΤΣΙ
Αριθμός παροχής 7 00935585-03 2
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
Αρ. παροχής: 7 00935585-03 2
Συνολικό ποσό πληρωμής *1.186,21€
ΕΞΟΦΛΗΣΗ ΕΩΣ 22/04/2026
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026
Ημ/νία Έκδοσης 27/03/2026
RF36907738000300008959050`;

const DEH_BILL_TEXT_LARGE_AMOUNT = `ΔΕΗ A.E.
dei.gr
Αριθμός παροχής 7 00935585-03 2
Συνολικό ποσό πληρωμής *12.345,67€
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026
Ημ/νία Έκδοσης 27/03/2026`;

const DEH_BILL_TEXT_SPACED_AMOUNTS = `ΔΕΗ A.E.
dei.gr
Αριθμός παροχής 7 00935585-03 2
Συνολικό ποσό πληρωμής * 186 , 21€
ΕΞΟΦΛΗΣΗ ΕΩΣ 22/04/2026
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026
Ημ/νία Έκδοσης 27/03/2026
RF36907738000300008959050`;

describe('DEH Bill Parser', () => {
  describe('parseDehBill', () => {
    it('should parse billing ID correctly', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.success).toBe(true);
      expect(result.bill?.billingId).toBe('7 00935585-03 2');
    });

    it('should normalize billing ID', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.billingIdNormalized).toBe('700935585032');
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
      expect(result.bill?.billingId).toBe('7 00935585-03 2');
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
      expect(result.bill?.periodStart).toEqual(new Date(2026, 1, 25));
      expect(result.bill?.periodEnd).toEqual(new Date(2026, 2, 23));
    });

    it('should extract issue date', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.issueDate).toEqual(new Date(2026, 2, 27));
    });

    it('should extract due date', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.dueDate).toEqual(new Date(2026, 3, 22));
    });

    it('should extract RF code', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.rfCode).toBe('RF36907738000300008959050');
    });

    it('should extract payment code', () => {
      const result = parseDehBill(DEH_BILL_TEXT);
      expect(result.bill?.paymentCode).toBe('000000186213');
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
Αριθμός παροχής 7 00935585-03 2
Συνολικό ποσό πληρωμής *186,21€`;
      const result = parseDehBill(text);
      expect(result.success).toBe(false);
      expect(result.error).toContain('περίοδος');
    });

    it('should fail if no amount found', () => {
      const text = `ΔΕΗ A.E.
Αριθμός παροχής 7 00935585-03 2
Περίοδος Κατανάλωσης 25/02/2026 - 23/03/2026`;
      const result = parseDehBill(text);
      expect(result.success).toBe(false);
      expect(result.error).toContain('ποσό');
    });
  });

  describe('normalizeBillingId', () => {
    it('should strip spaces', () => {
      expect(normalizeBillingId('7 00935585-03 2')).toBe('700935585032');
    });

    it('should strip dashes', () => {
      expect(normalizeBillingId('7-009-355-85')).toBe('700935585');
    });

    it('should strip dots', () => {
      expect(normalizeBillingId('12.345.678')).toBe('12345678');
    });

    it('should handle already normalized IDs', () => {
      expect(normalizeBillingId('70093558503')).toBe('70093558503');
    });

    it('should match normalized stored vs parsed IDs', () => {
      const stored = normalizeBillingId('7 00935585-03');
      const parsed = normalizeBillingId('7 00935585-03 2');
      // Stored may be a prefix of parsed (check digit variation)
      expect(parsed.startsWith(stored)).toBe(true);
    });
  });
});
