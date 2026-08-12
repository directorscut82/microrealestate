/**
 * How a building and an apartment are NAMED on screen.
 *
 * THE RULE (landlord's spec, 2026-08-12):
 *   · a κοινόχρηστος bill → the ADDRESS is enough to identify it;
 *   · an APARTMENT bill → the apartment's ΑΤΑΚ must be shown too, because that is
 *     the only value that says WHICH flat.
 *
 * THE BUG THIS REPLACES: the bill-import dropdown rendered
 * «ΟΔΟΣ ΑΛΦΑ 1 — ΟΔΟΣ ΑΛΦΑ 1». It appended `address.street1` to every option so
 * that two same-named buildings could be told apart. The requirement was real —
 * two identical options is also a shipped bug — but the implementation applied the
 * qualifier UNCONDITIONALLY, and Greek buildings are normally named after their
 * street, so it just repeated the name. Measured in the live realm:
 * `name === address.street1` on every building checked.
 *
 * THE FIX, and why it is shaped this way: whether a qualifier is NEEDED is a
 * property of the LIST, not of one building. `buildingLabel` therefore stays plain
 * and never invents a suffix; `buildingOptionLabels` looks at all the options
 * together and qualifies ONLY the ones that would otherwise collide. A label is
 * never decorated to solve a problem the list does not have.
 */

/** Fold accents/case/spacing so «Οδός Άλφα 1» and «ΟΔΟΣ ΑΛΦΑ 1» compare equal. */
function foldGreek(value) {
  return String(value ?? '')
    .trim()
    .toLocaleUpperCase('el-GR')
    .normalize('NFD')
    // Strip combining accents (tonos, dialytika) — NOT the base letters. Explicit
    // escapes: literal combining marks are invisible in an editor.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/** True when `qualifier` adds nothing the `name` does not already say. */
function isRedundant(name, qualifier) {
  const n = foldGreek(name);
  const q = foldGreek(qualifier);
  if (!q) return true;
  return n === q || n.includes(q) || q.includes(n);
}

/**
 * The building's plain display name. No invented qualifier — if the landlord
 * named the building after its street, that name is the identification.
 */
export function buildingLabel(building) {
  const name = String(building?.name ?? '').trim();
  if (name) return name;
  // Nameless building: the street identifies it, else the ΑΤΑΚ prefix.
  const street = String(building?.address?.street1 ?? '').trim();
  const atak = String(building?.atakPrefix ?? '').trim();
  return street || atak || '';
}

/**
 * Labels for a building SELECT, qualified only where needed.
 *
 * Buildings whose plain label is unique keep it. Where two or more collide, each
 * colliding option gains the first qualifier that actually separates them —
 * street if it differs from the name, otherwise the ΑΤΑΚ prefix (the de-duped
 * field, so it always separates).
 *
 * @returns {Map<string, string>} building `_id` → label
 */
export function buildingOptionLabels(buildings) {
  const list = (buildings || []).filter(Boolean);
  const counts = new Map();
  for (const b of list) {
    const key = foldGreek(buildingLabel(b));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const out = new Map();
  for (const b of list) {
    const base = buildingLabel(b);
    if ((counts.get(foldGreek(base)) || 0) < 2) {
      out.set(String(b._id), base);
      continue;
    }
    // Collision: qualify. Street first (more meaningful), ΑΤΑΚ as the guarantee.
    const street = String(b?.address?.street1 ?? '').trim();
    const atak = String(b?.atakPrefix ?? '').trim();
    if (street && !isRedundant(base, street)) {
      out.set(String(b._id), `${base} — ${street}`);
    } else if (atak) {
      out.set(String(b._id), `${base} (${atak})`);
    } else {
      out.set(String(b._id), base);
    }
  }
  return out;
}

/**
 * The apartment's display name — the established UnitList pattern `name (ΑΤΑΚ)`.
 * Never renders «undefined»: units in the live realm legitimately have no `name`.
 */
export function unitLabel(unit) {
  const name = String(unit?.name ?? unit?.unitLabel ?? '').trim();
  const atak = String(unit?.atakNumber ?? '').trim();
  if (name && atak && !isRedundant(name, atak)) return `${name} (${atak})`;
  return name || atak || '';
}

/**
 * Where a bill belongs, per the landlord's rule: the address alone for a
 * κοινόχρηστος bill; the apartment and its ΑΤΑΚ as well for an apartment bill.
 *
 * @param {object}  args
 * @param {object}  args.building the resolved building
 * @param {object=} args.unit     the resolved apartment, for a unit-meter bill
 * @param {boolean=} args.shared  true when a κοινόχρηστος meter matched
 */
export function billTargetLabel({ building, unit, shared } = {}) {
  const b = buildingLabel(building);
  // A shared bill belongs to the whole building — never attribute it to one flat.
  if (shared || !unit) return b;
  const u = unitLabel(unit);
  if (!u) return b;
  return b ? `${b} · ${u}` : u;
}
