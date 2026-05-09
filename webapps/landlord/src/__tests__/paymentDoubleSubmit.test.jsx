import React from 'react';
import { JSDOM } from 'jsdom';
import ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';

// Setup minimal DOM for React
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost'
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;

// Test the double-submit prevention pattern used in NewPaymentDialog.
describe('Payment double-submit prevention', () => {
  function PaymentDialogSimulation({ onSave }) {
    const [saving, setSaving] = React.useState(false);
    const submitCount = React.useRef(0);

    const handleSave = React.useCallback(() => {
      if (saving) return;
      setSaving(true);
      submitCount.current += 1;
      onSave(submitCount.current);
    }, [saving, onSave]);

    const handleError = React.useCallback(() => {
      setSaving(false);
    }, []);

    return React.createElement('div', null,
      React.createElement('button', {
        onClick: handleSave,
        disabled: saving,
        'data-testid': 'save-btn'
      }, saving ? 'Saving' : 'Save'),
      React.createElement('button', {
        onClick: handleError,
        'data-testid': 'error-btn'
      }, 'Simulate Error')
    );
  }

  let container;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    ReactDOM.unmountComponentAtNode(container);
    document.body.removeChild(container);
  });

  it('should prevent multiple submissions when saving is true', () => {
    const onSave = jest.fn();
    act(() => {
      ReactDOM.render(
        React.createElement(PaymentDialogSimulation, { onSave }),
        container
      );
    });

    const saveBtn = container.querySelector('[data-testid="save-btn"]');

    // First click
    act(() => { saveBtn.click(); });
    expect(onSave).toHaveBeenCalledTimes(1);

    // Second click — button is disabled
    act(() => { saveBtn.click(); });
    expect(onSave).toHaveBeenCalledTimes(1);

    // Third click — still blocked
    act(() => { saveBtn.click(); });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('should disable button visually during save', () => {
    const onSave = jest.fn();
    act(() => {
      ReactDOM.render(
        React.createElement(PaymentDialogSimulation, { onSave }),
        container
      );
    });

    const saveBtn = container.querySelector('[data-testid="save-btn"]');
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.textContent).toBe('Save');

    act(() => { saveBtn.click(); });
    expect(saveBtn.disabled).toBe(true);
    expect(saveBtn.textContent).toBe('Saving');
  });

  it('should re-enable button after error callback', () => {
    const onSave = jest.fn();
    act(() => {
      ReactDOM.render(
        React.createElement(PaymentDialogSimulation, { onSave }),
        container
      );
    });

    const saveBtn = container.querySelector('[data-testid="save-btn"]');
    const errorBtn = container.querySelector('[data-testid="error-btn"]');

    // Submit
    act(() => { saveBtn.click(); });
    expect(saveBtn.disabled).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);

    // Simulate API error — resets saving state
    act(() => { errorBtn.click(); });
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.textContent).toBe('Save');

    // Can submit again after error
    act(() => { saveBtn.click(); });
    expect(onSave).toHaveBeenCalledTimes(2);
  });
});
