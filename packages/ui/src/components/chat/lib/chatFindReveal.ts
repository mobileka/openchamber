/**
 * Expansion requests raised by find navigation.
 *
 * A match can live inside collapsed content (a tool card, a reasoning block,
 * the turn's activity disclosure). The highlight layer cannot paint what is
 * not mounted, so navigating asks the owning components to expand first:
 * `ChatMessage` consumes part reveals for its message, `MessageList` consumes
 * turn reveals for its activity disclosure.
 *
 * Requests survive until a consumer takes them, so a request raised before the
 * virtualized row mounts still applies when it does. Part reveals notify only
 * the message they name, keeping every other mounted row out of the update.
 */

import type { ChatFindMatchKind } from './search/types';

export type ChatFindPartReveal = {
  kind: Extract<ChatFindMatchKind, 'reasoning' | 'tool'>;
  partId: string;
};

type Listener = () => void;

const partRevealsByMessage = new Map<string, Map<string, ChatFindPartReveal>>();
const partListenersByMessage = new Map<string, Set<Listener>>();
const partVersionByMessage = new Map<string, number>();
const pendingTurnReveals = new Set<string>();
const turnListeners = new Set<Listener>();
let turnVersion = 0;

const notifyMessage = (messageId: string): void => {
  const listeners = partListenersByMessage.get(messageId);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener();
  }
};

const notifyTurns = (): void => {
  turnVersion += 1;
  for (const listener of turnListeners) {
    listener();
  }
};

export const requestChatFindPartReveal = (messageId: string, reveal: ChatFindPartReveal): void => {
  const key = `${reveal.kind}:${reveal.partId}`;
  const byKey = partRevealsByMessage.get(messageId) ?? new Map<string, ChatFindPartReveal>();
  if (byKey.has(key)) {
    return;
  }
  byKey.set(key, reveal);
  partRevealsByMessage.set(messageId, byKey);
  partVersionByMessage.set(messageId, (partVersionByMessage.get(messageId) ?? 0) + 1);
  notifyMessage(messageId);
};

export const subscribeChatFindPartReveals = (messageId: string, listener: Listener): (() => void) => {
  const listeners = partListenersByMessage.get(messageId) ?? new Set<Listener>();
  listeners.add(listener);
  partListenersByMessage.set(messageId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      partListenersByMessage.delete(messageId);
    }
  };
};

export const getChatFindPartRevealVersion = (messageId: string): number =>
  partVersionByMessage.get(messageId) ?? 0;

export const takeChatFindPartReveals = (messageId: string): ChatFindPartReveal[] => {
  const byKey = partRevealsByMessage.get(messageId);
  if (!byKey) {
    return [];
  }
  partRevealsByMessage.delete(messageId);
  return [...byKey.values()];
};

export const requestChatFindTurnReveal = (turnId: string): void => {
  if (pendingTurnReveals.has(turnId)) {
    return;
  }
  pendingTurnReveals.add(turnId);
  notifyTurns();
};

export const subscribeChatFindTurnReveals = (listener: Listener): (() => void) => {
  turnListeners.add(listener);
  return () => {
    turnListeners.delete(listener);
  };
};

export const getChatFindTurnRevealVersion = (): number => turnVersion;

export const takeChatFindTurnReveals = (): string[] => {
  if (pendingTurnReveals.size === 0) {
    return [];
  }
  const turnIds = [...pendingTurnReveals];
  pendingTurnReveals.clear();
  return turnIds;
};

export const clearChatFindReveals = (): void => {
  if (partRevealsByMessage.size === 0 && pendingTurnReveals.size === 0) {
    return;
  }
  partRevealsByMessage.clear();
  pendingTurnReveals.clear();
  for (const messageId of partVersionByMessage.keys()) {
    partVersionByMessage.set(messageId, (partVersionByMessage.get(messageId) ?? 0) + 1);
    notifyMessage(messageId);
  }
  notifyTurns();
};
