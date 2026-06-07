import { parseGreekLease } from '../../managers/greekleaseparser.ts';

const SAMPLE_TEXT = `Σελίδα 1 .  ΑΠΟΔΕΙΞΗ ΥΠΟΒΟΛΗΣ ΤΡΟΠΟΠΟΙΗΤΙΚΗΣ ΔΗΛΩΣΗΣ ΠΛΗΡΟΦΟΡΙΑΚΩΝ ΣΤΟΙΧΕΙΩΝ ΜΙΣΘΩΣΗΣ ΑΚΙΝΗΤΗΣ ΠΕΡΙΟΥΣΙΑΣ (ΗΜΕΡΟΜΗΝΙΑ ΔΗΜΙΟΥΡΓΙΑΣ ΤΗΣ ΑΠΟΔΕΙΞΗΣ 19/04/2026)  ΑΡ. ΔΗΛΩΣΗΣ   113532166   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/03/2026 ΤΡΟΠΟΠΟΙΗΣΕ ΤΗ ΔΗΛΩΣΗ   69384208 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   ΕΠΙΤΡΟΠΟΥ ΑΝΤΩΝΙΟΣ (ΑΦΜ Δηλούντος:023691386) Ποσοστό   100 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   ΚΡΑΝΤΑΣ ΕΜΜΑΝΟΥΗΛ (Α.Φ.Μ:145589068) Ημ/νία Αποδοχής 26/03/2026 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 2 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   ΜΑΡΙΝΟΥ ΣΤΑΜΑΤΙΝΑ ΕΙΡΗΝΗ (Α.Φ.Μ:134722733) Ημ/νία Αποδοχής 11/03/2026 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2023
--- PAGE BREAK ---
Σελίδα 2 .  ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Αστική (Κατοικίας)   ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   Δεν έχει υπογραφεί συμφωνητικό ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   450,00 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΕΠΙΤΡΕΠΕΤΑΙ Η ΥΠΕΚΜΙΣΘΩΣΗ ΜΕΣΩ ΗΛΕΚΤ. ΠΛΑΤΦΟΡΜΑΣ ΒΑΣΕΙ ΤΟΥ ΑΡΘΡΟΥ 111, Ν. 4446/2016 ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   02/01/2026 - 01/03/2028 ΣΗΜΕΙΩΣΕΙΣ   --- ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Κατοικία/Διαμέρισμα   ΑΡΙΘΜΟΣ ΑΤΑΚ   00557802406 ΔΙΕΥΘΥΝΣΗ   Όροφος 3 ΣΠΑΡΤΙΑΤΩΝ 9 11147 ΓΑΛΑΤΣΙΟΥ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   129,30 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   450,00 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   703286691 ΣΤΟΙΧΕΙΑ ΕΝΕΡΓΕΙΑΚΟΥ ΠΙΣΤΟΠΟΙΗΤΙΚΟΥ ΓΙΑ ΤΟ ΑΚΙΝΗΤΟ ΜΕ : A/A 1 Α.Μ. ΠΙΣΤΟΠΟΙΗΤΙΚΟΥ   294123   ΗΜΕΡΟΜΗΝΙΑ ΕΚΔΟΣΗΣ   14/12/2022 ΕΝΕΡΓΕΙΑΚΗ ΚΑΤΑΤΑΞΗ   Η   Α.Μ. ΕΠΙΘΕΩΡΗΤΗ   18484
--- PAGE BREAK ---
Σελίδα 3 .  ΔΙΕΥΘΥΝΣΗ ΑΚΙΝΗΤΟΥ   ΣΠΑΡΤΙΑΤΩΝ 9, 11147   , ΓΑΛΑΤΣΙ
--- PAGE BREAK ---`;

