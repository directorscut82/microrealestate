/**
 * Building / apartment display names.
 *
 * The bug this exists for: the bill-import building dropdown rendered
 * «ΟΔΟΣ ΑΛΦΑ 1 — ΟΔΟΣ ΑΛΦΑ 1». It appended `address.street1` to EVERY option so
 * two same-named buildings could be told apart. The requirement was real; applying
 * it unconditionally was not — Greek buildings are normally named after their
 * street, and `name === address.street1` on every building in the live realm.
 *
 * Landlord's rule: a κοινόχρηστος bill is identified by its ADDRESS; an apartment
 * bill must also show the apartment's ΑΤΑΚ. Disambiguation is a property of the
 * LIST, so it lives in `buildingOptionLabels`, not in every label.
 */
import {
  billTargetLabel,
  buildingLabel,
  buildingOptionLabels,
  unitLabel
} from '../utils/entityLabels';

const DOUBLED = /(.+) — \1/;

describe('buildingLabel', () => {
  it('renders the name once when the street IS the name (the reported bug)', () => {
    expect(
      buildingLabel({
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009999'
      })
    ).toBe('ΟΔΟΣ ΑΛΦΑ 1');
  });

  it('never invents a qualifier, even when street and ΑΤΑΚ are both present', () => {
    // For a κοινόχρηστο the address IS the identification. Decoration that solves
    // a problem this list does not have is exactly what was reported.
    expect(
      buildingLabel({
        name: 'Πολυκατοικία Α',
        address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' },
        atakPrefix: '009999'
      })
    ).toBe('Πολυκατοικία Α');
  });

  it('falls back to street, then ΑΤΑΚ, for a nameless building', () => {
    expect(buildingLabel({ address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' } })).toBe(
      'ΟΔΟΣ ΒΗΤΑ 9'
    );
    expect(buildingLabel({ atakPrefix: '009999' })).toBe('009999');
  });

  it('never renders undefined or null', () => {
    for (const input of [
      {},
      null,
      undefined,
      { name: undefined },
      { name: null, address: { street1: undefined } }
    ]) {
      const out = buildingLabel(input);
      expect(typeof out).toBe('string');
      expect(out).not.toMatch(/undefined|null/);
    }
  });
});

describe('buildingOptionLabels — disambiguate the LIST, not every label', () => {
  it('leaves unique names alone, so no option is ever doubled', () => {
    const m = buildingOptionLabels([
      { _id: '1', name: 'ΟΔΟΣ ΑΛΦΑ 1', address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' } },
      { _id: '2', name: 'ΟΔΟΣ ΒΗΤΑ 9', address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' } }
    ]);
    expect(m.get('1')).toBe('ΟΔΟΣ ΑΛΦΑ 1');
    expect(m.get('2')).toBe('ΟΔΟΣ ΒΗΤΑ 9');
    for (const v of m.values()) expect(v).not.toMatch(DOUBLED);
  });

  it('qualifies by STREET when names collide but streets differ', () => {
    const m = buildingOptionLabels([
      { _id: '1', name: 'Πολυκατοικία', address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' } },
      { _id: '2', name: 'Πολυκατοικία', address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' } }
    ]);
    expect(m.get('1')).toBe('Πολυκατοικία — ΟΔΟΣ ΑΛΦΑ 1');
    expect(m.get('2')).toBe('Πολυκατοικία — ΟΔΟΣ ΒΗΤΑ 9');
    expect(m.get('1')).not.toBe(m.get('2'));
  });

  it('falls through to ΑΤΑΚ when name AND street both collide', () => {
    // The case the original qualifier existed for: two identical options is also
    // a shipped bug. atakPrefix is the de-duped field, so it always separates.
    const m = buildingOptionLabels([
      {
        _id: '1',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009991'
      },
      {
        _id: '2',
        name: 'ΟΔΟΣ ΑΛΦΑ 1',
        address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
        atakPrefix: '009992'
      }
    ]);
    expect(m.get('1')).toBe('ΟΔΟΣ ΑΛΦΑ 1 (009991)');
    expect(m.get('2')).toBe('ΟΔΟΣ ΑΛΦΑ 1 (009992)');
    expect(m.get('1')).not.toBe(m.get('2'));
  });

  it('treats accent/case/spacing variants as the SAME name when colliding', () => {
    const m = buildingOptionLabels([
      { _id: '1', name: 'Οδός Άλφα 1', atakPrefix: '009991' },
      { _id: '2', name: 'ΟΔΟΣ ΑΛΦΑ 1', atakPrefix: '009992' }
    ]);
    // Both must be qualified — otherwise the landlord sees two options that look
    // identical apart from accents.
    expect(m.get('1')).toBe('Οδός Άλφα 1 (009991)');
    expect(m.get('2')).toBe('ΟΔΟΣ ΑΛΦΑ 1 (009992)');
  });

  it('every option in a realistic mixed list is DISTINCT and undoubled', () => {
    const list = [
      { _id: '1', name: 'ΟΔΟΣ ΑΛΦΑ 1', address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' }, atakPrefix: '009991' },
      { _id: '2', name: 'ΟΔΟΣ ΒΗΤΑ 9', address: { street1: 'ΟΔΟΣ ΒΗΤΑ 9' }, atakPrefix: '009992' },
      { _id: '3', name: 'ΟΔΟΣ ΓΑΜΑ 12', address: { street1: 'ΟΔΟΣ ΓΑΜΑ 12' }, atakPrefix: '009993' },
      { _id: '4', name: 'ΟΔΟΣ ΓΑΜΑ 12', address: { street1: 'ΟΔΟΣ ΓΑΜΑ 12' }, atakPrefix: '009994' }
    ];
    const labels = [...buildingOptionLabels(list).values()];
    expect(new Set(labels).size).toBe(labels.length);
    for (const v of labels) expect(v).not.toMatch(DOUBLED);
  });

  it('handles an empty or junk list without throwing', () => {
    expect(buildingOptionLabels([]).size).toBe(0);
    expect(buildingOptionLabels(null).size).toBe(0);
    expect(buildingOptionLabels(undefined).size).toBe(0);
    expect(buildingOptionLabels([null, undefined]).size).toBe(0);
  });
});

describe('unitLabel', () => {
  it('shows the ΑΤΑΚ beside the name (the established UnitList pattern)', () => {
    expect(unitLabel({ name: 'Α2', atakNumber: '00999900001' })).toBe(
      'Α2 (00999900001)'
    );
  });

  it('falls back to the ΑΤΑΚ when the unit has no name', () => {
    // MEASURED: units in the live realm legitimately have `name: undefined`.
    expect(unitLabel({ atakNumber: '00999900001' })).toBe('00999900001');
    expect(
      unitLabel({ name: undefined, atakNumber: '00999900001' })
    ).not.toMatch(/undefined/);
  });

  it('never renders undefined for an empty unit', () => {
    expect(unitLabel({})).toBe('');
    expect(unitLabel(null)).toBe('');
  });
});

describe('billTargetLabel — the landlord’s rule', () => {
  const building = {
    name: 'ΟΔΟΣ ΑΛΦΑ 1',
    address: { street1: 'ΟΔΟΣ ΑΛΦΑ 1' },
    atakPrefix: '009999'
  };
  const unit = { name: 'Α2', atakNumber: '00999900001' };

  it('κοινόχρηστο → the address alone identifies it', () => {
    expect(billTargetLabel({ building, shared: true })).toBe('ΟΔΟΣ ΑΛΦΑ 1');
  });

  it('a shared bill is NEVER attributed to one flat, even if a unit is passed', () => {
    expect(billTargetLabel({ building, unit, shared: true })).toBe(
      'ΟΔΟΣ ΑΛΦΑ 1'
    );
  });

  it('apartment bill → the ΑΤΑΚ is shown too', () => {
    expect(billTargetLabel({ building, unit })).toBe(
      'ΟΔΟΣ ΑΛΦΑ 1 · Α2 (00999900001)'
    );
  });

  it('no unit and not shared → the building alone', () => {
    expect(billTargetLabel({ building })).toBe('ΟΔΟΣ ΑΛΦΑ 1');
  });

  it('never renders undefined for a nameless unit', () => {
    const out = billTargetLabel({
      building,
      unit: { atakNumber: '00999900002' }
    });
    expect(out).toBe('ΟΔΟΣ ΑΛΦΑ 1 · 00999900002');
    expect(out).not.toMatch(/undefined/);
  });

  it('survives being called with nothing', () => {
    expect(billTargetLabel()).toBe('');
    expect(billTargetLabel({})).toBe('');
  });
});
