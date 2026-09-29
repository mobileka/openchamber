/**
 * Per-column controller for in-chat find.
 *
 * Owns no derived state beyond the match list: the per-session settings and
 * run live in `useChatFindStore`, so a session switch with the bar open parks
 * its query and current match and restores them when the reader returns.
 *
 * Counts and stepping come from the data index; navigation asks the container
 * to scroll to the match's message and reveal its turn, and the highlight
 * layer paints the range once the row is mounted.
 */

import React from 'react';

import { getRuntimeKey } from '@/lib/runtime-switch';
import type { SessionMessageLoader } from '@/sync/session-message-loader';
import {
  DEFAULT_CHAT_FIND_SETTINGS,
  getChatFindSessionKey,
  useChatFindStore,
  type ChatFindRun,
  type ChatFindSettings,
} from '@/stores/useChatFindStore';

import { clearChatFindReveals } from '../lib/chatFindReveal';
import { buildChatSearchMatches, selectNearestMatchIndex } from '../lib/search/chatSearchMatches';
import { buildSearchableMessages } from '../lib/search/chatSearchText';
import type { ChatFindMatch } from '../lib/search/types';
import type { ChatMessageEntry } from '../lib/turns/types';

export type ChatFindController = {
  isOpen: boolean;
  query: string;
  settings: ChatFindSettings;
  matches: ChatFindMatch[];
  currentIndex: number;
  currentMatch: ChatFindMatch | null;
  isSearchingHistory: boolean;
  hasHistoryError: boolean;
  open: () => void;
  close: () => void;
  setQuery: (value: string) => void;
  toggleSetting: (key: keyof ChatFindSettings) => void;
  goNext: () => void;
  goPrevious: () => void;
  retryHistory: () => void;
};

export type UseChatFindOptions = {
  sessionId: string | null;
  directory: string | undefined;
  messages: ChatMessageEntry[];
  messageToTurnIndex: ReadonlyMap<string, number>;
  activeTurnIndex: number;
  historyComplete: boolean;
  messageLoader: SessionMessageLoader;
  revealMatch: (match: ChatFindMatch) => void;
};

const EMPTY_MATCHES: ChatFindMatch[] = [];

const patchForSetting = (key: keyof ChatFindSettings, value: boolean): Partial<ChatFindSettings> => {
  const patch: Partial<ChatFindSettings> = {};
  patch[key] = value;
  return patch;
};