describe('parseGreekLease', () => {
  const result = parseGreekLease(SAMPLE_TEXT);

  test('parses declaration number', () => {
    expect(result.declarationNumber).toBe('113532166');
  });

  test('parses submission date', () => {
    expect(result.submissionDate).toBe('01/03/2026');
  });

  test('detects amendment', () => {
    expect(result.isAmendment).toBe(true);
    expect(result.amendsDeclaration).toBe('69384208');
  });

  test('parses landlords', () => {
    expect(result.landlords).toHaveLength(1);
    expect(result.landlords[0]).toEqual({
      name: 'ΕΠΙΤΡΟΠΟΥ ΑΝΤΩΝΙΟΣ',
      taxId: '023691386',
      ownershipPercent: 100
    });
  });

  test('parses multiple tenants', () => {
    expect(result.tenants).toHaveLength(2);
    expect(result.tenants[0]).toEqual({
      name: 'ΚΡΑΝΤΑΣ ΕΜΜΑΝΟΥΗΛ',
      taxId: '145589068',
      acceptanceDate: '26/03/2026'
    });
    expect(result.tenants[1]).toEqual({
      name: 'ΜΑΡΙΝΟΥ ΣΤΑΜΑΤΙΝΑ ΕΙΡΗΝΗ',
      taxId: '134722733',
      acceptanceDate: '11/03/2026'
    });
  });

  test('parses lease dates', () => {
    expect(result.originalStartDate).toBe('01/01/2023');
    expect(result.validityStart).toBe('02/01/2026');
    expect(result.validityEnd).toBe('01/03/2028');
  });

  test('parses lease type and rent', () => {
    expect(result.leaseType).toBe('Αστική (Κατοικίας)');
    expect(result.totalMonthlyRent).toBe(450);
  });

  test('parses empty notes', () => {
    expect(result.notes).toBe('');
  });

  test('parses property', () => {
    expect(result.properties).toHaveLength(1);
    const prop = result.properties[0];
    expect(prop.category).toBe('Κατοικία/Διαμέρισμα');
    expect(prop.type).toBe('apartment');
    expect(prop.atakNumber).toBe('00557802406');
    expect(prop.surface).toBe(129.3);
    expect(prop.monthlyRent).toBe(450);
    expect(prop.dehNumber).toBe('703286691');
  });

  test('parses structured address', () => {
    const addr = result.properties[0].address;
    expect(addr.street1).toBe('ΣΠΑΡΤΙΑΤΩΝ 9, Όροφος 3');
    expect(addr.zipCode).toBe('11147');
    expect(addr.city).toBe('ΓΑΛΑΤΣΙ');
    expect(addr.state).toBe('ΑΘΗΝΑ');
  });

  test('parses energy certificate', () => {
    const cert = result.properties[0].energyCertificate;
    expect(cert).toBeDefined();
    expect(cert.number).toBe('294123');
    expect(cert.issueDate).toBe('14/12/2022');
    expect(cert.energyClass).toBe('Η');
    expect(cert.inspectorNumber).toBe('18484');
  });
});

describe('parseGreekLease - edge cases', () => {
  test('handles non-amendment declaration', () => {
    const text = 'ΑΡ. ΔΗΛΩΣΗΣ   999999   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   15/06/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ (ΑΦΜ Δηλούντος:023691386) Ποσοστό   50 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   ΝΙΚΟΛΑΟΥ ΜΑΡΙΑ (Α.Φ.Μ:444555667) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/06/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Επαγγελματική ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/06/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   800,00 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/06/2025 - 31/05/2027 ΣΗΜΕΙΩΣΕΙΣ   Χωρίς κατοικίδια ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Κατάστημα   ΑΡΙΘΜΟΣ ΑΤΑΚ   12345678901 ΔΙΕΥΘΥΝΣΗ   ΕΡΜΟΥ 15 10563 ΑΘΗΝΑΣ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   85,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   800,00 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   999888777';
    const result = parseGreekLease(text);

    expect(result.isAmendment).toBe(false);
    expect(result.amendsDeclaration).toBeUndefined();
    expect(result.declarationNumber).toBe('999999');
    expect(result.submissionDate).toBe('15/06/2025');
    expect(result.landlords[0].ownershipPercent).toBe(50);
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0].acceptanceDate).toBeUndefined();
    expect(result.notes).toBe('Χωρίς κατοικίδια');
    expect(result.totalMonthlyRent).toBe(800);
    expect(result.properties[0].type).toBe('store');
    expect(result.properties[0].address.street1).toBe('ΕΡΜΟΥ 15');
    expect(result.properties[0].address.zipCode).toBe('10563');
  });

  test('handles empty text', () => {
    const result = parseGreekLease('');
    expect(result.declarationNumber).toBe('');
    expect(result.tenants).toHaveLength(0);
    expect(result.properties).toHaveLength(0);
  });
});

