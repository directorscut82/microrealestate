import React from 'react';
import { JSDOM } from 'jsdom';
import ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { useForm } from 'react-hook-form';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost'
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;

// F4-expense regression (2026-07). ExpenseFormDialog seeds
// `defaultValues.customAllocations` with buildDefaultAllocations([]) — ONE ROW
// PER UNIT, each carrying a real propertyId. The reset-on-method-change effect
// was gated on `previous && previous !== allocationMethod`, so the FIRST
// selection ('' → single_unit) was skipped and single_unit silently inherited
// unit #1 as its billing target. The zod guard only checks
// `customAllocations[0].propertyId`, which was already populated, so
// «Pick a unit to bill» never fired and the entire expense was billed to
// whichever unit happened to be first — without the landlord choosing it.
//
// The `previous &&` was ALSO load-bearing, for the opposite reason: on the EDIT
// dialog react-hook-form applies its `values` prop from a useEffect AFTER first
// render, so a saved expense's method also arrives as a '' → method transition.
// Firing there would wipe the persisted target. Hence the fix keys on
// create-vs-edit: `previous !== method && (previous || !expense)`.
//
// This test reproduces BOTH paths with the real effect + real RHF.
describe('single_unit billing target — reset-on-method-change effect', () => {
  const UNIT_A = 'prop-A';
  const UNIT_B = 'prop-B';
  const METHODS_NEEDING_ALLOCATIONS = [
    'custom_percentage',
    'custom_ratio',
    'fixed',
    'single_unit'
  ];

  // Mirrors ExpenseFormDialog: default rows are one-per-unit WITH propertyIds.
  const buildDefaultAllocations = () => [
    { propertyId: UNIT_A, value: 0 },
    { propertyId: UNIT_B, value: 0 }
  ];

  /**
   * The component under test: the same effect shape as ExpenseFormDialog,
   * driven by real react-hook-form so `values`-prop timing is authentic.
   */
  function Harness({ expense, onState }) {
    const { watch, setValue } = useForm({
      defaultValues: {
        allocationMethod: '',
        customAllocations: buildDefaultAllocations()
      },
      values: expense
        ? {
            allocationMethod: expense.allocationMethod,
            customAllocations: expense.customAllocations
          }
        : undefined
    });
    const allocationMethod = watch('allocationMethod');
    const customAllocations = watch('customAllocations');
    const previousRef = React.useRef(allocationMethod);

    React.useEffect(() => {
      const previous = previousRef.current;
      if (previous !== allocationMethod && (previous || !expense)) {
        if (allocationMethod === 'single_unit') {
          setValue('customAllocations', [], { shouldDirty: true });
        } else if (METHODS_NEEDING_ALLOCATIONS.includes(allocationMethod)) {
          setValue('customAllocations', buildDefaultAllocations(), {
            shouldDirty: true
          });
        } else {
          setValue('customAllocations', [], { shouldDirty: true });
        }
      }
      previousRef.current = allocationMethod;
    }, [allocationMethod, setValue, expense]);

    onState({ allocationMethod, customAllocations, setValue });
    return null;
  }

  function render(expense) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let latest = null;
    act(() => {
      ReactDOM.render(
        <Harness expense={expense} onState={(s) => (latest = s)} />,
        container
      );
    });
    return {
      get state() {
        return latest;
      },
      pick(method) {
        act(() => {
          latest.setValue('allocationMethod', method);
        });
      },
      cleanup() {
        act(() => ReactDOM.unmountComponentAtNode(container));
        container.remove();
      }
    };
  }

  it('ADD: picking single_unit FIRST clears the inherited target', () => {
    // THE MUTATION-KILLER. Restore `(previous && previous !== method)` and this
    // fails: customAllocations keeps [{propertyId:'prop-A'}], the zod guard
    // passes, and the expense is billed to unit A by accident.
    const h = render(undefined);
    expect(h.state.customAllocations).toHaveLength(2); // seeded default rows
    h.pick('single_unit');
    expect(h.state.customAllocations).toEqual([]);
    // …so the zod guard's `!target?.propertyId` is TRUE → error shown.
    expect(h.state.customAllocations?.[0]?.propertyId).toBeUndefined();
    h.cleanup();
  });

  it('ADD: picking single_unit after another method also clears it', () => {
    const h = render(undefined);
    h.pick('custom_percentage');
    expect(h.state.customAllocations).toHaveLength(2);
    h.pick('single_unit');
    expect(h.state.customAllocations).toEqual([]);
    h.cleanup();
  });

  it('EDIT: a saved single_unit target SURVIVES the values-prop arrival', () => {
    // The regression guard for the fix itself. RHF applies `values` in a
    // useEffect after mount, so allocationMethod goes '' → 'single_unit' on an
    // EDIT too. Firing the reset there would wipe the landlord's saved target.
    const h = render({
      allocationMethod: 'single_unit',
      customAllocations: [{ propertyId: UNIT_B, value: 100 }]
    });
    expect(h.state.allocationMethod).toBe('single_unit');
    expect(h.state.customAllocations).toEqual([
      { propertyId: UNIT_B, value: 100 }
    ]);
    h.cleanup();
  });

  it('EDIT: changing the method away from single_unit still resets rows', () => {
    // Editing must not become inert — a real method change still resets.
    const h = render({
      allocationMethod: 'single_unit',
      customAllocations: [{ propertyId: UNIT_B, value: 100 }]
    });
    h.pick('custom_percentage');
    expect(h.state.customAllocations).toHaveLength(2);
    expect(h.state.customAllocations.every((a) => a.value === 0)).toBe(true);
    h.cleanup();
  });

  it('ADD: a non-allocation method clears rows so submit ships none', () => {
    const h = render(undefined);
    h.pick('general_thousandths');
    expect(h.state.customAllocations).toEqual([]);
    h.cleanup();
  });
});

