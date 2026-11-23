import 'moment/locale/el';
import el from '../../locales/el/common.json';
import LineName from '../components/LineName';
import moment from 'moment';
import { MonthlyBreakdown } from '../components/rents/RentTable';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The rents page, hovering «Μηνιαίο ποσό»: the lines of the month. A share carried in
// from an earlier month says which month it is for — and where the name is cut for
// lack of room (a phone), the month must not be what is cut: at the end of a long
// name it was the first thing to go.

jest.mock('next-translate/useTranslation', () => ({
  __esModule: true,
  default: () => {
    // eslint-disable-next-line global-require
    const strings = require('../../locales/el/common.json');
    return {
      lang: 'el',
      t: (key, values = {}) =>
        (strings[key] ?? key).replace(
          /\{\{(\w+)\}\}/g,
          (m, name) => values[name] ?? m
        )
    };
  }
}));
jest.mock('../components/NumberFormat', () => ({
  __esModule: true,
  default: ({ value }) => `${Number(value).toFixed(2).replace('.', ',')} €`
}));

const OCT = 2026100100;
const own = {
  description: 'ΡΕΥΜΑ ΚΟΙΝΟΧΡΗΣΤΩΝ',
  amount: 40,
  buildingName: 'ΚΤΙΡΙΟ',
  type: 'electricity_common'
};
const carried = { ...own, amount: 30, forTerm: OCT };
const hover = (buildingCharges) =>
  renderToStaticMarkup(
    <MonthlyBreakdown
      rentAmounts={{
        preTaxAmounts: [{ description: 'Διαμέρισμα 1', amount: 400 }],
        charges: [],
        buildingCharges,
        discount: 0,
        additionalCosts: 0,
        rent: 400 + buildingCharges.reduce((s, c) => s + c.amount, 0)
      }}
    />
  ).replace(/\u00a0/g, ' ');

beforeAll(() => moment.locale('el'));

describe('the month a carried share is for, where a name is cut short', () => {
  it('sits in a part of its own that is never cut; the name before it may be', () => {
    const html = hover([carried]);
    expect(html).toContain(
      '<span class="truncate">Κοινόχρηστο Ρεύμα  (ΚΤΙΡΙΟ - ΡΕΥΜΑ ΚΟΙΝΟΧΡΗΣΤΩΝ)</span>' +
        '<span class="ml-1 shrink-0 whitespace-nowrap">· για Οκτώβριο 2026</span>'
    );
    // the element around the two does not cut either
    expect(html).toContain(
      '<span class="text-muted-foreground min-w-0"><span class="flex min-w-0">'
    );
    expect(el['for {{month}}']).toBe('για {{month}}');
  });

  it('a line of the month itself is one piece, cut as it always was', () => {
    const html = hover([own]);
    expect(html).toContain(
      '<span class="text-muted-foreground truncate">Κοινόχρηστο Ρεύμα  (ΚΤΙΡΙΟ - ΡΕΥΜΑ ΚΟΙΝΟΧΡΗΣΤΩΝ)</span>'
    );
    expect(html).not.toContain('για ');
    expect(html).not.toContain('shrink-0 whitespace-nowrap');
  });

  it('both on one month: each as itself', () => {
    const html = hover([own, carried]);
    expect(html.match(/shrink-0 whitespace-nowrap/g)).toHaveLength(1);
    expect(html.match(/Κοινόχρηστο Ρεύμα/g)).toHaveLength(2);
  });
});

describe('the name of a line where room is short', () => {
  it('with a month: the name, then the month apart', () => {
    expect(
      renderToStaticMarkup(
        <LineName label="Name (A - B) · για Οκτώβριο 2026" suffix=" · για Οκτώβριο 2026" />
      )
    ).toBe(
      '<span class="flex min-w-0"><span class="truncate">Name (A - B)</span>' +
        '<span class="ml-1 shrink-0 whitespace-nowrap">· για Οκτώβριο 2026</span></span>'
    );
  });

  it.each([
    ['none', ''],
    ['undefined', undefined]
  ])('with no month (%s): the label and nothing around it', (_what, suffix) => {
    expect(
      renderToStaticMarkup(<LineName label="Name (A - B)" suffix={suffix} />)
    ).toBe('Name (A - B)');
  });
});
