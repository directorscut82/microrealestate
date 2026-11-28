import React from 'react';
import { JSDOM } from 'jsdom';
import moment from 'moment';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PaymentTabs from '../components/payment/PaymentTabs';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost'
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {}
});

// The payment window of a month that another window has already changed: the server
// refuses the save with 409 (the tenant's version is not the one this window loaded)
// and the window used to toast the server's English text. It now says what the terminate
// window says. The real PaymentTabs is mounted and saved through its ref, as the outer
// dialog does; only what is around it (the request, the toasts, the translations) is
// replaced. Every other refusal is toasted as it always was.

const mockPayRent = jest.fn();
const mockToast = { success: jest.fn(), error: jest.fn() };

jest.mock('next-translate/useTranslation', () => ({
  __esModule: true,
  default: () => ({
    lang: 'el',
    t: (key, values = {}) =>
      key.replace(/\{\{(\w+)\}\}/g, (m, name) => values[name] ?? m)
  })
}));
jest.mock('sonner', () => ({
  toast: {
    success: (...a) => mockToast.success(...a),
    error: (...a) => mockToast.error(...a)
  }
}));
jest.mock('../hooks/useFormatNumber', () => ({
  __esModule: true,
  default: () => (value) => String(value)
}));
jest.mock('../utils/fetch', () => ({ apiFetcher: () => ({}) }));
jest.mock('../utils/restcalls', () => ({
  ...jest.requireActual('../utils/restcalls'),
  payRent: (...a) => mockPayRent(...a)
}));

const STALE =
  'This tenant was modified since you loaded the page (a payment may have been recorded elsewhere). Reload and try again.';
const GREEK_KEY =
  'This tenant was changed by another window. Reload the page and try again.';

// A payment dated the first of the rent's own month, so the date guards let the save go out
const month = moment.utc().startOf('month');
const rent = {
  _id: 'tenant-1',
  term: Number(month.format('YYYYMMDDHH')),
  month: month.month() + 1,
  year: month.year(),
  _tenantVersion: 3,
  payments: [{ amount: 100, date: month.format('DD/MM/YYYY'), type: 'cash' }]
};

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const refusal = (status, message) => ({
  response: { status, data: message ? { message } : {} }
});

describe('the payment window refused for a tenant another window changed', () => {
  let container;
  let root;
  let queryClient;
  let ref;
  let onSubmit;
  let onError;

  const save = async () => {
    await act(async () => {
      await ref.current.submit();
      for (let i = 0; i < 4; i += 1) await nextTask();
    });
  };

  beforeEach(async () => {
    mockPayRent.mockReset();
    Object.values(mockToast).forEach((f) => f.mockReset());
    // the catch logs what it was given
    jest.spyOn(console, 'error').mockImplementation(() => {});
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    ref = React.createRef();
    onSubmit = jest.fn();
    onError = jest.fn();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PaymentTabs
            ref={ref}
            rent={rent}
            onSubmit={onSubmit}
            onError={onError}
          />
        </QueryClientProvider>
      );
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.removeChild(container);
    queryClient.clear();
    jest.restoreAllMocks();
  });
  afterAll(() => dom.window.close());

  const outcomeIsRefused = () => {
    expect(mockPayRent).toHaveBeenCalledTimes(1);
    expect(mockToast.error).toHaveBeenCalledTimes(1);
    expect(mockToast.success).not.toHaveBeenCalled();
    // the outer dialog frees its «Record» button through onError
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  };

  it('a 409 says it in Greek, not in the server’s English', async () => {
    mockPayRent.mockRejectedValue(refusal(409, STALE));
    await save();

    outcomeIsRefused();
    expect(mockToast.error).toHaveBeenCalledWith(GREEK_KEY);
    expect(JSON.stringify(mockToast.error.mock.calls)).not.toContain(
      'modified since you loaded'
    );
  });

  it('a 422 is still toasted with the server’s own message', async () => {
    mockPayRent.mockRejectedValue(
      refusal(422, 'payments[0].promo cannot exceed grand total')
    );
    await save();

    outcomeIsRefused();
    expect(mockToast.error).toHaveBeenCalledWith(
      'payments[0].promo cannot exceed grand total'
    );
  });

  it('a 500 that says nothing is «Something went wrong»', async () => {
    mockPayRent.mockRejectedValue(refusal(500));
    await save();

    outcomeIsRefused();
    expect(mockToast.error).toHaveBeenCalledWith('Something went wrong');
  });

  it('a failure with no answer from the server is «Something went wrong»', async () => {
    mockPayRent.mockRejectedValue(new Error('Network Error'));
    await save();

    outcomeIsRefused();
    expect(mockToast.error).toHaveBeenCalledWith('Something went wrong');
  });
});