export const useChatFind = (options: UseChatFindOptions): ChatFindController => {
  const sessionKey = options.sessionId && options.directory
    ? getChatFindSessionKey(getRuntimeKey(), options.directory, options.sessionId)
    : null;

  const entry = useChatFindStore((state) => (sessionKey ? state.entries[sessionKey] : undefined));
  const settings = entry?.settings ?? DEFAULT_CHAT_FIND_SETTINGS;
  const run = entry?.run ?? null;
  const isOpen = run !== null;

  // Extraction is skipped entirely while the bar is closed so a hidden find
  // surface performs no ongoing work on streaming updates.
  const searchableMessages = React.useMemo(
    () => (isOpen ? buildSearchableMessages(options.messages) : []),
    [isOpen, options.messages],
  );

  const query = run?.query ?? '';
  const matches = React.useMemo(
    () => (isOpen
      ? buildChatSearchMatches(searchableMessages, query, {
          caseSensitive: settings.caseSensitive,
          wholeWord: settings.wholeWord,
        })
      : EMPTY_MATCHES),
    [isOpen, query, searchableMessages, settings.caseSensitive, settings.wholeWord],
  );

  const matchesRef = React.useRef(matches);
  matchesRef.current = matches;
  const runRef = React.useRef(run);
  runRef.current = run;
  const turnIndexRef = React.useRef(options.messageToTurnIndex);
  turnIndexRef.current = options.messageToTurnIndex;
  const activeTurnIndexRef = React.useRef(options.activeTurnIndex);
  activeTurnIndexRef.current = options.activeTurnIndex;
  const revealRef = React.useRef(options.revealMatch);
  revealRef.current = options.revealMatch;

  const [selectionNonce, setSelectionNonce] = React.useState(0);
  const [historyRetryNonce, setHistoryRetryNonce] = React.useState(0);
  const historySentForRef = React.useRef<string | null>(null);

  const updateRun = React.useCallback((patch: Partial<ChatFindRun>) => {
    if (sessionKey) {
      useChatFindStore.getState().updateRun(sessionKey, patch);
    }
  }, [sessionKey]);

  const updateSettings = React.useCallback((patch: Partial<ChatFindSettings>) => {
    if (sessionKey) {
      useChatFindStore.getState().updateSettings(sessionKey, patch);
    }
  }, [sessionKey]);

  const open = React.useCallback(() => {
    if (!options.sessionId || !options.directory) {
      return;
    }
    useChatFindStore.getState().openSession(getRuntimeKey(), options.directory, options.sessionId);
  }, [options.directory, options.sessionId]);

  const close = React.useCallback(() => {
    if (!sessionKey) {
      return;
    }
    clearChatFindReveals();
    useChatFindStore.getState().closeSession(sessionKey);
  }, [sessionKey]);

  const restartSelection = React.useCallback(() => {
    setSelectionNonce((nonce) => nonce + 1);
  }, []);

  const setQuery = React.useCallback((value: string) => {
    updateRun({ query: value, historyError: null });
    restartSelection();
  }, [restartSelection, updateRun]);

  const toggleSetting = React.useCallback((key: keyof ChatFindSettings) => {
    updateSettings(patchForSetting(key, !settings[key]));
    restartSelection();
  }, [restartSelection, settings, updateSettings]);

  // Keep the current match while streaming re-indexes the list, clamping to a
  // valid neighbor only when the match itself disappeared.
  React.useEffect(() => {
    if (!isOpen) {
      return;
    }
    const current = runRef.current;
    if (!current) {
      return;
    }
    if (matches.length === 0) {
      // An empty list is a load state, not a result: switching back to a
      // session empties its messages for a beat, and the parked selection must
      // survive that instead of resetting to the first match.
      return;
    }
    if (current.currentKey) {
      const found = matches.findIndex((candidate) => candidate.key === current.currentKey);
      if (found >= 0) {
        if (found !== current.currentIndex) {
          updateRun({ currentIndex: found });
        }
        return;
      }
    }
    const clamped = Math.min(Math.max(current.currentIndex, 0), matches.length - 1);
    const match = matches[clamped];
    if (match) {
      updateRun({ currentKey: match.key, currentIndex: clamped });
    }
  }, [isOpen, matches, updateRun]);

  // A new query or changed toggles select the nearest match from the viewport
  // instead of yanking the reader back to the top of a long conversation.
  // `selectionNonce` is the trigger: dependency identity changes (a session
  // switch rebuilds `updateRun`) must not re-select, or a parked match would
  // be replaced by the first match when the reader comes back.
  const handledSelectionRef = React.useRef(0);
  React.useEffect(() => {
    if (!isOpen || selectionNonce === 0 || selectionNonce === handledSelectionRef.current) {
      return;
    }
    handledSelectionRef.current = selectionNonce;
    const current = runRef.current;
    if (!current) {
      return;
    }
    if (!current.query.trim()) {
      updateRun({ currentKey: null, currentIndex: 0 });
      return;
    }
    const list = matchesRef.current;
    const index = selectNearestMatchIndex(list, turnIndexRef.current, activeTurnIndexRef.current);
    const match = list[index];
    updateRun({ currentKey: match?.key ?? null, currentIndex: match ? index : 0 });
  }, [isOpen, selectionNonce, updateRun]);

  // Reveal each newly selected match exactly once, and put the reader back on
  // the current match when they return to a session whose search is still
  // parked. A session switch parks the run; the restored match is focused
  // again, not left wherever the timeline's own restore lands.
  const revealedRef = React.useRef<{ sessionKey: string | null; key: string | null }>({
    sessionKey: null,
    key: null,
  });
  React.useEffect(() => {
    if (!isOpen) {
      revealedRef.current = { sessionKey, key: null };
      return;
    }
    const key = run?.currentKey ?? null;
    if (revealedRef.current.sessionKey !== sessionKey) {
      revealedRef.current = { sessionKey, key };
      const restored = key
        ? matchesRef.current.find((candidate) => candidate.key === key)
        : undefined;
      if (restored) {
        revealRef.current(restored);
      }
      return;
    }
    if (!key || key === revealedRef.current.key) {
      return;
    }
    revealedRef.current = { sessionKey, key };
    const match = matchesRef.current.find((candidate) => candidate.key === key);
    if (match) {
      revealRef.current(match);
    }
  }, [isOpen, run?.currentKey, sessionKey]);

  // Find always covers the whole conversation: opening the bar loads complete
  // coverage once per session and retry.
  React.useEffect(() => {
    if (!isOpen || options.historyComplete) {
      return;
    }
    if (!options.sessionId || !options.directory) {
      return;
    }
    const requestKey = `${options.sessionId}|${historyRetryNonce}`;
    if (historySentForRef.current === requestKey) {
      return;
    }
    historySentForRef.current = requestKey;
    let cancelled = false;
    updateRun({ historyError: null });
    void options.messageLoader
      .loadComplete({ directory: options.directory, sessionID: options.sessionId })
      .catch(() => {
        if (cancelled) {
          return;
        }
        updateRun({ historyError: 'history-load-failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [
    historyRetryNonce,
    isOpen,
    options.directory,
    options.historyComplete,
    options.messageLoader,
    options.sessionId,
    updateRun,
  ]);

  const retryHistory = React.useCallback(() => {
    updateRun({ historyError: null });
    setHistoryRetryNonce((nonce) => nonce + 1);
  }, [updateRun]);

  const resolveCurrentIndex = (): number => {
    if (!isOpen || matches.length === 0) {
      return -1;
    }
    if (run?.currentKey) {
      const found = matches.findIndex((candidate) => candidate.key === run.currentKey);
      if (found >= 0) {
        return found;
      }
    }
    return Math.min(Math.max(run?.currentIndex ?? 0, 0), matches.length - 1);
  };

  const goTo = React.useCallback((delta: 1 | -1) => {
    const list = matchesRef.current;
    if (!isOpen || list.length === 0) {
      return;
    }
    const current = runRef.current;
    let base = -1;
    if (current?.currentKey) {
      base = list.findIndex((candidate) => candidate.key === current.currentKey);
    }
    if (base < 0) {
      base = Math.min(Math.max(current?.currentIndex ?? 0, 0), list.length - 1);
      if (delta === -1 && !current?.currentKey) {
        base = 0;
      }
    }
    const next = (base + delta + list.length) % list.length;
    const match = list[next];
    if (match) {
      updateRun({ currentKey: match.key, currentIndex: next });
    }
  }, [isOpen, updateRun]);

  const goNext = React.useCallback(() => goTo(1), [goTo]);
  const goPrevious = React.useCallback(() => goTo(-1), [goTo]);

  const currentIndex = resolveCurrentIndex();
  const currentMatch = currentIndex >= 0 ? matches[currentIndex] ?? null : null;

  return {
    isOpen,
    query,
    settings,
    matches,
    currentIndex,
    currentMatch,
    isSearchingHistory: isOpen
      && !options.historyComplete
      && run?.historyError === null,
    hasHistoryError: run?.historyError !== null && run?.historyError !== undefined,
    open,
    close,
    setQuery,
    toggleSetting,
    goNext,
    goPrevious,
    retryHistory,
  };
};
