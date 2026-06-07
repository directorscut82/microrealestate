// Parser for Greek E9 property declaration PDFs (AADE Taxisnet)
// Βεβαίωση Δηλωθείσας Περιουσιακής Κατάστασης

export type ParsedE9Owner = {
  taxId: string;
  lastName: string;
  firstName: string;
  fatherName: string;
  // L3: legal-entity owners (Α.Ε./Ε.Π.Ε./Ι.Κ.Ε./Ο.Ε./Ε.Ε./ΑΕΒΕ etc.) do
  // NOT carry first/last/father triplets — they have a single company
  // name on the ΕΠΩΝΥΜΟ line. When we detect the legal-form marker we
  // emit the full company name in `name` and leave the physical-person
  // fields empty rather than mangling the name across three columns.
  isCompany?: boolean;
  legalForm?: string;
  name?: string;
};

export type ParsedE9CoOwner = {
  // T2.P1.4: optional co-owner triplet from the E9 row tail. The PDF
  // can declare up to 3 owners per ATAK; the FIRST owner's percentage
  // is the primary ownershipPercentage on the unit (for backwards
  // compatibility with existing callers), while any additional owners
  // appear here.
  percentage: number;
  taxId: string;
  rightType: 'full' | 'bare' | 'usufruct';
};

export type ParsedE9Unit = {
  atakNumber: string;
  // L9: optional cadastral code (Κ.Α.Ε.Κ.) — E9 occasionally carries the
  // National Cadastre's KAEK alongside the AADE ATAK. Persisted on the
  // Property record so downstream consumers (display, lookups) can
  // surface both identifiers without re-parsing the PDF. Missing on
  // most rows (the standard E9 row does not include it).
  kaek?: string;
  state: string;
  municipality: string;
  // T3.P1.27: `district` previously sat here but was never populated
  // (always set to ''). No consumer reads it. Removed to keep the type
  // honest about what the parser actually emits.
  street: string;
  streetNumber: string;
  zipCode: string;
  blockNumber: string;
  blockStreets: string[];
  floor: number | null;
  surface: number;
  auxSurface: number;
  landSurface: number;
  category: number | null;
  yearBuilt: number | null;
  ownershipPercentage: number;
  // T2.P1.14: ΕΙΔΟΣ ΔΙΚΑΙΩΜΑΤΟΣ — full ownership (Πλήρης, code 1), bare
  // ownership (Ψιλή κυριότητα, code 2), or usufruct (Επικαρπία, code 3).
  // Defaults to 'full' when the row digit is missing or unrecognized
  // — every prior parse implicitly assumed full ownership.
  rightType: 'full' | 'bare' | 'usufruct';
  // T2.P1.4: any co-owner triplets detected after the primary owner.
  // Empty array when the unit has a single owner (the common case).
  coOwners: ParsedE9CoOwner[];
  electricitySupplyNumber: string;
  isElectrified: boolean;
};

export type ParsedE9Building = {
  atakPrefix: string;
  address: {
    street1: string;
    zipCode: string;
    city: string;
    state: string;
    country: string;
  };
  blockNumber: string;
  blockStreets: string[];
  yearBuilt: number | null;
  units: ParsedE9Unit[];
};

export type ParsedE9Result = {
  owner: ParsedE9Owner;
  buildings: ParsedE9Building[];
  skippedLandPlots: number;
  failedRows: number;
};

