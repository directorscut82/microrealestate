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
  const cleaned = value.replace(/[€\s]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function between(text: string, startLabel: string, endLabel: string): string {
  const escStart = startLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const endParts = endLabel
    .split('|')
    .map((p) => p.replace(/[.*+?^${}()[\]\\]/g, '\\$&'));
  const escEnd = endParts.join('|');
  const re = new RegExp(escStart + '\\s*(.+?)\\s*(?:' + escEnd + ')', 's');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function cleanState(state: string): string {
  // ΑΘΗΝΩΝ (ΝΟΜΑΡΧΙΑ) → ΑΘΗΝΑ
  return state
    .replace(/\(ΝΟΜΑΡΧΙΑ\)/gi, '')
    .replace(/ΩΝ$/, 'Α')
    .replace(/ων$/, 'α')
    .trim();
}

function cleanCity(city: string): string {
  // ΓΑΛΑΤΣΙΟΥ → ΓΑΛΑΤΣΙ
  return city
    .replace(/ΟΥ$/, '')
    .replace(/ου$/, '')
    .replace(/ΑΣ$/, 'Α')
    .replace(/ας$/, 'α')
    .trim();
}

export function parseE9(text: string): ParsedE9Result {
  if (!text || !text.trim()) {
    return { owner: { taxId: '', lastName: '', firstName: '', fatherName: '' }, buildings: [], skippedLandPlots: 0 };
  }

  // Normalize whitespace
  const t = text
    .replace(/---\s*PAGE BREAK\s*---/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();

  // Parse owner from page 1
  const owner: ParsedE9Owner = {
    taxId: '',
    lastName: '',
    firstName: '',
    fatherName: ''
  };

  // Extract owner info from the ΣΤΟΙΧΕΙΑ ΤΟΥ ΥΠΟΧΡΕΟΥ section.
  // AADE E9 PDFs vary in text extraction order. Two known formats:
  //   Format A: ...ΕΠΩΝΥΜΙΑ <father> <first> <last> <taxId>...
  //   Format B: ...ΠΑΤΡΩΝΥΜΟ <taxId> <last> <first> <father>...
  const GK = '[Α-ΩΆ-Ώα-ωά-ώA-Z]+';
  const ownerA = t.match(
    new RegExp(`ΕΠΩΝΥΜΟ\\s+ή\\s+ΕΠΩΝΥΜΙΑ\\s+(${GK})\\s+(${GK})\\s+(${GK})\\s+(\\d{9})`)
  );
  const ownerB = t.match(
    new RegExp(`ΑΦΜ\\s+ΕΠΩΝΥΜΟ\\s+ή\\s+ΕΠΩΝΥΜΙΑ\\s+ΟΝΟΜΑ\\s+ΠΑΤΡΩΝΥΜΟ\\s+(\\d{9})\\s+(${GK})\\s+(${GK})\\s+(${GK})`)
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
  // Fallback: grab tax ID from page-2 header if still missing
  if (!owner.taxId) {
    const afmAlt = t.match(/ΑΦΜ\s+υπόχρεου\s*:\s*(\d+)/);
    if (afmAlt) owner.taxId = afmAlt[1];
  }

  // Extract ΠΙΝΑΚΑΣ 1 section (properties with buildings)
  const table1Start = t.indexOf('ΠΙΝΑΚΑΣ 1');
  const table2Start = t.indexOf('ΠΙΝΑΚΑΣ 2');
  if (table1Start === -1) {
    return { owner, buildings: [], skippedLandPlots: 0 };
  }

  const table1Text = table2Start > table1Start
    ? t.substring(table1Start, table2Start)
    : t.substring(table1Start);

  // Parse property rows - look for ATAK patterns (6-digit + 5-digit number pairs)
  const units: ParsedE9Unit[] = [];
  // Find all ATAK pairs first, then process each row between them
  const atakMatches: { index: number; prefix: string; suffix: string }[] = [];
  const atakRe = /\b(\d{6})\s+(\d{5})\b/g;
  let m;
  while ((m = atakRe.exec(table1Text)) !== null) {
    atakMatches.push({ index: m.index, prefix: m[1], suffix: m[2] });
  }

  for (let i = 0; i < atakMatches.length; i++) {
    const { prefix: atakPrefix, suffix: atakSuffix } = atakMatches[i];
    const atakNumber = atakPrefix + atakSuffix;

    const startPos = atakMatches[i].index;
    const endPos = i + 1 < atakMatches.length ? atakMatches[i + 1].index : table1Text.length;
    const rowText = table1Text.substring(startPos, endPos);

    // Parse row fields - this is tricky because columns run together
    // Try to extract fields in order they appear

    // State (ΝΟΜΟΣ) - usually contains (ΝΟΜΑΡΧΙΑ) or (ΝΟΜΑΡΧ)
    const stateMatch = rowText.match(/([Α-ΖΑ-Ω\.]+(?:\s+\([Α-ΖΝΟΜΑΡΧΙΑ]+\))?)/);
    const state = stateMatch ? cleanState(stateMatch[1]) : '';

    // Municipality (ΔΗΜΟΣ) - follows state
    const municipalityMatch = rowText.match(/\([Α-ΖΝΟΜΑΡΧΙΑ]+\)\s+([Α-ΖΑ-Ω]+)/);
    const municipality = municipalityMatch ? cleanCity(municipalityMatch[1]) : '';

    // Street and number - pattern: STREET_NAME NUMBER
    const streetMatch = rowText.match(/([Α-ΖΑ-Ω\.]+(?:\s+[Α-ΖΑ-Ω\.]+)*)\s+(\d+)/);
    const street = streetMatch ? streetMatch[1].trim() : '';
    const streetNumber = streetMatch ? streetMatch[2] : '';

    // Zip code - 5 digits that is NOT the ATAK suffix
    const allFiveDigit = [...rowText.matchAll(/\b(\d{5})\b/g)];
    const zipCandidate = allFiveDigit.find((zm) => zm[1] !== atakSuffix);
    const zipCode = zipCandidate ? zipCandidate[1] : '';

    // District - between street and zip, or after municipality
    let district = '';
    if (municipality && zipCode) {
      const districtMatch = rowText.match(new RegExp(`${municipality}\\s+([Α-ΖΑ-Ω\\s]+?)\\s+${zipCode}`));
      if (districtMatch) district = districtMatch[1].trim();
    }

    // Block streets - marked with X, multiple streets separated
    const blockStreetsRaw: string[] = [];
    const xPattern = /X\s+([Α-ΖΑ-Ω]+)/g;
    let xMatch;
    while ((xMatch = xPattern.exec(rowText)) !== null) {
      blockStreetsRaw.push(xMatch[1]);
    }

    // Block number - 2-4 digit number after streets
    const blockMatch = rowText.match(/\b(\d{2,4})\b/);
    const blockNumber = blockMatch ? blockMatch[1] : '';

    // Floor - single digit after block, before surface
    const floorMatch = rowText.match(/\b(\d)\s+(\d)\s+([\d,]+)/);
    const floor = floorMatch ? parseInt(floorMatch[1], 10) : null;

    // Surface - Greek decimal like "72,00"
    const surfaceMatch = rowText.match(/([\d]+,\d{2})\s*(\d{4})?/);
    const surface = surfaceMatch ? parseGreekDecimal(surfaceMatch[1]) : 0;

    // Year built - 4 digits
    const yearMatch = rowText.match(/\b(19\d{2}|20\d{2})\b/);
    const yearBuilt = yearMatch ? parseInt(yearMatch[1], 10) : null;

    // Ownership percentage - format "100, 0000" or "100,0000" (100%)
    const ownershipMatch = rowText.match(/([\d]+),?\s*(\d{4})/);
    const ownershipPercentage = ownershipMatch
      ? parseFloat(ownershipMatch[1] + '.' + ownershipMatch[2].substring(0, 2))
      : 100;

    // Electricity supply - "ΝΑΙ" followed by number
    const electricityMatch = rowText.match(/ΝΑΙ\s+(\d+)/i);
    const isElectrified = /ΝΑΙ/i.test(rowText);
    const electricitySupplyNumber = electricityMatch ? electricityMatch[1] : '';

    // Only include if has building data (surface > 0)
    if (surface > 0) {
      units.push({
        atakNumber,
        state,
        municipality,
        district,
        street,
        streetNumber,
        zipCode,
        blockNumber,
        blockStreets: blockStreetsRaw,
        floor,
        surface,
        auxSurface: 0, // Not clearly parsed from this format
        landSurface: 0, // Separate field, skip for now
        yearBuilt,
        ownershipPercentage,
        electricitySupplyNumber,
        isElectrified
      });
    }
  }

  // Group units by ATAK prefix into buildings
  const buildingMap = new Map<string, ParsedE9Unit[]>();
  for (const unit of units) {
    const prefix = unit.atakNumber.substring(0, 6);
    if (!buildingMap.has(prefix)) {
      buildingMap.set(prefix, []);
    }
    buildingMap.get(prefix)!.push(unit);
  }

  const buildings: ParsedE9Building[] = [];
  for (const [prefix, buildingUnits] of buildingMap.entries()) {
    // Use first unit's data for building-level fields
    const firstUnit = buildingUnits[0];

    // Aggregate block streets from all units
    const allBlockStreets = new Set<string>();
    for (const unit of buildingUnits) {
      unit.blockStreets.forEach(s => allBlockStreets.add(s));
    }

    // Determine common year built (use first non-null)
    const yearBuilt = buildingUnits.find(u => u.yearBuilt)?.yearBuilt || null;

    buildings.push({
      atakPrefix: prefix,
      address: {
        street1: `${firstUnit.street} ${firstUnit.streetNumber}`,
        zipCode: firstUnit.zipCode,
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

  // Count skipped land plots (rough estimate - ΠΙΝΑΚΑΣ 2 entries)
  const table2Entries = table2Start > 0
    ? (t.substring(table2Start).match(/\d{6}\s+\d{5}/g) || []).length
    : 0;

  return {
    owner,
    buildings,
    skippedLandPlots: table2Entries
  };
}
