import 'moment/locale/el';
import { _allocationBullet } from '../components/payment/PaymentTabs';
import moment from 'moment';

// What one attribution of a SAVED payment reads as on the payment's tile
// («↳ Πληρωμή κοινοχρήστου - Κοινόχρηστο Ρεύμα (Κτίριο - Ρεύμα) · για Οκτώβριο 2026»).
// A share carried in from an earlier month must say which month it is for here too —
// also when the attribution is of the old kind, a category and no line: such a one
// is shown as the month's first building line, and that can now be a carried share.

const OCT = 2026100100;
const EL = {
  'Payment of rent': 'Πληρωμή ενοικίου',
  'Payment of building charge': 'Πληρωμή κοινοχρήστου',
  'Payment of repair': 'Πληρωμή επισκευής',
  'Payment of property charge': 'Πληρωμή χρέωσης',
  'Electricity Common': 'Κοινόχρηστο Ρεύμα',
  Repair: 'Επισκευή',
  'for {{month}}': 'για {{month}}'
};
const t = (key, values = {}) =>
  (EL[key] ?? key).replace(/\{\{(\w+)\}\}/g, (m, name) => values[name] ?? m);
const bullet = (entry, rent) => {
  const { lead, paren } = _allocationBullet(entry, t, rent, undefined, 'el');
  return `${lead}${paren}`.replace(/\u00a0/g, ' ');
};

const own = {
  description: 'ΡΕΥΜΑ',
  amount: 40,
  buildingName: 'ΚΤΙΡΙΟ',
  type: 'electricity_common',
  propertyId: 'pA',
  expenseId: 'ePower'
};
const carried = { ...own, amount: 30, forTerm: OCT };

beforeAll(() => moment.locale('el'));

describe('a saved payment attributed to a building line, on its tile', () => {
  it('to a carried share, by its key: the month it is for', () => {
    expect(
      bullet(
        {
          category: 'buildingCharge',
          lineKey: 'building:pA:ePower:2610',
          amount: 30
        },
        { buildingCharges: [own, carried] }
      )
    ).toBe(
      'Πληρωμή κοινοχρήστου - Κοινόχρηστο Ρεύμα (ΚΤΙΡΙΟ - ΡΕΥΜΑ) · για Οκτώβριο 2026'
    );
  });

  it('to a line of the month itself: no month, as always', () => {
    expect(
      bullet(
        { category: 'buildingCharge', lineKey: 'building:0', amount: 40 },
        { buildingCharges: [own, carried] }
      )
    ).toBe('Πληρωμή κοινοχρήστου - Κοινόχρηστο Ρεύμα (ΚΤΙΡΙΟ - ΡΕΥΜΑ)');
  });

  it('an old attribution (a category, no line) on a month whose only building line is a carried share: the month it is for', () => {
    expect(
      bullet(
        { category: 'buildingCharge', amount: 30 },
        { buildingCharges: [carried] }
      )
    ).toBe(
      'Πληρωμή κοινοχρήστου - Κοινόχρηστο Ρεύμα (ΚΤΙΡΙΟ - ΡΕΥΜΑ) · για Οκτώβριο 2026'
    );
  });

  it('…and none when the first building line is one of the month itself', () => {
    expect(
      bullet(
        { category: 'buildingCharge', amount: 30 },
        { buildingCharges: [own, carried] }
      )
    ).toBe('Πληρωμή κοινοχρήστου - Κοινόχρηστο Ρεύμα (ΚΤΙΡΙΟ - ΡΕΥΜΑ)');
  });

  it('a carried line that names no kind of expense still says its month', () => {
    expect(
      bullet(
        { category: 'buildingCharge', amount: 30 },
        { buildingCharges: [{ ...carried, type: undefined }] }
      )
    ).toBe('Πληρωμή κοινοχρήστου (ΡΕΥΜΑ) · για Οκτώβριο 2026');
  });

  it('rent and the other lines are untouched', () => {
    const rent = {
      preTaxAmounts: [{ description: 'Διαμέρισμα 1', amount: 400 }],
      buildingCharges: [carried]
    };
    expect(bullet({ category: 'rent', lineKey: 'preTax:0', amount: 400 }, rent)).toBe(
      'Πληρωμή ενοικίου (Διαμέρισμα 1)'
    );
    expect(bullet({ category: 'rent', amount: 400 }, rent)).toBe(
      'Πληρωμή ενοικίου (Διαμέρισμα 1)'
    );
  });
});
