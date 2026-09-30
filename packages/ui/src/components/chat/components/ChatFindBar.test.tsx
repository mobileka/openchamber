import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider, useI18nStore } from '@/lib/i18n';

import { ChatFindBar } from './ChatFindBar';

type BarProps = React.ComponentProps<typeof ChatFindBar>;

const baseProps: BarProps = {
  open: true,
  query: '',
  settings: { caseSensitive: false, wholeWord: false },
  matchCount: 0,
  currentIndex: 0,
  isHistoryLoading: false,
  hasHistoryError: false,
  focusNonce: 0,
  onChangeQuery: () => undefined,
  onToggleSetting: () => undefined,
  onNext: () => undefined,
  onPrevious: () => undefined,
  onClose: () => undefined,
  onRetryHistory: () => undefined,
};

describe('ChatFindBar whole-history gate', () => {
  let root: Root;
  let container: HTMLDivElement;
  let restoreDom: () => void;

  const render = async (overrides: Partial<BarProps> = {}): Promise<void> => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatFindBar {...baseProps} {...overrides} />
        </I18nProvider>,
      );
    });
  };

  beforeEach(() => {
    const win = new Window({ url: 'http://localhost' });
    const globals = {
      window: win,
      document: win.document,
      navigator: win.navigator,
      localStorage: win.localStorage,
      Node: win.Node,
      NodeList: win.NodeList,
      Element: win.Element,
      HTMLElement: win.HTMLElement,
      SVGElement: win.SVGElement,
      getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map(
      (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    restoreDom = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useI18nStore.getState().setLocale('en');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreDom();
  });

  test('loading blocks the field, disables the controls, and focuses the bar root', async () => {
    await render({ isHistoryLoading: true });

    const bar = container.querySelector('[role="search"]');
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain('Loading the full history…');
    expect(container.querySelector('input')).toBeNull();
    // The active-match highlight region carries the current count only when
    // the field is usable.
    expect(container.textContent).not.toContain('1/');

    for (const toggle of container.querySelectorAll('button[aria-pressed]')) {
      expect(toggle.hasAttribute('disabled')).toBe(true);
    }
    expect(container.querySelector('button[aria-label="Previous match"]')?.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('button[aria-label="Next match"]')?.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('button[aria-label="Close search"]')?.hasAttribute('disabled')).toBe(false);
    // Focus on the root keeps Escape working without summoning a keyboard.
    expect(document.activeElement).toBe(bar);
  });

  test('complete coverage restores the input, its count, and focus', async () => {
    await render({ matchCount: 3 });

    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(container.textContent).toContain('1/3');
    for (const toggle of container.querySelectorAll('button[aria-pressed]')) {
      expect(toggle.hasAttribute('disabled')).toBe(false);
    }
    expect(document.activeElement).toBe(input);
  });

  test('coverage completing while open focuses the input once, while shortcut presses stay no-ops', async () => {
    await render({ isHistoryLoading: true, focusNonce: 1 });
    const bar = container.querySelector('[role="search"]');
    expect(document.activeElement).toBe(bar);

    // Cmd+F while blocked must not reach the unmounted input.
    await render({ isHistoryLoading: true, focusNonce: 2 });
    expect(document.activeElement).toBe(bar);

    await render({ isHistoryLoading: false, focusNonce: 2 });
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  test('failure keeps the field blocked and retries from the icon', async () => {
    let retries = 0;
    await render({ hasHistoryError: true, onRetryHistory: () => { retries += 1; } });

    expect(container.textContent).toContain("Couldn't search the whole history");
    expect(container.querySelector('input')).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="Retry"]');
    expect(retry).not.toBeNull();
    expect(retry?.querySelector('svg')).not.toBeNull();

    await act(async () => {
      retry?.click();
    });
    expect(retries).toBe(1);
  });
});
