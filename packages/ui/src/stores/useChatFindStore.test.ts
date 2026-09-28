import { beforeEach, describe, expect, test } from 'bun:test';

import { DEFAULT_CHAT_FIND_SETTINGS, getChatFindSessionKey, useChatFindStore } from './useChatFindStore';

const runtimeKey = 'runtime-1';
const directory = '/repo';
const sessionId = 'ses_1';

const keyFor = (dir: string, id: string): string => {
  const key = getChatFindSessionKey(runtimeKey, dir, id);
  if (!key) throw new Error('expected a valid session key');
  return key;
};

const open = (dir: string, id: string) => useChatFindStore.getState().openSession(runtimeKey, dir, id);
const entryFor = (dir: string, id: string) => useChatFindStore.getState().entries[keyFor(dir, id)];

describe('useChatFindStore', () => {
  beforeEach(() => {
    useChatFindStore.setState({ entries: {} });
  });

  test('opens a session with defaults and an empty run', () => {
    const entry = open(directory, sessionId);
    expect(entry.settings).toEqual(DEFAULT_CHAT_FIND_SETTINGS);
    expect(entry.run).toEqual({ query: '', currentKey: null, currentIndex: 0, historyError: null });
  });

  test('keeps session settings across close and reopen while the run resets', () => {
    const key = keyFor(directory, sessionId);
    open(directory, sessionId);
    useChatFindStore.getState().updateSettings(key, { includeTools: true, wholeWord: true });
    useChatFindStore.getState().updateRun(key, { query: 'cat', currentKey: 'm1:0:text:0', currentIndex: 2 });

    useChatFindStore.getState().closeSession(key);
    expect(entryFor(directory, sessionId)?.run).toBeNull();
    expect(entryFor(directory, sessionId)?.settings).toMatchObject({ includeTools: true, wholeWord: true });

    const reopened = open(directory, sessionId);
    expect(reopened.run).toEqual({ query: '', currentKey: null, currentIndex: 0, historyError: null });
    expect(reopened.settings).toMatchObject({ includeTools: true, wholeWord: true });
  });

  test('reopening an already open session preserves its run', () => {
    const key = keyFor(directory, sessionId);
    open(directory, sessionId);
    useChatFindStore.getState().updateRun(key, { query: 'cat', currentIndex: 1 });
    const reopened = open(directory, sessionId);
    expect(reopened.run?.query).toBe('cat');
    expect(reopened.run?.currentIndex).toBe(1);
  });

  test('settings never leak between sessions', () => {
    const first = keyFor('/repo-a', 'ses_1');
    const second = keyFor('/repo-b', 'ses_1');
    open('/repo-a', 'ses_1');
    open('/repo-b', 'ses_1');
    useChatFindStore.getState().updateSettings(first, { includeReasoning: true });
    expect(useChatFindStore.getState().entries[first]?.settings.includeReasoning).toBe(true);
    expect(useChatFindStore.getState().entries[second]?.settings.includeReasoning).toBe(false);
  });

  test('updateRun and updateSettings ignore unknown sessions', () => {
    const key = keyFor(directory, sessionId);
    useChatFindStore.getState().updateRun(key, { query: 'cat' });
    useChatFindStore.getState().updateSettings(key, { includeTools: true });
    expect(useChatFindStore.getState().entries[key]).toBeUndefined();
  });

  test('clears only the composite session identity', () => {
    open('/repo-a', 'ses_1');
    open('/repo-b', 'ses_1');
    open('/repo-a', 'ses_2');

    useChatFindStore.getState().clearSession(runtimeKey, '/repo-a', 'ses_1');

    expect(entryFor('/repo-a', 'ses_1')).toBeUndefined();
    expect(entryFor('/repo-b', 'ses_1')).toBeDefined();
    expect(entryFor('/repo-a', 'ses_2')).toBeDefined();
  });

  test('rejects a stale runtime identity', () => {
    open('/repo', 'ses_1');
    useChatFindStore.getState().clearSession(`${runtimeKey}-stale`, '/repo', 'ses_1');
    expect(entryFor('/repo', 'ses_1')).toBeDefined();
  });

  test('clears a directory and its worktrees, not siblings', () => {
    open('/projects/app', 'ses_1');
    open('/projects/app/worktrees/feat', 'ses_2');
    open('/projects/app-other', 'ses_3');

    useChatFindStore.getState().clearDirectory(runtimeKey, '/projects/app');

    expect(entryFor('/projects/app', 'ses_1')).toBeUndefined();
    expect(entryFor('/projects/app/worktrees/feat', 'ses_2')).toBeUndefined();
    expect(entryFor('/projects/app-other', 'ses_3')).toBeDefined();
  });
});