// P2.4 / M7: Αποθήκη must map to 'storage' (matches PROPERTY_TYPES enum
// in services/api/src/validators.ts) — previously aliased to 'store' which
// conflated cellars with retail spaces.
describe('parseGreekLease - P2.4 storage category', () => {
  test('maps Αποθήκη to storage', () => {
    const text =
      'ΑΡ. ΔΗΛΩΣΗΣ   123   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/01/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ (ΑΦΜ Δηλούντος:023691386) Ποσοστό   100 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   ΝΙΚΟΛΑΟΥ ΜΑΡΙΑ (Α.Φ.Μ:444555667) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Επαγγελματική ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/01/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/01/2025 - 31/12/2025 ΣΗΜΕΙΩΣΕΙΣ   --- ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Αποθήκη   ΑΡΙΘΜΟΣ ΑΤΑΚ   00112233445 ΔΙΕΥΘΥΝΣΗ   ΕΡΜΟΥ 15 10563 ΑΘΗΝΑΣ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   12,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   123';
    const result = parseGreekLease(text);
    expect(result.properties[0].type).toBe('storage');
  });
});

// P2.7 / L2: floor regex must not leak Σοφίτα / Ημιόροφος / Πατάρι etc.
// into street1 (it gets appended at the end after a comma — same shape as
// "ΣΠΑΡΤΙΑΤΩΝ 9, Όροφος 3" — but it must NOT appear in the street-name
// portion before the first comma).
describe('parseGreekLease - P2.7 extended floor tokens', () => {
  test('strips Σοφίτα out of street name and surfaces it as floor', () => {
    const text =
      'ΑΡ. ΔΗΛΩΣΗΣ   124   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/01/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   Α (ΑΦΜ Δηλούντος:023691386) Ποσοστό   100 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   Β (Α.Φ.Μ:444555667) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Αστική (Κατοικίας) ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/01/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/01/2025 - 31/12/2025 ΣΗΜΕΙΩΣΕΙΣ   --- ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Κατοικία   ΑΡΙΘΜΟΣ ΑΤΑΚ   00112233446 ΔΙΕΥΘΥΝΣΗ   Σοφίτα ΣΠΑΡΤΙΑΤΩΝ 9 11147 ΓΑΛΑΤΣΙΟΥ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   30,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   123';
    const result = parseGreekLease(text);
    const addr = result.properties[0].address;
    expect(addr.floor).toMatch(/Σοφίτα/i);
    // street1 has shape "<street name>, <floor>"; the street-name portion
    // (before the first comma) must NOT contain the floor token. This is
    // the exact bug the fix targets — without it, "Σοφίτα" leaked into the
    // street-name half of the field.
    const streetNamePortion = addr.street1.split(',')[0].toLowerCase();
    expect(streetNamePortion).not.toMatch(/σοφίτα/);
    expect(streetNamePortion).toContain('σπαρτιατων');
    expect(addr.zipCode).toBe('11147');
  });
});

// P2.6 / L1: parseGreekDecimal must treat "1.234" (dot-only, no decimal
// comma) as 1234, not as 1.234. Exercised via the totalMonthlyRent /
// monthlyRent fields which run every parsed amount through parseGreekDecimal.
describe('parseGreekLease - P2.6 dot-only thousands', () => {
  test('parses 1.234,56 as 1234.56 and 1.234 (no comma) as 1234', () => {
    // 1.234 without a decimal comma should yield 1234, not 1.234.
    const text =
      'ΑΡ. ΔΗΛΩΣΗΣ   200   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/01/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   Α (ΑΦΜ Δηλούντος:023691386) Ποσοστό   100 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   Β (Α.Φ.Μ:444555667) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Επαγγελματική ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/01/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   1.234 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/01/2025 - 31/12/2025 ΣΗΜΕΙΩΣΕΙΣ   --- ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Γραφείο   ΑΡΙΘΜΟΣ ΑΤΑΚ   00112233500 ΔΙΕΥΘΥΝΣΗ   ΕΡΜΟΥ 15 10563 ΑΘΗΝΑΣ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   50,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   1.234 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   123';
    const result = parseGreekLease(text);
    expect(result.totalMonthlyRent).toBe(1234);
    expect(result.properties[0].monthlyRent).toBe(1234);
  });

  test('still parses 1.234,56 as 1234.56 (comma decimal preserved)', () => {
    const text =
      'ΑΡ. ΔΗΛΩΣΗΣ   201   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/01/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   Α (ΑΦΜ Δηλούντος:023691386) Ποσοστό   100 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   Β (Α.Φ.Μ:444555667) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Επαγγελματική ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/01/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   1.234,56 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/01/2025 - 31/12/2025 ΣΗΜΕΙΩΣΕΙΣ   --- ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Γραφείο   ΑΡΙΘΜΟΣ ΑΤΑΚ   00112233501 ΔΙΕΥΘΥΝΣΗ   ΕΡΜΟΥ 15 10563 ΑΘΗΝΑΣ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   50,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   1.234,56 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   123';
    const result = parseGreekLease(text);
    expect(result.totalMonthlyRent).toBeCloseTo(1234.56, 2);
    expect(result.properties[0].monthlyRent).toBeCloseTo(1234.56, 2);
  });
});