// Returns null on parse failure (instead of 0) to distinguish from actual zero
function parseGreekDecimal(value: string): number | null {
  const cleaned = value
    .replace(/[€\s]/g, '')
    .replace('.', '')
    .replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function cleanState(state: string): string {
  // T3.P1.26: drop the heuristic Greek-case stripping. The previous
  // `ΩΝ$ → Α` / `ων$ → α` substitutions assumed a singular feminine
  // genitive (ΑΘΗΝΩΝ → ΑΘΗΝΑ) but mis-cased plural prefectures
  // (ΚΥΚΛΑΔΩΝ → ΚΥΚΛΑΔΑ, should stay ΚΥΚΛΑΔΩΝ; ΔΩΔΕΚΑΝΗΣΩΝ → ΔΩΔΕΚΑΝΗΣΑ,
  // should stay ΔΩΔΕΚΑΝΗΣΩΝ). Preserving the raw genitive is safer than
  // a wrong nominalisation — display layers can apply a lookup table
  // when they need a specific case.
  return state.replace(/\(ΝΟΜΑΡΧΙΑ\)/gi, '').trim();
}

function cleanCity(city: string): string {
  return city
    .replace(/\s+[Α-Ω]\s*$/, '') // trailing single Greek letter
    .replace(/\s+\d+\s*$/, '') // trailing digits
    .replace(/ΟΥ$/, '')
    .replace(/ου$/, '')
    .replace(/ΑΣ$/, 'Α')
    .replace(/ας$/, 'α')
    .trim();
}

// Determine if a parsed unit is a real building unit (not land)
function isRealBuildingUnit(unit: {
  floor: number | null;
  surface: number;
  isElectrified: boolean;
  electricitySupplyNumber: string;
  category: number | null;
}): boolean {
  if (unit.surface <= 0) return false;
  // Primary: has a floor number (apartments always have one)
  if (unit.floor !== null) return true;
  // Secondary: has electricity (building unit where floor parsing failed)
  if (unit.isElectrified || !!unit.electricitySupplyNumber) return true;
  return false;
}

// Parse a single E9 row (text between two ATAK entries)
// E9 row structure (from actual PDFs):
// PREFIX SUFFIX STATE(ΝΟΜΑΡΧΙΑ) MUNICIPALITY STREET NUM [X BLOCK_STREETS]
//   BLOCK_NUM ? FLOOR SURFACE [AUX_SURFACE] ? YEAR OWN_INT, OWN_FRAC ?
//   ELEC(ΝΑΙ/ΟΧΙ) ? ZIP CITY [DEH_NUMBER]
function parseE9Row(
  rowText: string,
  atakPrefix: string,
  atakSuffix: string
): ParsedE9Unit | null {
  // Remove the ATAK prefix/suffix from start.
  // L15: don't hardcode substring(12). The ATAK regex matches
  // "<6 digits> <whitespace> <5 digits>"; the whitespace can collapse
  // (already done by parseE9's normalisation pass) but a future caller
  // could feed a row preserving multiple spaces. Compute the actual
  // span via a regex anchored at the row start so we never decapitate
  // the first non-ATAK character of the row.
  const atakHead = rowText.match(
    new RegExp(`^${atakPrefix}\\s+${atakSuffix}\\b`)
  );
  const afterAtak = (
    atakHead ? rowText.substring(atakHead[0].length) : rowText.substring(12)
  ).trim();

  // Extract state — pattern: "ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ)" or "ΑΝΑΤ. ΑΤΤΙΚΗΣ (ΝΟΜΑΡΧΙΑ)"
  // Also handle non-ΝΟΜΑΡΧΙΑ states like "ΚΥΚΛΑΔΩΝ"
  const stateMatch = afterAtak.match(
    /^([\u0391-\u03A9\u0386-\u038F.\s]+?)\s*\((?:ΝΟΜΑΡΧ[ΙΑ]*|ΝΟΜΑΡΧΙΑ)\)\s*/
  );
  const stateMatchAlt = !stateMatch
    ? afterAtak.match(/^([\u0391-\u03A9\u0386-\u038F]{3,})\s+/)
    : null;
  let state = '';
  let rest = afterAtak;
  if (stateMatch) {
    state = stateMatch[1].trim();
    rest = afterAtak.substring(stateMatch[0].length);
  } else if (stateMatchAlt) {
    state = stateMatchAlt[1].trim();
    rest = afterAtak.substring(stateMatchAlt[0].length);
  }

  // Extract municipality — first Greek word(s) before the street name
  // Municipality is in genitive (ΓΑΛΑΤΣΙΟΥ, ΑΘΗΝΑΙΩΝ, ΝΕΑΣ ΧΑΛΚΗΔΟΝΟΣ)
  // Street follows and has a number
  // Pattern: MUNICIPALITY STREET NUMBER [X BLOCK_STREETS ...]
  // After that: numeric data (block, floor, surface, year, ownership, zip, DEH)

  // Strategy: find street+number from the END of the address section.
  // Known compound street prefixes: ΑΓ./ΑΓΙΩΝ/ΑΓΙΟΥ/ΕΘΝ./ΒΑΣΙΛ./ΛΕΩΦ.
  // These indicate the street name is 2+ words.
  // Pattern: [MUNICIPALITY...] [STREET_PREFIX? STREET_NAME] NUMBER

  // Rural format FIRST (must be checked before simple street to avoid false matches)
  // "MUNICIPALITY - AREA SETTLEMENT_TYPE SETTLEMENT_NAME X ..."
  const ruralMatch = rest.match(
    /^([\u0391-\u03A9\u0386-\u038F.\s-]+?)\s+(ΟΙΚΙΣΜΟΣ|ΕΠΙ ΑΓΡΟΤΕΜΑΧΙΟΥ|ΘΕΣΗ|ΠΕΡΙΟΧΗ)\s+([\u0391-\u03A9\u0386-\u038F.\s]+?)\s+X\b/
  );

  const compoundStreetMatch = rest.match(
    /^([\u0391-\u03A9\u0386-\u038F.\s-]+?)\s+((?:ΑΓ\.?\s+|ΑΓΙΩΝ\s+|ΑΓΙΟΥ\s+|ΕΘΝ\.?\s+|ΒΑΣΙΛ\.?\s+|ΛΕΩΦ\.?\s+|ΗΡΩΩΝ\s+|ΣΤΡΑΤ\.?\s+)[\u0391-\u03A9\u0386-\u038F]+)\s+(\d+)\s/
  );
  // Simple street (single word before number)
  const simpleStreetMatch =
    !compoundStreetMatch && !ruralMatch
      ? rest.match(
          /^([\u0391-\u03A9\u0386-\u038F.\s-]+)\s+([\u0391-\u03A9\u0386-\u038F]{3,})\s+(\d+)\s/
        )
      : null;

  // T2.P1.3: 4th fallback for settlement-style rows with a NON-NUMERIC
  // block-plot identifier (e.g. "\u039B\u0391\u0393\u039F\u039D\u0397\u03A3\u0399 ... X ... X 831\u0391"). The PDF
  // emits a settlement chain followed by `X`, then block streets,
  // another `X`, then an alphanumeric block-plot id (e.g. "831\u0391") in
  // place of a street number. The three earlier patterns require pure
  // numeric \d+ for the street number and silently drop these rows;
  // surface>0 then gets dropped as a land plot at buildingMap. Match
  // conservatively on the double-X with an alphanumeric tail token so
  // we don't false-positive on standard urban rows.
  const settlementBlockPlotMatch =
    !compoundStreetMatch && !simpleStreetMatch && !ruralMatch
      ? rest.match(
          /^([\u0391-\u03A9\u0386-\u038F.\s-]+?)\s+X\s+[\u0391-\u03A9\u0386-\u038F.\s()]+?\s+X\s+(\d+[\u0391-\u03A9]?)\s/
        )
      : null;

  const municipalityAndStreet = !ruralMatch
    ? compoundStreetMatch || simpleStreetMatch
    : null;

  let municipality = '';
  let street = '';
  let streetNumber = '';

  if (municipalityAndStreet) {
    municipality = municipalityAndStreet[1].trim();
    street = municipalityAndStreet[2].trim();
    streetNumber = municipalityAndStreet[3];
    rest = rest.substring(municipalityAndStreet[0].length - 1);
  } else if (ruralMatch) {
    // For rural areas, use settlement name as city (better for Google Maps)
    // Municipality chain like "ΕΞΩΜΒΟΥΡΓΟΥ - ΚΑΛΛΟΝΗΣ" is too specific
    municipality = ruralMatch[3].trim(); // settlement name as city
    street = ruralMatch[3].trim(); // settlement name
    streetNumber = '0'; // no number for rural
    rest = rest.substring(ruralMatch[0].length);
  } else if (settlementBlockPlotMatch) {
    // T2.P1.3: settlement with alphanumeric block-plot identifier. Pull
    // the most-specific 1-2 trailing tokens of the settlement chain as
    // the street label so the building gets a usable name. e.g.
    // "ΚΑΛΥΒΙΩΝ ΘΟΡΙΚΟΥ - ΠΑΡΑΛΙΑ ΛΑΓΟΝΗΣΙ ΑΓ. ΑΝΑΣΤΑΣΙΑΣ" → street
    // "ΑΓ. ΑΝΑΣΤΑΣΙΑΣ", municipality "ΚΑΛΥΒΙΩΝ ΘΟΡΙΚΟΥ - ΠΑΡΑΛΙΑ
    // ΛΑΓΟΝΗΣΙ".
    const chain = settlementBlockPlotMatch[1].trim();
    const blockPlotId = settlementBlockPlotMatch[2];
    const tokens = chain.split(/\s+/);
    if (tokens.length >= 2) {
      const prevToken = tokens[tokens.length - 2];
      // Keep ΑΓ./ΑΓΙΟΥ/ΑΓΙΩΝ/ΕΘΝ./ΛΕΩΦ./ΒΑΣΙΛ. attached to the next
      // token so abbreviated saint/national/avenue names stay grouped.
      if (
        /^(ΑΓ\.?|ΑΓΙΟΥ|ΑΓΙΩΝ|ΕΘΝ\.?|ΛΕΩΦ\.?|ΒΑΣΙΛ\.?)$/.test(prevToken)
      ) {
        street = `${prevToken} ${tokens[tokens.length - 1]}`;
        municipality = tokens.slice(0, -2).join(' ').trim();
      } else {
        street = tokens[tokens.length - 1];
        municipality = tokens.slice(0, -1).join(' ').trim();
      }
    } else {
      street = chain;
      municipality = chain;
    }
    streetNumber = blockPlotId;
    rest = rest.substring(settlementBlockPlotMatch[0].length);
  }

  // Look for X marker (indicates inhabited building with block streets)
  const hasX = /\bX\b/.test(rest);

  // Extract block streets (Greek words between X and block number)
  const blockStreets: string[] = [];
  if (hasX) {
    const xPos = rest.indexOf(' X ');
    if (xPos >= 0) {
      const afterX = rest.substring(xPos + 3);
      // Block streets are Greek words until we hit a 2-4 digit number (block number)
      const streetsMatch = afterX.match(
        /^([\u0391-\u03A9\u0386-\u038F.\s()]+?)\s+(\d{1,4})\s/
      );
      if (streetsMatch) {
        const streetsStr = streetsMatch[1].trim();
        // Split on known separators (spaces between multi-word street names).
        // T3.P1.23: drop tokens that start with '(' — leading parens leak in
        // through the [Α-ΩΆ-Ώ.\s()] character class
        // (e.g. "(ΝΟΜΑΡΧΙΑ)" debris) and would otherwise appear as a
        // standalone block-street, polluting the building card.
        // T3.P1.24: preserve 'ΑΓ.' / 'ΑΓ' (saint) and 'ΑΓΙΟΥ' / 'ΑΓΙΩΝ'
        // when they precede a real word — instead of dropping the prefix
        // and stranding the saint's name as a single token, glue the
        // prefix to the next token so e.g. "ΑΓ. ΑΝΑΣΤΑΣΙΑΣ" stays
        // grouped as one street label.
        const tokens = streetsStr.split(/\s+/).filter(Boolean);
        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          if (tok.startsWith('(')) continue; // T3.P1.23
          if (/^(ΑΓ\.?|ΑΓΙΟΥ|ΑΓΙΩΝ)$/.test(tok)) {
            // T3.P1.24: glue prefix onto the next token if present.
            const next = tokens[i + 1];
            if (next && next.length > 2 && !next.startsWith('(')) {
              blockStreets.push(`${tok} ${next}`);
              i++;
            }
            continue;
          }
          if (tok.length > 2) blockStreets.push(tok);
        }
      }
    }
  }

  // Now extract the numeric tail: block floor surface year ownership zip DEH
  // Pattern of numeric data after the address/streets section:
  // BLOCK_NUM [1-4 digits] SEPARATOR[1] FLOOR SURFACE [AUX] SEPARATOR[1] YEAR
  // OWN_INT, OWN_FRAC SEPARATOR[0] ELEC SEPARATOR[1] ZIP CITY DEH
  //
  // The key insight: ownership is formatted as "100, 0000" or "50,0 0000"
  // and is always followed by a single digit 0, then ΝΑΙ/ΟΧΙ

  // Extract zip code (5 digits, not the ATAK suffix)
  const allFiveDigit = [...rowText.matchAll(/\b(\d{5})\b/g)];
  const zipCandidate = allFiveDigit.find(
    (zm) => zm[1] !== atakSuffix && !zm[1].startsWith('0000')
  );
  const zipCode = zipCandidate ? zipCandidate[1] : '';

  // Extract ownership: look for patterns "100, 0000" or "50,0 0000" or "100,0000"
  // T2.P1.4: collect ALL ownership triplets present in the row tail.
  // Each triplet is the percentage column (PCT, FRAC) followed by
  // YEAR_USUFRUCT (4 digits, often 0000) and optionally a 9-digit AFM
  // for the usufructuary. The PDF can carry up to 3 such triplets per
  // ATAK; we keep the first as the primary ownership and emit the rest
  // as `coOwners` so downstream importer can attach all of them.
  let ownershipPercentage = 100;
  const ownMatch = rowText.match(/\b(\d{1,3}),\s*0{4}\b/);
  const ownMatch2 = rowText.match(/\b(\d{1,3}),(\d)\s+0{4}\b/);
  if (ownMatch2) {
    ownershipPercentage = parseFloat(`${ownMatch2[1]}.${ownMatch2[2]}`);
  } else if (ownMatch) {
    ownershipPercentage = parseInt(ownMatch[1], 10);
  } else {
    // L1: fractional-rights fallback. E9 occasionally encodes ownership as
    // a Greek-style fraction "1/2" (or "1 / 2") instead of "50, 0000".
    // Without this branch the parser falls through to the default of 100
    // and silently misrepresents a half-owner as full owner. Constrain the
    // numerator/denominator to 1-3 digits and require denominator > 0 so
    // we don't false-positive on unrelated digit pairs (zip prefixes,
    // block numbers).
    const fracMatch = rowText.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);
    if (fracMatch) {
      const num = parseInt(fracMatch[1], 10);
      const den = parseInt(fracMatch[2], 10);
      if (den > 0 && num <= den) {
        const pct = (num / den) * 100;
        if (pct > 0 && pct <= 100) {
          // Round to two decimals to keep the bounds invariant tight.
          ownershipPercentage = Math.round(pct * 100) / 100;
        }
      }
    }
  }
  const coOwners: ParsedE9CoOwner[] = [];
  // Find every "PCT, FRAC" or "PCT,FRAC" triplet head. Skip the first
  // occurrence (already captured as ownershipPercentage) and look for
  // up to 2 more (E9 schema caps owners per ATAK at 3).
  const allOwnTriplets = [
    ...rowText.matchAll(/\b(\d{1,3}),\s*(\d{4})\s+(\d{9})?/g)
  ];
  if (allOwnTriplets.length > 1) {
    for (let i = 1; i < Math.min(allOwnTriplets.length, 3); i++) {
      const pct = parseInt(allOwnTriplets[i][1], 10);
      const taxId = allOwnTriplets[i][3] || '';
      // Skip noise matches where pct is 0 — those are absent triplets.
      if (pct > 0 && pct <= 100) {
        coOwners.push({
          percentage: pct,
          taxId,
          rightType: 'full'
        });
      }
    }
  }

  // Extract year built: 4-digit year 16xx-20xx (covers historical Greek
  // buildings such as 1896 — narrower 19xx|20xx regex previously rejected them).
  let yearBuilt: number | null = null;
  const yearMatch = rowText.match(/\b(1[6789]\d{2}|20\d{2})\b/);
  if (yearMatch) {
    yearBuilt = parseInt(yearMatch[1], 10);
  }

  // Electrified: ΝΑΙ or ΟΧΙ
  // \b doesn't work with Greek chars, use lookaround with unicode flag
  const isElectrified = /(?<![Α-ΩΆ-Ώ])ΝΑΙ(?![Α-ΩΆ-Ώ])/u.test(rowText);

  // DEH number: long number (6-12 digits) near end, after zip+city
  let electricitySupplyNumber = '';
  if (zipCode && rowText.lastIndexOf(zipCode) > rowText.length / 2) {
    const afterZip = rowText.substring(rowText.lastIndexOf(zipCode) + 5);
    const dehMatch = afterZip.match(/\b(\d{6,12})\b/);
    if (dehMatch) {
      electricitySupplyNumber = dehMatch[1];
    }
  } else {
    // No zip: look for a 9-12 digit number near the end of the row
    // (DEH numbers are typically 9 digits)
    const tailSection = rowText.substring(Math.max(0, rowText.length - 60));
    const dehMatch = tailSection.match(/\b(\d{9,12})\b/);
    if (dehMatch) {
      electricitySupplyNumber = dehMatch[1];
    }
  }

  // Extract surface and floor from the numeric section
  // Find all numbers that look like surface (contain comma + 2 decimals)
  const surfaceMatches = [...rowText.matchAll(/\b(\d{1,3}),(\d{2})\b/g)];
  // Filter out ownership (already matched) and year
  const surfaceCandidates = surfaceMatches.filter((sm) => {
    const full = sm[1] + ',' + sm[2];
    // Not the ownership match
    if (ownMatch && rowText.indexOf(full) === rowText.indexOf(ownMatch[0])) {
      return false;
    }
    return true;
  });

  let surface = 0;
  let auxSurface = 0;
  if (surfaceCandidates.length >= 1) {
    surface =
      parseGreekDecimal(
        surfaceCandidates[0][1] + ',' + surfaceCandidates[0][2]
      ) ?? 0;
  }
  if (surfaceCandidates.length >= 2) {
    // T1.P1.10: when the row has only one declared surface but the regex
    // matches the same value twice (e.g. PDF prints the total beside the
    // unit surface), the second match is a duplicate of the first — not a
    // separate auxiliary surface. Detect this by comparing the captured
    // groups verbatim and keep auxSurface at 0.
    const firstRaw =
      surfaceCandidates[0][1] + ',' + surfaceCandidates[0][2];
    const secondRaw =
      surfaceCandidates[1][1] + ',' + surfaceCandidates[1][2];
    if (firstRaw !== secondRaw) {
      auxSurface = parseGreekDecimal(secondRaw) ?? 0;
    }
  }

  // For large surfaces with dot separators (e.g. "2.478,00" or "1.032,00")
  if (surface === 0) {
    const largeSurfMatch = rowText.match(/\b(\d{1,2}\.\d{3}),(\d{2})\b/);
    if (largeSurfMatch) {
      surface =
        parseGreekDecimal(largeSurfMatch[1] + ',' + largeSurfMatch[2]) ?? 0;
    }
  }

  // Extract floor: after block streets section, look for the digit pattern
  // In the numeric tail, the sequence is: BLOCK_NUM RIGHT CATEGORY [TOTAL_FLOORS] FLOOR SURFACE
  // Floor can be 0-9 (single digit for most buildings)
  // Special: Υ = underground (basement), Ι = ισόγειο (not always present)
  // Category: 1=apartment, 2=store, 51=storage, etc.
  // T2.P1.14: ΕΙΔΟΣ ΔΙΚΑΙΩΜΑΤΟΣ — ownership-rights code from E9 column.
  //   1 = full ownership (Πλήρης κυριότητα)
  //   2 = bare ownership (Ψιλή κυριότητα)
  //   3 = usufruct       (Επικαρπία)
  // Defaults to 'full' since every previously-parsed E9 row was
  // implicitly treated as full ownership.
  let rightType: 'full' | 'bare' | 'usufruct' = 'full';
  let floor: number | null = null;
  let category: number | null = null;

  // Strategy: find the surface value position and look for floor just before it
  if (surface > 0 && surfaceCandidates.length >= 1) {
    const surfacePos = rowText.indexOf(
      surfaceCandidates[0][1] + ',' + surfaceCandidates[0][2]
    );
    // Look at the few characters before surface for floor digit
    const beforeSurface = rowText
      .substring(Math.max(0, surfacePos - 10), surfacePos)
      .trim();
    // Floor is the last single digit before the surface
    const floorDigits = beforeSurface.match(/(\d+)\s*$/);
    if (floorDigits) {
      floor = parseInt(floorDigits[1], 10);
      // Extract category: look for numbers before the floor digit
      const beforeFloor = beforeSurface
        .substring(0, beforeSurface.lastIndexOf(floorDigits[1]))
        .trim();
      // Category is the last number before floor (could be 1 or 2 digits like 51)
      const catMatch = beforeFloor.match(/(\d+)\s*$/);
      if (catMatch) {
        category = parseInt(catMatch[1], 10);
      }
    }
    // Check for Υ (underground)
    if (floor === null && /Υ\s*$/.test(beforeSurface)) {
      floor = -1;
      // For basement with Υ, category is the last number before Υ
      const beforeU = beforeSurface.replace(/Υ\s*$/, '').trim();
      const catMatch = beforeU.match(/(\d+)\s*$/);
      if (catMatch) {
        category = parseInt(catMatch[1], 10);
      }
    }
  }

  // Block number: first 2-4 digit number that appears after X section
  let blockNumber = '';
  if (hasX) {
    const xPos = rowText.indexOf(' X ');
    const afterXSection = rowText.substring(xPos + 3);
    const blockMatch = afterXSection.match(
      /[\u0391-\u03A9.\s]+?\s+(\d{1,4})\s+\d/
    );
    if (blockMatch) {
      blockNumber = blockMatch[1];
    }
  }

  // T2.P1.14: extract rightType. The digit appears between blockNumber
  // and the category/floor/surface triplet. Conservative match: look
  // for "<blockNumber> <rightDigit> <category>" where rightDigit is
  // 1/2/3 and category is at most 2 digits. If we cannot match
  // confidently, leave rightType at the default 'full'.
  if (blockNumber && surface > 0) {
    const rightAfterBlock = rowText.match(
      new RegExp(`\\b${blockNumber}\\s+([123])\\s+\\d{1,2}\\s`)
    );
    if (rightAfterBlock) {
      const code = rightAfterBlock[1];
      if (code === '1') rightType = 'full';
      else if (code === '2') rightType = 'bare';
      else if (code === '3') rightType = 'usufruct';
    }
  }

  // City name from row - look after zip code
  // T1.P1.12: always run cleanCity() so the genitive municipality
  // (\u0393\u0391\u039B\u0391\u03A4\u03A3\u0399\u039F\u03A5) is normalized to its nominative form (\u0393\u0391\u039B\u0391\u03A4\u03A3\u0399) regardless
  // of whether a zipCode-based city extraction succeeded. Without this,
  // rows missing a zip group separately from rows that have one even when
  // they refer to the same city.
  let city = cleanCity(municipality);
  if (zipCode) {
    const afterZipForCity = rowText.substring(rowText.lastIndexOf(zipCode) + 6);
    const cityMatch = afterZipForCity.match(
      /^([\u0391-\u03A9\u0386-\u038F.\s]+)/
    );
    if (cityMatch) {
      city = cleanCity(cityMatch[1].trim());
    }
  }

  // L9: cadastral code (Κ.Α.Ε.Κ.) — when present, E9 rows include a
  // 25-digit identifier prefixed by ΚΑΕΚ or Κ.Α.Ε.Κ. Conservatively
  // capture 12-25 digits (the historic formats vary) and only when the
  // marker is on the same row, so we don't grab a stray ATAK suffix.
  let kaek: string | undefined = undefined;
  const kaekMatch = rowText.match(/Κ(?:\.?Α\.?Ε\.?Κ\.?)\s*[:\s]\s*(\d{12,25})/);
  if (kaekMatch) {
    kaek = kaekMatch[1];
  }

  return {
    atakNumber: atakPrefix + atakSuffix,
    ...(kaek ? { kaek } : {}),
    state: cleanState(state),
    municipality: city || cleanCity(municipality),
    street,
    streetNumber,
    zipCode,
    blockNumber,
    blockStreets,
    floor,
    surface,
    auxSurface,
    landSurface: 0,
    category,
    yearBuilt,
    ownershipPercentage,
    rightType,
    coOwners,
    electricitySupplyNumber,
    isElectrified
  };
}

