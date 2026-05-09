import React from 'react';
import { JSDOM } from 'jsdom';
import ReactDOM from 'react-dom';
import ErrorBoundary from '../components/ErrorBoundary';

// Setup minimal DOM for React
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost'
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;

function ThrowingChild({ shouldThrow }) {
  if (shouldThrow) {
    throw new Error('Test render error');
  }
  return React.createElement('div', null, 'Child content');
}

describe('ErrorBoundary', () => {
  let container;
  let originalConsoleError;

  beforeEach(() => {
    originalConsoleError = console.error;
    console.error = jest.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    console.error = originalConsoleError;
    ReactDOM.unmountComponentAtNode(container);
    document.body.removeChild(container);
  });

  it('should render children when no error occurs', () => {
    ReactDOM.render(
      React.createElement(ErrorBoundary, null,
        React.createElement(ThrowingChild, { shouldThrow: false })
      ),
      container
    );

    expect(container.textContent).toContain('Child content');
    expect(container.textContent).not.toContain('Something went wrong');
  });

  it('should display fallback UI when child throws during render', () => {
    ReactDOM.render(
      React.createElement(ErrorBoundary, null,
        React.createElement(ThrowingChild, { shouldThrow: true })
      ),
      container
    );

    expect(container.textContent).not.toContain('Child content');
    expect(container.textContent).toContain('Something went wrong');
    expect(container.textContent).toContain('unexpected error');
  });

  it('should show Reload Page and Go Home buttons in error state', () => {
    ReactDOM.render(
      React.createElement(ErrorBoundary, null,
        React.createElement(ThrowingChild, { shouldThrow: true })
      ),
      container
    );

    const buttons = container.querySelectorAll('button');
    const buttonTexts = Array.from(buttons).map((b) => b.textContent);
    expect(buttonTexts).toContain('Reload Page');
    expect(buttonTexts).toContain('Go Home');
  });

  it('should show error message in development mode', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    ReactDOM.render(
      React.createElement(ErrorBoundary, null,
        React.createElement(ThrowingChild, { shouldThrow: true })
      ),
      container
    );

    expect(container.textContent).toContain('Test render error');
    process.env.NODE_ENV = originalEnv;
  });

  it('should hide error message in production mode', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    ReactDOM.render(
      React.createElement(ErrorBoundary, null,
        React.createElement(ThrowingChild, { shouldThrow: true })
      ),
      container
    );

    expect(container.textContent).not.toContain('Test render error');
    expect(container.textContent).toContain('Something went wrong');
    process.env.NODE_ENV = originalEnv;
  });
});
