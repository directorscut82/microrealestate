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
    const text = 'ΑΡ. ΔΗΛΩΣΗΣ   999999   ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ   15/06/2025 ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤH: A/A 1 Κύριος   ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ (ΑΦΜ Δηλούντος:111222333) Ποσοστό   50 ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΤH: A/A 1 ΟΝΟΜΑΤΕΠΩΝΥΜΟ/ΕΠΩΝΥΜΙΑ   ΝΙΚΟΛΑΟΥ ΜΑΡΙΑ (Α.Φ.Μ:444555666) ΣΤΟΙΧΕΙΑ ΜΙΣΘΩΣΗΣ ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ   01/06/2025 ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ   Επαγγελματική ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ   01/06/2025 ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ   800,00 €   ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ ΣΕ ΕΙΔΟΣ ΟΧΙ ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ   01/06/2025 - 31/05/2027 ΣΗΜΕΙΩΣΕΙΣ   Χωρίς κατοικίδια ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ: A/A 1 Κατηγορία Ακινήτου   Κατάστημα   ΑΡΙΘΜΟΣ ΑΤΑΚ   12345678901 ΔΙΕΥΘΥΝΣΗ   ΕΡΜΟΥ 15 10563 ΑΘΗΝΑΣ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ   85,00 τμ / --   ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ -- ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ   800,00 €   ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ   999888777';
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
