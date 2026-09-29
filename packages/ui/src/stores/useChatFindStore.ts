/**
 * Per-session search settings for in-chat find.
 *
 * Settings stay with a session for the app session: reopening the bar keeps
 * its toggles and starting a new search does not reset them, while no session
 * ever shares them with another. The live run — query, current match,
 * whole-history state — belongs to the open bar and is cleared when it closes.
 *
 * Nothing here is persisted. Entries are removed when a session is deleted,
 * archived, or disappears with its project or worktree.
 */

import { create } from 'zustand';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';

export type ChatFindSettings = {
  caseSensitive: boolean;
  wholeWord: boolean;
};

export const DEFAULT_CHAT_FIND_SETTINGS: ChatFindSettings = {
  caseSensitive: false,
  wholeWord: false,
};

/** The live search run for one session; `null` means the bar is closed. */
export type ChatFindRun = {
  query: string;
  currentKey: string | null;
  currentIndex: number;
  historyError: string | null;
};

export type ChatFindSessionEntry = {
  runtimeKey: string;
  directory: string;
  sessionId: string;
  settings: ChatFindSettings;
  run: ChatFindRun | null;
  touchedAt: number;
};

type ChatFindStore = {
  entries: Record<string, ChatFindSessionEntry>;
  /** Creates the session's entry if missing; the bar is open when `run` exists. */
  openSession: (runtimeKey: string, directory: string, sessionId: string) => ChatFindSessionEntry;
  closeSession: (key: string) => void;
  updateSettings: (key: string, patch: Partial<ChatFindSettings>) => void;
  updateRun: (key: string, patch: Partial<ChatFindRun>) => void;
  clearSession: (runtimeKey: string, directory: string, sessionId: string) => void;
  clearDirectory: (runtimeKey: string, directory: string) => void;
};

/** Identity of one session's search settings: runtime + directory + session. */
export const getChatFindSessionKey = (
  runtimeKey: string,
  directory: string,
  sessionId: string,
): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionId) {
    return null;
  }
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionId]);
};

const touch = (entry: ChatFindSessionEntry): ChatFindSessionEntry => ({
  ...entry,
  touchedAt: Date.now(),
});

/** True when `directory` is `prefix` itself or lives inside it. */
const isDirectoryWithin = (directory: string, prefix: string): boolean =>
  directory === prefix || directory.startsWith(prefix === '/' ? '/' : `${prefix}/`);

export const useChatFindStore = create<ChatFindStore>((set, get) => ({
  entries: {},

  openSession: (runtimeKey, directory, sessionId) => {
    const key = getChatFindSessionKey(runtimeKey, directory, sessionId);
    if (!key) {
      throw new Error('chat find session identity is incomplete');
    }
    const normalizedDirectory = normalizePath(directory);
    if (!normalizedDirectory) {
      throw new Error('chat find session directory is invalid');
    }
    const existing = get().entries[key];
    if (existing) {
      const opened = existing.run
        ? touch(existing)
        : touch({ ...existing, run: { query: '', currentKey: null, currentIndex: 0, historyError: null } });
      set({ entries: { ...get().entries, [key]: opened } });
      return opened;
    }
    const created: ChatFindSessionEntry = {
      runtimeKey,
      directory: normalizedDirectory,
      sessionId,
      settings: { ...DEFAULT_CHAT_FIND_SETTINGS },
      run: { query: '', currentKey: null, currentIndex: 0, historyError: null },
      touchedAt: Date.now(),
    };
    set({ entries: { ...get().entries, [key]: created } });
    return created;
  },

  closeSession: (key) => {
    const existing = get().entries[key];
    if (!existing || existing.run === null) {
      return;
    }
    set({ entries: { ...get().entries, [key]: touch({ ...existing, run: null }) } });
  },

  updateSettings: (key, patch) => {
    const existing = get().entries[key];
    if (!existing) {
      return;
    }
    const settings = { ...existing.settings, ...patch };
    set({ entries: { ...get().entries, [key]: touch({ ...existing, settings }) } });
  },

  updateRun: (key, patch) => {
    const existing = get().entries[key];
    if (!existing || existing.run === null) {
      return;
    }
    const run = { ...existing.run, ...patch };
    set({ entries: { ...get().entries, [key]: touch({ ...existing, run }) } });
  },

  clearSession: (runtimeKey, directory, sessionId) => {
    const key = getChatFindSessionKey(runtimeKey, directory, sessionId);
    if (!key || !get().entries[key]) {
      return;
    }
    const entries = { ...get().entries };
    delete entries[key];
    set({ entries });
  },

  clearDirectory: (runtimeKey, directory) => {
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory) {
      return;
    }
    let changed = false;
    const entries: Record<string, ChatFindSessionEntry> = {};
    for (const [key, entry] of Object.entries(get().entries)) {
      if (entry.runtimeKey === runtimeKey && isDirectoryWithin(entry.directory, normalizedDirectory)) {
        changed = true;
        continue;
      }
      entries[key] = entry;
    }
    if (changed) {
      set({ entries });
    }
  },
}));

/** Clear a session's search state on deletion, archive, or discovery loss. */
export const clearChatFindSessionState = (
  runtimeKey: string,
  directory: string,
  sessionId: string,
): void => {
  useChatFindStore.getState().clearSession(runtimeKey, directory, sessionId);
};

/** Clear every session's search state under a removed project or worktree. */
export const clearChatFindDirectoryState = (directory: string): void => {
  useChatFindStore.getState().clearDirectory(getRuntimeKey(), directory);
};
