import { describe, expect, it, vi } from 'vitest';

import {
  createRestartNotifier,
  pickMostRecentSession,
  RESTART_NOTIFY_PROMPT,
} from './restart-notify.js';

describe('pickMostRecentSession', () => {
  it('picks the session with the newest update time', () => {
    const picked = pickMostRecentSession([
      { id: 'old', directory: '/work/a', time: { updated: 100 } },
      { id: 'new', directory: '/work/b', time: { updated: 300 } },
      { id: 'middle', directory: '/work/c', time: { updated: 200 } },
    ]);
    expect(picked).toEqual({ id: 'new', directory: '/work/b', updated: 300 });
  });

  it('ignores archived, malformed and directory-less sessions', () => {
    expect(pickMostRecentSession([
      { id: 'archived', directory: '/work/a', time: { updated: 900, archived: 950 } },
      { id: 'no-time', directory: '/work/b' },
      { id: 'no-directory', time: { updated: 800 } },
      null,
      { id: 'valid', directory: '/work/c', time: { updated: 100 } },
    ])).toEqual({ id: 'valid', directory: '/work/c', updated: 100 });
  });

  it('returns null when nothing usable is listed', () => {
    expect(pickMostRecentSession([])).toBeNull();
    expect(pickMostRecentSession(undefined)).toBeNull();
  });
});

describe('createRestartNotifier', () => {
  const listSessions = async () => [
    { id: 'recent', directory: '/work/app', time: { updated: 20 } },
    { id: 'older', directory: '/work/app', time: { updated: 10 } },
  ];

  it('waits for OpenCode and sends the notice to the most recent session', async () => {
    const waitForOpenCodeReady = vi.fn(async () => true);
    const send = vi.fn(async () => ({ sessionId: 'recent' }));

    const notify = createRestartNotifier({ sessionService: { send }, listSessions, waitForOpenCodeReady });
    await expect(notify()).resolves.toEqual({ sent: true, sessionId: 'recent', directory: '/work/app' });

    expect(waitForOpenCodeReady).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('recent', {
      directory: '/work/app',
      prompt: RESTART_NOTIFY_PROMPT,
    });
  });

  it('does not send when OpenCode never becomes ready', async () => {
    const send = vi.fn();
    const notify = createRestartNotifier({
      sessionService: { send },
      listSessions,
      waitForOpenCodeReady: vi.fn(async () => {
        throw new Error('OpenCode port is not available');
      }),
    });

    await expect(notify()).resolves.toEqual({ sent: false, reason: 'opencode-not-ready' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send when no session is available', async () => {
    const send = vi.fn();
    const notify = createRestartNotifier({
      sessionService: { send },
      listSessions: async () => [],
      waitForOpenCodeReady: vi.fn(async () => true),
    });

    await expect(notify()).resolves.toEqual({ sent: false, reason: 'no-session' });
    expect(send).not.toHaveBeenCalled();
  });
});
