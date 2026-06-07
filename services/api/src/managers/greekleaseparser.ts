// Parser for Greek government lease PDFs (AADE Taxisnet)
// Handles both original declarations and amendments (ΤΡΟΠΟΠΟΙΗΤΙΚΗ ΔΗΛΩΣΗ)

import { logger } from '@microrealestate/common';

/**
 * Validate a Greek ΑΦΜ (tax id) using the official mod-11 checksum.
 * Spec: 9 digits; first 8 digits weighted by 256, 128, 64, 32, 16, 8,
 * 4, 2; sum modulo 11; result modulo 10 must equal the 9th digit.
 *
 * Returns true for valid AFMs. False for malformed or wrong-length
 * inputs. Used to reject corrupt OCR output / typos at the import
 * boundary before they reach mongo.
 */
export function isValidAfm(afm: string | undefined | null): boolean {
  if (!afm) return false;
  if (!/^\d{9}$/.test(afm)) return false;
  // All-zeros fails the checksum but is also a sentinel value some
  // legacy fixtures use; accept it as a documented "missing" marker.
  if (afm === '000000000') return false;
  const digits = afm.split('').map((d) => Number(d));
  let sum = 0;
  // weights for digits[0..7] are 2^8, 2^7, ..., 2^1
  for (let i = 0; i < 8; i++) {
    sum += digits[i] * Math.pow(2, 8 - i);
  }
  const checksum = (sum % 11) % 10;
  return checksum === digits[8];
}

export type ParsedLandlord = {
  name: string;
  taxId: string;
  ownershipPercent: number;
};

export type ParsedTenant = {
  name: string;
  taxId: string;
  acceptanceDate?: string;
};

export type ParsedEnergyCertificate = {
  number: string;
  issueDate: string;
  energyClass: string;
  inspectorNumber: string;
};

export type ParsedAddress = {
  street1: string;
  zipCode: string;
  city: string;
  state: string;
  floor?: string;
};

export type ParsedProperty = {
  category: string;
  type: string;
  atakNumber: string;
  rawAddress: string;
  address: ParsedAddress;
  surface: number;
  landSurface?: number;
  monthlyRent: number;
  dehNumber: string;
  energyCertificate?: ParsedEnergyCertificate;
};

export type ParsedLease = {
  declarationNumber: string;
  submissionDate: string;
  isAmendment: boolean;
  amendsDeclaration?: string;
  landlords: ParsedLandlord[];
  tenants: ParsedTenant[];
  originalStartDate: string;
  leaseType: string;
  totalMonthlyRent: number;
  validityStart: string;
  validityEnd: string;
  notes: string;
  properties: ParsedProperty[];
};