// P2.2 / M1: parseAddress must anchor on the 5-digit zip even when the
// street name contains commas (e.g. "ΛΕΩΦ. ΑΛΕΞΑΝΔΡΑΣ 12, ΥΠ' ΑΡ. 3").
// Without the zip-anchor change a comma inside the street caused the
// city/state mapping to shift one slot left.
describe('parseGreekLease - P2.2 zip-anchored address parsing', () => {
  test('parses an address with commas inside the street name', () => {
    const text =
      'ΑΡ. ΔΗΛΩΣΗΣ   210   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/01/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   Α (ΑΦΜ Δηλούντος:023691386) Ποσοστό   100 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   Β (Α.Φ.Μ:444555667) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Επαγγελματική ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/01/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/01/2025 - 31/12/2025 ΣΗΜΕΙΩΣΕΙΣ   --- ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Γραφείο   ΑΡΙΘΜΟΣ ΑΤΑΚ   00112233510 ΔΙΕΥΘΥΝΣΗ   ΛΕΩΦ. ΑΛΕΞΑΝΔΡΑΣ 12, ΥΠ\' ΑΡ. 3 11522 ΑΘΗΝΩΝ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   50,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   123';
    const result = parseGreekLease(text);
    const addr = result.properties[0].address;
    expect(addr.zipCode).toBe('11522');
    expect(addr.street1).toContain('ΛΕΩΦ');
    expect(addr.street1).toContain('ΑΛΕΞΑΝΔΡΑΣ');
    // City must be the genitive-stripped tail before the final comma.
    // ΑΘΗΝΩΝ → ΑΘΗΝΑ via the existing -ΩΝ → -Α rewrite.
    expect(addr.city).toMatch(/ΑΘΗΝ/);
    expect(addr.state).toMatch(/ΑΘΗΝ/);
  });
});

// P2.5 / M8: Greek legal-form suffixes detected on tenant names.
describe('parseGreekLease - P2.5 company tenant detection', () => {
  test('flags Α.Ε. tenant as a company', () => {
    const text =
      'ΑΡ. ΔΗΛΩΣΗΣ   125   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/01/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   Α (ΑΦΜ Δηλούντος:023691386) Ποσοστό   100 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   ACME ΕΛΛΑΣ Α.Ε. (Α.Φ.Μ:444555667) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Επαγγελματική ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/01/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/01/2025 - 31/12/2025 ΣΗΜΕΙΩΣΕΙΣ   --- ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Γραφείο   ΑΡΙΘΜΟΣ ΑΤΑΚ   00112233447 ΔΙΕΥΘΥΝΣΗ   ΕΡΜΟΥ 15 10563 ΑΘΗΝΑΣ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   50,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   123';
    const result = parseGreekLease(text);
    expect(result.tenants[0].isCompany).toBe(true);
    expect(result.tenants[0].legalForm).toMatch(/Α\.?Ε\.?/);
    expect(result.tenants[0].companyName).toBe('ACME ΕΛΛΑΣ Α.Ε.');
  });

  test('does not flag a natural person', () => {
    const text =
      'ΑΡ. ΔΗΛΩΣΗΣ   126   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   01/01/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   Α (ΑΦΜ Δηλούντος:023691386) Ποσοστό   100 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   ΠΑΠΑΔΟΠΟΥΛΟΥ ΜΑΡΙΑ (Α.Φ.Μ:444555667) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/01/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Αστική (Κατοικίας) ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/01/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/01/2025 - 31/12/2025 ΣΗΜΕΙΩΣΕΙΣ   --- ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Κατοικία   ΑΡΙΘΜΟΣ ΑΤΑΚ   00112233448 ΔΙΕΥΘΥΝΣΗ   ΕΡΜΟΥ 15 10563 ΑΘΗΝΑΣ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   50,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   100,00 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   123';
    const result = parseGreekLease(text);
    expect(result.tenants[0].isCompany).toBeUndefined();
    expect(result.tenants[0].legalForm).toBeUndefined();
  });
});
