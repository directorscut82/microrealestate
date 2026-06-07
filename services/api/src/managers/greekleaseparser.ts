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
  // P2.5 / M8: AADE PDFs do not flag whether the tenant is a natural
  // person or a legal entity — the only signal is a Greek legal-form
  // suffix on the name (Α.Ε., Ε.Π.Ε., Ι.Κ.Ε., Ο.Ε., Ε.Ε., ΑΕΒΕ,
  // Α.Β.Ε.Ε.). Surface that to the import dialog so it doesn't try to
  // first/last-name-decompose a company.
  isCompany?: boolean;
  companyName?: string;
  legalForm?: string;
};

// Detects Greek legal-form suffixes on a tenant name. Anchored to end-of-
// string with optional internal dots so both "Α.Ε." and "ΑΕ" hit. Returns
// the matched legal form for downstream display, or null when natural.
export function detectGreekLegalForm(name: string): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  // Order matters: longest forms first so "ΑΕΒΕ"/"Α.Β.Ε.Ε." don't get
  // shadowed by the shorter "Ε.Ε." / "Α.Ε." patterns.
  const re =
    /(ΑΕΒΕ|Α\.?Β\.?Ε\.?Ε\.?|Ε\.?Π\.?Ε\.?|Ι\.?Κ\.?Ε\.?|Ο\.?Ε\.?|Ε\.?Ε\.?|Α\.?Ε\.?)$/i;
  const m = trimmed.match(re);
  return m ? m[1] : null;
}

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
  } else if (/^\d{1,3}\.\d{3}$/.test(cleaned)) {
    // P2.6 / L1: dot-only number with no decimal comma. AADE emits both
    // "1.234,56" and the bare "1.234" (one thousand two hundred thirty-four)
    // for whole-thousand amounts. Without a decimal cue parseFloat would
    // mis-read "1.234" as 1.234 (one and a quarter) and silently truncate
    // every kilo-rent or large surface. Detect the unambiguous
    // "1-3 digits . exactly 3 digits" thousands shape and strip the dot.
    cleaned = cleaned.replace('.', '');
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
  // P2.4 / M7: 'Αποθήκη' is a basement / storage room — map it to the
  // canonical 'storage' property type (see services/api/src/validators.ts
  // PROPERTY_TYPES). Was previously aliased to 'store' which conflated it
  // with retail spaces and broke per-type surface-lower-bound logic.
  Αποθήκη: 'storage',
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
// into structured address fields.
//
// P2.2 / M1: previously a naive split-on-comma, which misfires whenever the
// street1 itself contains a comma (e.g. "ΛΕΩΦ. ΑΛΕΞΑΝΔΡΑΣ 12, ΥΠ' ΑΡ. 3 ...
// 11522 ΑΘΗΝΩΝ, ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ)") because the early commas swallow the
// street into multiple "parts" and the city/state mapping shifts. Anchor the
// parse on the 5-digit zip token instead — the AADE PDF format always emits
// "<street1...> <ZIP> <city_genitive>, <state_genitive>" after the floor and
// the (ΝΟΜΑΡΧΙΑ) suffix are stripped, so the zip is a stable pivot.
function parseAddress(raw: string): ParsedAddress {
  const result: ParsedAddress = {
    street1: '',
    zipCode: '',
    city: '',
    state: ''
  };
  if (!raw) return result;

  // P2.7 / L2: extend floor regex to include the rest of the floor lexicon
  // AADE actually emits — Mezzanine (Ημιόροφος / ΗΜΙΟΡΟΦΟΣ), Sofita
  // (Σοφίτα / ΣΟΦΙΤΑ), Pataro (Πατάρι), and Ημιυπόγειο. Without these the
  // tokens were silently leaking into street1 (e.g. "ΣΠΑΡΤΙΑΤΩΝ 9 Σοφίτα").
  const FLOOR_RE =
    /(Όροφος\s+\d+|Ισόγειο|Υπόγειο|Ημιόροφος|Σοφίτα|Πατάρι|Ημιυπόγειο|ΗΜΙΟΡΟΦΟΣ|ΣΟΦΙΤΑ)/i;

  // Extract floor first so it doesn't pollute street1
  const floorMatch = raw.match(FLOOR_RE);
  if (floorMatch) result.floor = floorMatch[1];

  // Strip floor + (ΝΟΜΑΡΧΙΑ) + collapse whitespace. We keep the zip so the
  // anchor-pattern below can find it.
  const cleaned = raw
    .replace(FLOOR_RE, '')
    .replace(/\(ΝΟΜΑΡΧΙΑ\)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Anchor on the 5-digit zip token: "<street1> <ZIP> <city>, <state>"
  const anchored = cleaned.match(/^(.*?)\s+(\d{5})\s+(.+?),\s*(.+)$/);
  if (anchored) {
    result.street1 = anchored[1].trim();
    result.zipCode = anchored[2];
    // City and state are typically genitive (ΓΑΛΑΤΣΙΟΥ → ΓΑΛΑΤΣΙ,
    // ΑΘΗΝΩΝ → ΑΘΗΝΑ). Same suffix-rewrites as before.
    result.city = anchored[3]
      .trim()
      .replace(/ΟΥ$/, '')
      .replace(/ου$/, '')
      .replace(/ΑΣ$/, 'Α')
      .replace(/ας$/, 'α');
    result.state = anchored[4]
      .trim()
      .replace(/ΩΝ$/, 'Α')
      .replace(/ων$/, 'α');
  } else {
    // Fallback when the zip-anchored shape doesn't match (unusual AADE
    // output): keep the older zip + comma-split heuristic so we surface
    // *something* useful for the import dialog rather than an empty
    // address.
    const zipMatch = cleaned.match(/\b(\d{5})\b/);
    if (zipMatch) result.zipCode = zipMatch[1];
    const stripped = cleaned.replace(/\b\d{5}\b/, '').trim();
    const parts = stripped
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      result.state = parts[parts.length - 1]
        .replace(/ΩΝ$/, 'Α')
        .replace(/ων$/, 'α');
      const firstPart = parts[0];
      const streetCityMatch = firstPart.match(/^(.+?\s+\d+)\s+(.+)$/);
      if (streetCityMatch) {
        result.street1 = streetCityMatch[1].trim();
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
    const tenantName = m[1].trim();
    const legalForm = detectGreekLegalForm(tenantName);
    const tenant: ParsedTenant = {
      name: tenantName,
      taxId: m[2],
      acceptanceDate: m[3] || undefined
    };
    if (legalForm) {
      tenant.isCompany = true;
      tenant.companyName = tenantName;
      tenant.legalForm = legalForm;
    }
    tenants.push(tenant);
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
