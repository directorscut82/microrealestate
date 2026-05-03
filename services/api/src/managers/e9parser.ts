// Parser for Greek E9 property declaration PDFs (AADE Taxisnet)
// Βεβαίωση Δηλωθείσας Περιουσιακής Κατάστασης

export type ParsedE9Owner = {
  taxId: string;
  lastName: string;
  firstName: string;
  fatherName: string;
};

export type ParsedE9Unit = {
  atakNumber: string;
  state: string;
  municipality: string;
  district: string;
  street: string;
  streetNumber: string;
  zipCode: string;
  blockNumber: string;
  blockStreets: string[];
  floor: number | null;
  surface: number;
  auxSurface: number;
  landSurface: number;
  yearBuilt: number | null;
  ownershipPercentage: number;
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
};

function parseGreekDecimal(value: string): number {
  const cleaned = value.replace(/[€\s]/g, '').replace('.', '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function cleanState(state: string): string {
  return state
    .replace(/\(ΝΟΜΑΡΧΙΑ\)/gi, '')
    .replace(/ΩΝ$/, 'Α')
    .replace(/ων$/, 'α')
    .trim();
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
function parseE9Row(rowText: string, atakPrefix: string, atakSuffix: string): ParsedE9Unit | null {
  // Remove the ATAK prefix/suffix from start
  const afterAtak = rowText.substring(12).trim(); // "005578 02430 " = 12 chars

  // Extract state — pattern: "ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ)" or "ΑΝΑΤ. ΑΤΤΙΚΗΣ (ΝΟΜΑΡΧΙΑ)"
  // Also handle non-ΝΟΜΑΡΧΙΑ states like "ΚΥΚΛΑΔΩΝ"
  const stateMatch = afterAtak.match(
    /^([\u0391-\u03A9\u0386-\u038F\.\s]+?)\s*\((?:ΝΟΜΑΡΧ[ΙΑ]*|ΝΟΜΑΡΧΙΑ)\)\s*/
  );
  const stateMatchAlt = !stateMatch
    ? afterAtak.match(
        /^([\u0391-\u03A9\u0386-\u038F]{3,})\s+/
      )
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

  // Find the street+number pattern: one or more Greek words followed by a number
  // The municipality comes before the street
  // Also handle compound municipality names with dashes: "ΕΞΩΜΒΟΥΡΓΟΥ - ΚΑΛΛΟΝΗΣ"
  const municipalityAndStreet = rest.match(
    /^([\u0391-\u03A9\u0386-\u038F\.\s\-]+?)\s+([\u0391-\u03A9\u0386-\u038F\.\s]+?)\s+(\d+)\s/
  );
  // Rural format: "MUNICIPALITY - AREA SETTLEMENT_TYPE SETTLEMENT_NAME X ..."
  const ruralMatch = !municipalityAndStreet
    ? rest.match(
        /^([\u0391-\u03A9\u0386-\u038F\.\s\-]+?)\s+(ΟΙΚΙΣΜΟΣ|ΕΠΙ ΑΓΡΟΤΕΜΑΧΙΟΥ|ΘΕΣΗ|ΠΕΡΙΟΧΗ)\s+([\u0391-\u03A9\u0386-\u038F\.\s]+?)\s+X\b/
      )
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
    municipality = ruralMatch[1].trim();
    street = ruralMatch[3].trim(); // settlement name
    streetNumber = '0'; // no number for rural
    rest = rest.substring(ruralMatch[0].length);
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
        /^([\u0391-\u03A9\u0386-\u038F\.\s\(\)]+?)\s+(\d{1,4})\s/
      );
      if (streetsMatch) {
        const streetsStr = streetsMatch[1].trim();
        // Split on known separators (spaces between multi-word street names)
        streetsStr.split(/\s+/).forEach((s) => {
          if (s.length > 2 && s !== 'ΑΓ.' && s !== 'ΑΓ') {
            blockStreets.push(s);
          }
        });
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
  let ownershipPercentage = 100;
  const ownMatch = rowText.match(/\b(\d{1,3}),\s*0{4}\b/);
  const ownMatch2 = rowText.match(/\b(\d{1,3}),(\d)\s+0{4}\b/);
  if (ownMatch2) {
    ownershipPercentage = parseFloat(`${ownMatch2[1]}.${ownMatch2[2]}`);
  } else if (ownMatch) {
    ownershipPercentage = parseInt(ownMatch[1], 10);
  }

  // Extract year built: 4-digit year 19xx or 20xx
  let yearBuilt: number | null = null;
  const yearMatch = rowText.match(/\b(19\d{2}|20[0-2]\d)\b/);
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
    surface = parseGreekDecimal(
      surfaceCandidates[0][1] + ',' + surfaceCandidates[0][2]
    );
  }
  if (surfaceCandidates.length >= 2) {
    auxSurface = parseGreekDecimal(
      surfaceCandidates[1][1] + ',' + surfaceCandidates[1][2]
    );
  }

  // For large surfaces with dot separators (e.g. "2.478,00" or "1.032,00")
  if (surface === 0) {
    const largeSurfMatch = rowText.match(/\b(\d{1,2}\.\d{3}),(\d{2})\b/);
    if (largeSurfMatch) {
      surface = parseGreekDecimal(largeSurfMatch[1] + ',' + largeSurfMatch[2]);
    }
  }

  // Extract floor: after block streets section, look for the digit pattern
  // In the numeric tail, the sequence is: BLOCK_NUM [1] FLOOR SURFACE
  // Floor can be 0-9 (single digit for most buildings)
  // Special: Υ = underground (basement), Ι = ισόγειο (not always present)
  let floor: number | null = null;

  // Strategy: find the surface value position and look for floor just before it
  if (surface > 0 && surfaceCandidates.length >= 1) {
    const surfacePos = rowText.indexOf(
      surfaceCandidates[0][1] + ',' + surfaceCandidates[0][2]
    );
    // Look at the few characters before surface for floor digit
    const beforeSurface = rowText.substring(
      Math.max(0, surfacePos - 10),
      surfacePos
    ).trim();
    // Floor is the last single digit before the surface
    const floorDigits = beforeSurface.match(/(\d+)\s*$/);
    if (floorDigits) {
      floor = parseInt(floorDigits[1], 10);
    }
    // Check for Υ (underground)
    if (floor === null && /Υ\s*$/.test(beforeSurface)) {
      floor = -1;
    }
  }

  // Block number: first 2-4 digit number that appears after X section
  let blockNumber = '';
  if (hasX) {
    const xPos = rowText.indexOf(' X ');
    const afterXSection = rowText.substring(xPos + 3);
    const blockMatch = afterXSection.match(
      /[\u0391-\u03A9\.\s]+?\s+(\d{1,4})\s+\d/
    );
    if (blockMatch) {
      blockNumber = blockMatch[1];
    }
  }

  // City name from row - look after zip code
  let city = municipality;
  if (zipCode) {
    const afterZipForCity = rowText.substring(
      rowText.lastIndexOf(zipCode) + 6
    );
    const cityMatch = afterZipForCity.match(
      /^([\u0391-\u03A9\u0386-\u038F\.\s]+)/
    );
    if (cityMatch) {
      city = cleanCity(cityMatch[1].trim());
    }
  }

  return {
    atakNumber: atakPrefix + atakSuffix,
    state: cleanState(state),
    municipality: city || cleanCity(municipality),
    district: '',
    street,
    streetNumber,
    zipCode,
    blockNumber,
    blockStreets,
    floor,
    surface,
    auxSurface,
    landSurface: 0,
    yearBuilt,
    ownershipPercentage,
    electricitySupplyNumber,
    isElectrified
  };
}

export function parseE9(text: string): ParsedE9Result {
  if (!text || !text.trim()) {
    return {
      owner: { taxId: '', lastName: '', firstName: '', fatherName: '' },
      buildings: [],
      skippedLandPlots: 0
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

  // Extract ΠΙΝΑΚΑΣ 1 section
  const table1Start = t.indexOf('ΠΙΝΑΚΑΣ 1');
  const table2Start = t.indexOf('ΠΙΝΑΚΑΣ 2');
  if (table1Start === -1) {
    return { owner, buildings: [], skippedLandPlots: 0 };
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

  for (let i = 0; i < atakMatches.length; i++) {
    const { prefix, suffix } = atakMatches[i];
    const startPos = atakMatches[i].index;
    const endPos =
      i + 1 < atakMatches.length
        ? atakMatches[i + 1].index
        : table1Text.length;
    const rowText = table1Text.substring(startPos, endPos);

    const unit = parseE9Row(rowText, prefix, suffix);
    if (!unit) continue;

    if (isRealBuildingUnit(unit)) {
      units.push(unit);
    } else if (unit.surface > 0) {
      skippedAsLand++;
    }
  }

  // GROUP BY ADDRESS (street + streetNumber + zipCode), NOT by ATAK prefix
  // When zip is missing, group by street+number only (merge with any existing)
  const buildingKey = (u: ParsedE9Unit) => {
    const key = `${u.street}|${u.streetNumber}`.toUpperCase();
    return key;
  };

  const buildingMap = new Map<string, ParsedE9Unit[]>();
  for (const unit of units) {
    // Skip units with no address (failed to parse)
    if (!unit.street && !unit.streetNumber) {
      skippedAsLand++;
      continue;
    }
    // Skip structures on agricultural land (ΕΠΙ ΑΓΡΟΤΕΜΑΧΙΟΥ = not rentable)
    if (/ΕΠΙ\s+ΑΓΡΟΤΕΜΑΧ/i.test(unit.street)) {
      skippedAsLand++;
      continue;
    }
    const key = buildingKey(unit);
    if (!buildingMap.has(key)) {
      buildingMap.set(key, []);
    }
    buildingMap.get(key)!.push(unit);
  }

  const buildings: ParsedE9Building[] = [];
  for (const [, buildingUnits] of buildingMap.entries()) {
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

    const yearBuilt =
      buildingUnits.find((u) => u.yearBuilt)?.yearBuilt || null;

    // Use the most complete zipCode available from any unit in the building
    const zipCode = buildingUnits.find((u) => u.zipCode)?.zipCode || '';

    buildings.push({
      atakPrefix: dominantPrefix,
      address: {
        street1: `${firstUnit.street} ${firstUnit.streetNumber}`.trim(),
        zipCode,
        city: firstUnit.municipality,
        state: firstUnit.state,
        country: 'GR'
      },
      blockNumber: firstUnit.blockNumber,
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
    skippedLandPlots: table2Entries + skippedAsLand
  };
}