function parseGreekDecimal(value: string): number {
  // Greek number format: dot is the thousands separator, comma is the
  // decimal separator (e.g. "1.234,56" → 1234.56). Mirrors the DEH bill
  // parser: strip dots first, then convert the comma.
  let cleaned = value.replace(/[€\s]/g, '');
  if (cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function extractDate(text: string): string {
  const m = text.match(/(\d{2}\/\d{2}\/\d{4})/);
  return m ? m[1] : '';
}

function extractMoney(text: string): number {
  const m = text.match(/([\d.,]+)\s*€/);
  return m ? parseGreekDecimal(m[1]) : 0;
}

function extractSurface(text: string): number {
  const m = text.match(/([\d.,]+)\s*τμ/);
  if (!m) return 0;
  return parseGreekDecimal(m[1]);
}

// Extract value between two labels. endLabel supports | for alternation.
function between(text: string, startLabel: string, endLabel: string): string {
  const escStart = startLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Split endLabel on | and escape each part separately
  const endParts = endLabel
    .split('|')
    .map((p) => p.replace(/[.*+?^${}()[\]\\]/g, '\\$&'));
  const escEnd = endParts.join('|');
  const re = new RegExp(escStart + '\\s*(.+?)\\s*(?:' + escEnd + ')', 's');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// Map Greek PDF property categories to MRE property types
const CATEGORY_MAP: Record<string, string> = {
  'Κατοικία/Διαμέρισμα': 'apartment',
  Κατοικία: 'apartment',
  Διαμέρισμα: 'apartment',
  Κατάστημα: 'store',
  Γραφείο: 'office',
  Αποθήκη: 'store',
  'Βιομηχανικός χώρος': 'building',
  Γκαράζ: 'garage',
  Parking: 'parking',
  Οικόπεδο: 'building',
  Αγροτεμάχιο: 'building'
};

function mapCategoryToType(category: string): string {
  for (const [key, value] of Object.entries(CATEGORY_MAP)) {
    if (category.includes(key)) return value;
  }
  logger.warn(
    `greekleaseparser: unknown property category "${category}", falling back to 'apartment'`
  );
  return 'apartment';
}

// Parse "Όροφος 3 ΣΠΑΡΤΙΑΤΩΝ 9 11147 ΓΑΛΑΤΣΙΟΥ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ)"
// into structured address fields
function parseAddress(raw: string): ParsedAddress {
  const result: ParsedAddress = {
    street1: '',
    zipCode: '',
    city: '',
    state: ''
  };
  if (!raw) return result;

  // Extract floor: "Όροφος N" or "Ισόγειο" or "Υπόγειο"
  const floorMatch = raw.match(/(Όροφος\s+\d+|Ισόγειο|Υπόγειο)/i);
  if (floorMatch) result.floor = floorMatch[1];

  // Extract zip code: 5-digit number
  const zipMatch = raw.match(/\b(\d{5})\b/);
  if (zipMatch) result.zipCode = zipMatch[1];

  // Remove floor and zip from the string to isolate street and location
  const cleaned = raw
    .replace(/(Όροφος\s+\d+|Ισόγειο|Υπόγειο)/i, '')
    .replace(/\b\d{5}\b/, '')
    .replace(/\(ΝΟΜΑΡΧΙΑ\)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Split on comma — typically "STREET CITY, REGION"
  const parts = cleaned
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    // Last part is region (ΑΘΗΝΩΝ → ΑΘΗΝΑ)
    result.state = parts[parts.length - 1]
      .replace(/ΩΝ$/, 'Α')
      .replace(/ων$/, 'α');

    // First part has street + city
    const firstPart = parts[0];
    // City is typically the last word(s) in genitive (ΓΑΛΑΤΣΙΟΥ)
    // Pattern: "STREET_NAME NUMBER CITY_GENITIVE"
    const streetCityMatch = firstPart.match(/^(.+?\s+\d+)\s+(.+)$/);
    if (streetCityMatch) {
      result.street1 = streetCityMatch[1].trim();
      // Convert genitive to nominative: ΓΑΛΑΤΣΙΟΥ → ΓΑΛΑΤΣΙ
      result.city = streetCityMatch[2]
        .replace(/ΟΥ$/, '')
        .replace(/ου$/, '')
        .replace(/ΑΣ$/, 'Α')
        .replace(/ας$/, 'α');
    } else {
      result.street1 = firstPart;
    }
  } else if (parts.length === 1) {
    result.street1 = parts[0];
  }

  // Append floor to street if present
  if (result.floor && result.street1) {
    result.street1 = `${result.street1}, ${result.floor}`;
  }

  return result;
}

export function parseGreekLease(text: string): ParsedLease {
  // Normalize: collapse page breaks and extra whitespace
  const t = text
    .replace(/---\s*PAGE BREAK\s*---/g, ' ')
    .replace(/Σελίδα \d+ \.\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const isAmendment = t.includes('ΤΡΟΠΟΠΟΙΗΤΙΚ');

  // Simple fields using between()
  const declarationNumber = between(t, 'ΑΡ. ΔΗΛΩΣΗΣ', 'ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ');
  const submissionDateStr = isAmendment
    ? between(t, 'ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ', 'ΤΡΟΠΟΠΟΙΗΣΕ')
    : between(t, 'ΗΜ/ΝΙΑ ΥΠΟΒΟΛΗΣ', 'ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤ');
  const submissionDate = extractDate(submissionDateStr);
  const amendsDeclaration = isAmendment
    ? between(t, 'ΤΡΟΠΟΠΟΙΗΣΕ ΤΗ ΔΗΛΩΣΗ', 'ΣΤΟΙΧΕΙΑ ΕΚΜΙΣΘΩΤ')
    : undefined;

  // Landlords. AFM is anchored to exactly 9 digits — the AADE form
  // never emits anything else, and a wider \d+ would silently swallow
  // an OCR-mangled run-on of digits from an adjacent field.
  const landlords: ParsedLandlord[] = [];
  const landlordRe =
    /(?:Κύριος|Κυρία)\s+(.+?)\s*\(ΑΦΜ Δηλούντος:(\d{9})\)\s*Ποσοστό\s+(\d+)/g;
  let m;
  while ((m = landlordRe.exec(t)) !== null) {
    if (!isValidAfm(m[2])) {
      logger.warn(
        `Greek lease parser: dropping landlord with invalid AFM "${m[2]}"`
      );
      continue;
    }
    landlords.push({
      name: m[1].trim(),
      taxId: m[2],
      ownershipPercent: parseInt(m[3], 10)
    });
  }

  // Tenants — same 9-digit anchor + checksum validation.
  const tenants: ParsedTenant[] = [];
  const tenantRe =
    /ΟΝΟΜΑΤΕΠΩΝΥΜΟ\/ΕΠΩΝΥΜΙΑ\s+(.+?)\s*\(Α\.Φ\.Μ:(\d{9})\)\s*(?:Ημ\/νία Αποδοχής\s+(\d{2}\/\d{2}\/\d{4}))?/g;
  while ((m = tenantRe.exec(t)) !== null) {
    if (!isValidAfm(m[2])) {
      logger.warn(
        `Greek lease parser: dropping tenant with invalid AFM "${m[2]}"`
      );
      continue;
    }
    tenants.push({
      name: m[1].trim(),
      taxId: m[2],
      acceptanceDate: m[3] || undefined
    });
  }

  // Lease details
  const originalStartDate = extractDate(
    between(t, 'ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΜΙΣΘΩΣΗΣ', 'ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ')
  );

  const leaseType = between(t, 'ΕΙΔΟΣ ΜΙΣΘΩΣΗΣ', 'ΗΜ/ΝΙΑ ΥΠΟΓΡΑΦΗΣ');

  const totalMonthlyRent = extractMoney(
    between(t, 'ΣΥΝΟΛΙΚΟ ΜHΝΙΑΙΟ ΜΙΣΘΩΜΑ', 'ΤΟ ΜΙΣΘΩΜΑ ΠΡΟΣΔΙΟΡΙΖΕΤΑΙ')
  );

  // Validity period
  let validityStart = '';
  let validityEnd = '';
  const validityM = t.match(
    /ΠΕΡΙΟΔΟΣ ΙΣΧΥΟΣ\s+(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/
  );
  if (validityM) {
    validityStart = validityM[1];
    validityEnd = validityM[2];
  }

  // Notes
  let notes = between(t, 'ΣΗΜΕΙΩΣΕΙΣ', 'ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ');
  if (notes === '---') notes = '';

  // Properties
  const properties: ParsedProperty[] = [];
  const propSections = t.split(/ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΟΥ:\s*A\/A\s*\d+/);

  for (let i = 1; i < propSections.length; i++) {
    const s = propSections[i];

    const category = between(s, 'Κατηγορία Ακινήτου', 'ΑΡΙΘΜΟΣ ΑΤΑΚ');
    const atakNumber = between(s, 'ΑΡΙΘΜΟΣ ΑΤΑΚ', 'ΔΙΕΥΘΥΝΣΗ');
    const address = between(s, 'ΔΙΕΥΘΥΝΣΗ', 'ΕΠΙΦΑΝΕΙΑ');

    const mainSurfaceStr = between(
      s,
      'ΕΠΙΦΑΝΕΙΑ ΚΥΡΙΩΝ & ΒΟΗΘ. ΧΩΡΩΝ',
      'ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ'
    );
    const surface = extractSurface(mainSurfaceStr);

    const landSurfaceStr = between(
      s,
      'ΕΠΙΦΑΝΕΙΑ ΑΓΡΟΤ/ΧΙΟΥ/ΟΙΚΟΠΕΔΟΥ/ΓΗΠΕΔΟΥ',
      'ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ'
    );
    let landSurface: number | undefined;
    if (landSurfaceStr && landSurfaceStr !== '--') {
      landSurface = extractSurface(landSurfaceStr);
      if (landSurface === 0) landSurface = undefined;
    }

    const monthlyRent = extractMoney(
      between(s, 'ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ', 'ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ')
    );

    // P1.4 / H1: AADE PDFs may emit either of two patterns after the DEH
    // number — "ΣΤΟΙΧΕΙΑ ΕΝΕΡΓΕΙΑΚΟΥ ΠΙΣΤΟΠΟΙΗΤΙΚΟΥ ..." (when a cert
    // exists) or "ΕΝΕΡΓΕΙΑΚΟ ΠΙΣΤΟΠΟΙΗΤΙΚΟ ΔΕΝ ΟΡΙΣΤΗΚΕ" (when none does).
    // The earlier `between(...)` end-label only matched the first form so
    // ~6/11 PDFs in the user's corpus silently lost the DEH number.
    // Self-contained regex anchored on the digits — robust to both shapes
    // and any future trailing-label change AADE makes.
    const dehMatchRaw = s.match(/ΑΡΙΘΜΟΣ ΠΑΡΟΧΗΣ ΔΕΗ\s*(\d+)/);
    const dehNumber = dehMatchRaw ? dehMatchRaw[1] : '';

    // Energy certificate — may be in a separate section
    let energyCertificate: ParsedEnergyCertificate | undefined;
    // Look in the full text for the cert matching this property's A/A
    const certRe = new RegExp(
      `ΣΤΟΙΧΕΙΑ ΕΝΕΡΓΕΙΑΚΟΥ ΠΙΣΤΟΠΟΙΗΤΙΚΟΥ ΓΙΑ ΤΟ ΑΚΙΝΗΤΟ ΜΕ\\s*:\\s*A/A\\s*${i}(.+?)(?=ΣΤΟΙΧΕΙΑ ΕΝΕΡΓΕΙΑΚΟΥ|ΔΙΕΥΘΥΝΣΗ ΑΚΙΝΗΤΟΥ|$)`,
      's'
    );
    const certM = t.match(certRe);
    if (certM) {
      const cs = certM[1];
      const inspStr = cs.match(/Α\.Μ\. ΕΠΙΘΕΩΡΗΤΗ\s+(\d+)/);
      energyCertificate = {
        number: between(cs, 'Α.Μ. ΠΙΣΤΟΠΟΙΗΤΙΚΟΥ', 'ΗΜΕΡΟΜΗΝΙΑ ΕΚΔΟΣΗΣ'),
        issueDate: extractDate(
          between(cs, 'ΗΜΕΡΟΜΗΝΙΑ ΕΚΔΟΣΗΣ', 'ΕΝΕΡΓΕΙΑΚΗ ΚΑΤΑΤΑΞΗ')
        ),
        energyClass: between(cs, 'ΕΝΕΡΓΕΙΑΚΗ ΚΑΤΑΤΑΞΗ', 'Α.Μ. ΕΠΙΘΕΩΡΗΤΗ'),
        inspectorNumber: inspStr ? inspStr[1] : ''
      };
    }

    // Clean dehNumber — extract just the digits
    const dehMatch = dehNumber.match(/(\d+)/);

    properties.push({
      category,
      type: mapCategoryToType(category),
      atakNumber,
      rawAddress: address,
      address: parseAddress(address),
      surface,
      landSurface,
      monthlyRent,
      dehNumber: dehMatch ? dehMatch[1] : '',
      energyCertificate
    });
  }

  return {
    declarationNumber,
    submissionDate,
    isAmendment,
    amendsDeclaration,
    landlords,
    tenants,
    originalStartDate,
    leaseType,
    totalMonthlyRent,
    validityStart,
    validityEnd,
    notes,
    properties
  };
}
