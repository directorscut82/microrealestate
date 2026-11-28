import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExpressPaymentDialog from '../components/rents/ExpressPaymentDialog';
import { QueryKeys } from '../utils/restcalls';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost'
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;

// «Έξπρες εξόφληση», the button «Εκτέλεση». It was disabled only once the screen had
// re-rendered with the pending request, so a second press that arrived before that
// sent the whole batch again: the server's version check kept every payment single,
// and the screen then showed «Καταχωρήθηκαν 1 από 2 πληρωμές (1 απέτυχαν)» for a
// batch that had gone through. The real dialog is mounted; only what is around it
// (the drawer, the checkbox, the request, the toasts) is replaced.

const mockPost = jest.fn();
const mockToast = { success: jest.fn(), warning: jest.fn(), error: jest.fn() };

jest.mock('../components/ui/drawer', () => {
  // eslint-disable-next-line global-require
  const R = require('react');
  const box = (tag) => {
    const Box = ({ children }) => R.createElement(tag, null, children);
    return Box;
  };
  return {
    Drawer: ({ open, children }) =>
      open ? R.createElement('div', null, children) : null,
    DrawerContent: box('div'),
    DrawerFooter: box('div'),
    DrawerHeader: box('div'),
    DrawerTitle: box('h2')
  };
});
jest.mock('../components/ui/checkbox', () => {
  // eslint-disable-next-line global-require
  const R = require('react');
  return {
    Checkbox: ({ checked, onCheckedChange }) =>
      R.createElement('input', {
        type: 'checkbox',
        checked: !!checked,
        onChange: () => onCheckedChange?.(!checked)
      })
  };
});
jest.mock('../components/NumberFormat', () => ({
  __esModule: true,
  default: ({ value }) => `${Number(value).toFixed(2)}`
}));
jest.mock('next-translate/useTranslation', () => ({
  __esModule: true,
  default: () => ({
    t: (key, values = {}) =>
      key.replace(/\{\{(\w+)\}\}/g, (m, name) => values[name] ?? m)
  })
}));
jest.mock('sonner', () => ({
  toast: {
    success: (...a) => mockToast.success(...a),
    warning: (...a) => mockToast.warning(...a),
    error: (...a) => mockToast.error(...a)
  }
}));
jest.mock('../utils/fetch', () => ({
  apiFetcher: () => ({ post: (...a) => mockPost(...a) })
}));

const TERM = 2026110100;
const rents = [
  {
    _id: 'tenant-1',
    term: TERM,
    occupant: { name: 'ΔΟΚΙΜΗ ΑΛΦΑ' },
    totalWithoutBalanceAmount: 400,
    balance: 0,
    payment: 0
  },
  {
    _id: 'tenant-2',
    term: TERM,
    occupant: { name: 'ΔΟΚΙΜΗ ΒΗΤΑ' },
    totalWithoutBalanceAmount: 350,
    balance: 0,
    payment: 0
  }
];
const served = {
  data: {
    results: [
      { tenantId: 'tenant-1', term: TERM, amount: 400 },
      { tenantId: 'tenant-2', term: TERM, amount: 350 }
    ]
  }
};

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
// Promise callbacks only: the timer that tells React about a state change has not run
const microtasks = async () => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};
// Long enough for TanStack's notify timer and the re-render that follows it
const screenReacts = () =>
  act(async () => {
    for (let i = 0; i < 4; i += 1) await nextTask();
  });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('«Εκτέλεση» of the express settlement drawer', () => {
  let container;
  let root;
  let queryClient;

  const mount = async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ExpressPaymentDialog open setOpen={jest.fn()} rents={rents} />
        </QueryClientProvider>
      );
    });
  };
  const submit = () =>
    [...container.querySelectorAll('button')].find((b) =>
      /^(Record|Saving)$/.test(b.textContent)
    );
  const tick = (name) =>
    act(async () => {
      [...container.querySelectorAll('span')]
        .find((s) => s.textContent === name)
        .closest('label')
        .querySelector('input')
        .click();
    });
  const tickBoth = async () => {
    await tick('ΔΟΚΙΜΗ ΑΛΦΑ');
    await tick('ΔΟΚΙΜΗ ΒΗΤΑ');
  };

  beforeEach(() => {
    mockPost.mockReset();
    Object.values(mockToast).forEach((f) => f.mockReset());
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.removeChild(container);
    queryClient.clear();
  });
  afterAll(() => dom.window.close());

  it('two presses before the screen has reacted send one batch', async () => {
    mockPost.mockResolvedValue(served);
    await mount();
    await tickBoth();
    expect(submit().disabled).toBe(false);

    await act(async () => {
      const button = submit();
      button.click();
      button.click();
    });
    await screenReacts();

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe('/rents/express');
    expect(mockPost.mock.calls[0][1].items).toHaveLength(2);
    expect(mockToast.warning).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('a press while the batch is still being sent is ignored', async () => {
    const sending = deferred();
    mockPost.mockReturnValue(sending.promise);
    await mount();
    await tickBoth();

    await act(async () => submit().click());
    // the next press right after, and another once the screen shows «Saving»
    await act(async () => submit().click());
    await screenReacts();
    expect(submit().textContent).toBe('Saving');
    expect(submit().disabled).toBe(true);
    await act(async () => submit().click());

    expect(mockPost).toHaveBeenCalledTimes(1);
    await act(async () => {
      sending.resolve(served);
      await nextTask();
    });
  });

  it('a press while the rents are being read again after the batch is ignored', async () => {
    // the success path waits for the rents before it closes the drawer
    const reading = deferred();
    let read = () => Promise.resolve([]);
    await queryClient.prefetchQuery({
      queryKey: [QueryKeys.RENTS],
      queryFn: () => read()
    });
    read = () => reading.promise;
    mockPost.mockResolvedValue(served);
    await mount();
    await tickBoth();

    await act(async () => {
      submit().click();
      await microtasks();
      // the batch has been answered and its success handler is waiting for the rents;
      // the screen has not been told yet, so the button is still enabled
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockToast.success).not.toHaveBeenCalled();
      expect(submit().disabled).toBe(false);
      submit().click();
      await microtasks();
    });
    expect(mockPost).toHaveBeenCalledTimes(1);

    await act(async () => {
      reading.resolve([]);
      await nextTask();
    });
    expect(mockToast.success).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('after the batch has finished the next press is served', async () => {
    mockPost.mockResolvedValue(served);
    await mount();
    await tickBoth();
    await act(async () => submit().click());
    await screenReacts();
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockToast.success).toHaveBeenCalledTimes(1);

    await tickBoth();
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    await screenReacts();

    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('after a batch that failed the next press is served', async () => {
    mockPost.mockRejectedValueOnce(new Error('network down'));
    mockPost.mockResolvedValue(served);
    await mount();
    await tickBoth();
    await act(async () => submit().click());
    await screenReacts();
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockToast.error).toHaveBeenCalledTimes(1);

    // the selection survives a failure: the same button, pressed again
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    await screenReacts();

    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
