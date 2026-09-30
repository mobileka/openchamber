/**
 * Expansion requests raised by find navigation.
 *
 * A match can live inside collapsed content (the turn's activity disclosure).
 * The highlight layer cannot paint what is not mounted, so navigating asks
 * `MessageList` to expand the owning turn. Requests survive until a consumer
 * takes them, so a request raised before the virtualized row mounts still
 * applies when it does.
 */

type Listener = () => void;

const pendingTurnReveals = new Set<string>();
const turnListeners = new Set<Listener>();
let turnVersion = 0;

const notifyTurns = (): void => {
  turnVersion += 1;
  for (const listener of turnListeners) {
    listener();
  }
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
  if (pendingTurnReveals.size === 0) {
    return;
  }
  pendingTurnReveals.clear();
  notifyTurns();
};