export function parseE9(text: string): ParsedE9Result {
  if (!text || !text.trim()) {
    return {
      owner: { taxId: '', lastName: '', firstName: '', fatherName: '' },
      buildings: [],
      skippedLandPlots: 0,
      failedRows: 0
    };
  }

  const t = text
    .replace(/---\s*PAGE BREAK\s*---/g, '\n')
    .replace(/Ημερομηνία εκτύπωσης:.+?(?=\d{6}\s+\d{5}|$)/g, ' ')
    .replace(/Σελίδα \d+\s+από\s+\d+/g, ' ')
    .replace(/ΑΦΜ υπόχρεου\s*:\s*\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Parse owner
  const owner: ParsedE9Owner = {
    taxId: '',
    lastName: '',
    firstName: '',
    fatherName: ''
  };

  const GK = '[Α-ΩΆ-Ώα-ωά-ώA-Z]+';
  const ownerA = t.match(
    new RegExp(
      `ΕΠΩΝΥΜΟ\\s+ή\\s+ΕΠΩΝΥΜΙΑ\\s+(${GK})\\s+(${GK})\\s+(${GK})\\s+(\\d{9})`
    )
  );
  const ownerB = t.match(
    new RegExp(
      `ΑΦΜ\\s+ΕΠΩΝΥΜΟ\\s+ή\\s+ΕΠΩΝΥΜΙΑ\\s+ΟΝΟΜΑ\\s+ΠΑΤΡΩΝΥΜΟ\\s+(\\d{9})\\s+(${GK})\\s+(${GK})\\s+(${GK})`
    )
  );
  if (ownerA) {
    owner.fatherName = ownerA[1];
    owner.firstName = ownerA[2];
    owner.lastName = ownerA[3];
    owner.taxId = ownerA[4];
  } else if (ownerB) {
    owner.taxId = ownerB[1];
    owner.lastName = ownerB[2];
    owner.firstName = ownerB[3];
    owner.fatherName = ownerB[4];
  }
  if (!owner.taxId) {
    const afmAlt = text.match(/ΑΦΜ\s+υπόχρεου\s*:\s*(\d+)/);
    if (afmAlt) owner.taxId = afmAlt[1];
  }

  // L3: legal-entity detector. The 3-token regexes above mangle company
  // names (e.g. "ΑΚΡΟΠΟΛΗ Α.Ε.") into firstName/lastName/fatherName by
  // splitting on whitespace. Detect company markers on the ΕΠΩΝΥΜΟ line
  // and, when matched, emit the full company name as `owner.name` while
  // clearing the physical-person triplet so downstream consumers don't
  // render "Α.Ε. ΑΚΡΟΠΟΛΗ ΟΛΥΜΠΟΣ" as a person's full name.
  // The ordering of forms below intentionally puts longer / more-specific
  // markers first (ΑΕΒΕ before ΑΕ; Α.Ε. before Α.) so the matcher does
  // not stop early on a prefix.
  const COMPANY_FORMS = [
    'ΑΕΒΕ',
    'Α.Ε.Β.Ε.',
    'Α.Ε.',
    'ΑΕ',
    'Ε.Π.Ε.',
    'ΕΠΕ',
    'Ι.Κ.Ε.',
    'ΙΚΕ',
    'Ο.Ε.',
    'ΟΕ',
    'Ε.Ε.',
    'ΕΕ'
  ];
  // Build a single line search around the ΕΠΩΝΥΜΟ token so we capture
  // the company name AND the legal-form abbreviation that may follow or
  // precede it. Scope to a generous window (200 chars) after the keyword.
  const epoLineMatch = t.match(/ΕΠΩΝΥΜΟ\s+ή\s+ΕΠΩΝΥΜΙΑ\s+([^\n]{0,200})/);
  if (epoLineMatch) {
    const window = epoLineMatch[1];
    const detectedForm = COMPANY_FORMS.find((form) => {
      // Word-boundary-ish guard: surround with non-letter on both sides
      // so e.g. "ΑΕ" inside "ΘΑΕΡΑ" doesn't trigger.
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `(^|[^Α-ΩΆ-Ώα-ωά-ώA-Z])${escaped}(?![Α-ΩΆ-Ώα-ωά-ώA-Z])`
      );
      return re.test(window);
    });
    if (detectedForm) {
      owner.isCompany = true;
      owner.legalForm = detectedForm;
      // Reconstruct the company name from the captured tokens. The
      // earlier regex captured firstName/lastName/fatherName as 3 tokens
      // — re-join them in source order; the legal form may be embedded
      // anywhere so include it explicitly when not already present.
      const fragments: string[] = [];
      if (ownerA) {
        fragments.push(ownerA[1], ownerA[2], ownerA[3]);
      } else if (ownerB) {
        fragments.push(ownerB[2], ownerB[3], ownerB[4]);
      }
      let composed = fragments.filter(Boolean).join(' ').trim();
      if (composed && !composed.includes(detectedForm)) {
        composed = `${composed} ${detectedForm}`;
      }
      owner.name = composed || undefined;
      owner.firstName = '';
      owner.lastName = '';
      owner.fatherName = '';
    }
  }

  // Extract ΠΙΝΑΚΑΣ 1 section
  const table1Start = t.indexOf('ΠΙΝΑΚΑΣ 1');
  const table2Start = t.indexOf('ΠΙΝΑΚΑΣ 2');
  if (table1Start === -1) {
    return { owner, buildings: [], skippedLandPlots: 0, failedRows: 0 };
  }

  const table1Text =
    table2Start > table1Start
      ? t.substring(table1Start, table2Start)
      : t.substring(table1Start);

  // Find all ATAK entries
  const atakMatches: { index: number; prefix: string; suffix: string }[] = [];
  const atakRe = /\b(\d{6})\s+(\d{5})\b/g;
  let m;
  while ((m = atakRe.exec(table1Text)) !== null) {
    atakMatches.push({ index: m.index, prefix: m[1], suffix: m[2] });
  }

  const units: ParsedE9Unit[] = [];
  let skippedAsLand = 0;
  let failedRows = 0;

  for (let i = 0; i < atakMatches.length; i++) {
    const { prefix, suffix } = atakMatches[i];
    const startPos = atakMatches[i].index;
    const endPos =
      i + 1 < atakMatches.length ? atakMatches[i + 1].index : table1Text.length;
    const rowText = table1Text.substring(startPos, endPos);

    const unit = parseE9Row(rowText, prefix, suffix);
    if (!unit) {
      failedRows++;
      continue;
    }

    if (isRealBuildingUnit(unit)) {
      units.push(unit);
    } else if (unit.surface > 0) {
      skippedAsLand++;
    }
  }

  // GROUP BY ADDRESS (street + streetNumber), NOT by ATAK prefix.
  // T1.P1.7: group on street+number first, then refine by zipCode only
  // when BOTH the existing group and the incoming unit have a non-empty
  // zip. Otherwise an empty-zip row would split a real building into two
  // groups (e.g. ΣΠΑΡΤΙΑΤΩΝ 9 with one zip-less row alongside zipped
  // siblings produced 2 buildings when it should have been 1).
  const baseKey = (u: ParsedE9Unit) =>
    `${u.street}|${u.streetNumber}`.toUpperCase();

  // Map: baseKey → array of subgroups, each subgroup: { zipCode, units }
  const buildingMap = new Map<
    string,
    { zipCode: string; units: ParsedE9Unit[] }[]
  >();
  for (const unit of units) {
    // Skip units with no address (failed to parse)
    if (!unit.street && !unit.streetNumber) {
      skippedAsLand++;
      continue;
    }
    // Skip structures on agricultural land (ΕΠΙ ΑΓΡΟΤΕΜΑΧΙΟΥ = not rentable)
    if (/ΑΓΡΟΤΕΜΑΧ/i.test(unit.street)) {
      skippedAsLand++;
      continue;
    }
    const k = baseKey(unit);
    if (!buildingMap.has(k)) {
      buildingMap.set(k, []);
    }
    const groups = buildingMap.get(k)!;
    // Merge into an existing subgroup when:
    //   - either side has empty zip (treat as "unknown, same building"), or
    //   - both sides agree on zip
    let target = groups.find(
      (g) => !g.zipCode || !unit.zipCode || g.zipCode === unit.zipCode
    );
    if (!target) {
      target = { zipCode: unit.zipCode, units: [] };
      groups.push(target);
    }
    // Promote the subgroup zip if we now know it.
    if (!target.zipCode && unit.zipCode) {
      target.zipCode = unit.zipCode;
    }
    target.units.push(unit);
  }

  const buildings: ParsedE9Building[] = [];
  const allBuildingUnitGroups: ParsedE9Unit[][] = [];
  for (const groups of buildingMap.values()) {
    for (const g of groups) {
      allBuildingUnitGroups.push(g.units);
    }
  }
  for (const buildingUnits of allBuildingUnitGroups) {
    const firstUnit = buildingUnits[0];

    // Use the most common ATAK prefix among units in this building
    const prefixCounts = new Map<string, number>();
    for (const u of buildingUnits) {
      const p = u.atakNumber.substring(0, 6);
      prefixCounts.set(p, (prefixCounts.get(p) || 0) + 1);
    }
    let dominantPrefix = firstUnit.atakNumber.substring(0, 6);
    let maxCount = 0;
    for (const [p, count] of prefixCounts.entries()) {
      if (count > maxCount) {
        dominantPrefix = p;
        maxCount = count;
      }
    }

    const allBlockStreets = new Set<string>();
    for (const unit of buildingUnits) {
      unit.blockStreets.forEach((s) => allBlockStreets.add(s));
    }

    const yearBuilt = buildingUnits.find((u) => u.yearBuilt)?.yearBuilt || null;

    // Use the most complete zipCode available from any unit in the building
    const zipCode = buildingUnits.find((u) => u.zipCode)?.zipCode || '';

    // T3.P1.25: aggregate blockNumber from any unit that has one (mirror
    // yearBuilt aggregation above). Previously we always took
    // firstUnit.blockNumber — when the first row of a building had no
    // block-number column (common when the first unit is an aux/storage
    // entry), the building was emitted with blockNumber:'' even though
    // sibling rows declared the block.
    const blockNumber =
      buildingUnits.find((u) => u.blockNumber)?.blockNumber || '';

    buildings.push({
      atakPrefix: dominantPrefix,
      address: {
        street1: `${firstUnit.street} ${firstUnit.streetNumber}`.trim(),
        zipCode,
        city: firstUnit.municipality,
        state: firstUnit.state,
        country: 'GR'
      },
      blockNumber,
      blockStreets: Array.from(allBlockStreets),
      yearBuilt,
      units: buildingUnits
    });
  }

  // Count land plots from ΠΙΝΑΚΑΣ 2
  const table2Entries =
    table2Start > 0
      ? (t.substring(table2Start).match(/\d{6}\s+\d{5}/g) || []).length
      : 0;

  return {
    owner,
    buildings,
    skippedLandPlots: table2Entries + skippedAsLand,
    failedRows
  };
}