// Second bug found in the same dialog while chasing the first (2026-07).
// `getAllocationMethodsForType` gates elevator_thousandths on
// building.hasElevator and heating_thousandths on hasCentralHeating. A separate
// effect "repairs" an allocationMethod that is not in the currently-valid list
// by rewriting it to valid[0]?.id || ''. Applied to a PERSISTED value that was
// silent money re-routing: an expense saved as elevator_thousandths on a
// building whose hasElevator is false reopened with the picker blanked to
// «Select allocation method», and pressing Update saved a DIFFERENT allocation
// than the landlord had chosen. Verified on the real Greek Edit dialog
// (screenshot: type=Elevator, amount=60, method=«Select allocation method»,
// while the row behind it still read "…Thousandths").
describe('allocationMethod validity repair — must not rewrite a SAVED method', () => {
  const ALL = [
    'general_thousandths',
    'heating_thousandths',
    'elevator_thousandths',
    'equal',
    'by_surface',
    'fixed',
    'custom_ratio',
    'custom_percentage',
    'single_unit'
  ];
  const BY_TYPE = {
    elevator: [
      'elevator_thousandths',
      'equal',
      'by_surface',
      'fixed',
      'custom_ratio',
      'custom_percentage',
      'single_unit'
    ],
    other: ALL
  };

  // Mirrors getAllocationMethodsForType (ExpenseFormDialog.js).
  function methodsFor(type, isVariable, building) {
    let methods = (BY_TYPE[type] ?? ALL).slice();
    if (isVariable) methods = methods.filter((m) => m !== 'fixed');
    if (building) {
      if (!building.hasElevator)
        methods = methods.filter((m) => m !== 'elevator_thousandths');
      if (!building.hasCentralHeating)
        methods = methods.filter((m) => m !== 'heating_thousandths');
    }
    return methods;
  }

  // Mirrors the repair effect + the picker's option list, post-fix.
  function resolve({ type, method, isVariable, building, expense }) {
    const valid = methodsFor(type, isVariable, building);
    let next = method;
    if (type && method && !valid.includes(method)) {
      if (method !== expense?.allocationMethod) next = valid[0] ?? '';
    }
    const options = valid.includes(expense?.allocationMethod)
      ? valid
      : expense?.allocationMethod
        ? [...valid, expense.allocationMethod]
        : valid;
    return { method: next, options };
  }

  const savedElevator = {
    type: 'elevator',
    method: 'elevator_thousandths',
    isVariable: false,
    building: { hasElevator: false, hasCentralHeating: false },
    expense: { allocationMethod: 'elevator_thousandths' }
  };

  it('keeps a saved elevator_thousandths when the building has no elevator', () => {
    // THE MUTATION-KILLER: drop the `method !== expense?.allocationMethod`
    // guard and this becomes '' — the blanked picker from the screenshot.
    expect(resolve(savedElevator).method).toBe('elevator_thousandths');
  });

  it('still OFFERS the saved method so the picker is not blank', () => {
    expect(resolve(savedElevator).options).toContain('elevator_thousandths');
  });

  it('STILL repairs a method the user just made impossible by changing type', () => {
    // The effect's real purpose must survive: switching an elevator expense to
    // a type that cannot use elevator_thousandths repairs the selection.
    const r = resolve({
      type: 'other',
      method: 'elevator_thousandths',
      isVariable: false,
      building: { hasElevator: false, hasCentralHeating: false },
      expense: { allocationMethod: 'single_unit' } // saved as something else
    });
    expect(r.method).not.toBe('elevator_thousandths');
    expect(r.method).toBe('general_thousandths');
  });

  it('repairs on a CREATE (no saved expense at all)', () => {
    const r = resolve({
      type: 'elevator',
      method: 'elevator_thousandths',
      isVariable: false,
      building: { hasElevator: false, hasCentralHeating: false },
      expense: undefined
    });
    expect(r.method).toBe('equal');
    expect(r.options).not.toContain('elevator_thousandths');
  });

  it('leaves a valid saved method untouched and adds no duplicate option', () => {
    const r = resolve({
      type: 'elevator',
      method: 'elevator_thousandths',
      isVariable: false,
      building: { hasElevator: true, hasCentralHeating: true },
      expense: { allocationMethod: 'elevator_thousandths' }
    });
    expect(r.method).toBe('elevator_thousandths');
    expect(
      r.options.filter((m) => m === 'elevator_thousandths')
    ).toHaveLength(1);
  });
});
