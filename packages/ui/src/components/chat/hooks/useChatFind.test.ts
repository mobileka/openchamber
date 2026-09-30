import { describe, expect, test } from 'bun:test';

import { deriveFindHistoryGate } from './useChatFind';

describe('deriveFindHistoryGate', () => {
  test('is open only when complete coverage is available while open', () => {
    expect(deriveFindHistoryGate(true, true, null)).toEqual({
      isHistoryLoading: false,
      hasHistoryError: false,
    });
  });

  test('blocks and reports loading while coverage is incomplete', () => {
    expect(deriveFindHistoryGate(true, false, null)).toEqual({
      isHistoryLoading: true,
      hasHistoryError: false,
    });
  });

  test('blocks with the error instead of the loading note after a failure', () => {
    expect(deriveFindHistoryGate(true, false, 'history-load-failed')).toEqual({
      isHistoryLoading: false,
      hasHistoryError: true,
    });
  });

  test('reports neither while the bar is closed', () => {
    expect(deriveFindHistoryGate(false, false, null)).toEqual({
      isHistoryLoading: false,
      hasHistoryError: false,
    });
  });

  test('treats a missing run error like no error', () => {
    expect(deriveFindHistoryGate(true, false, undefined)).toEqual({
      isHistoryLoading: true,
      hasHistoryError: false,
    });
  });
});
