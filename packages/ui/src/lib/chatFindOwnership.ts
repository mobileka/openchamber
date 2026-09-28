/**
 * Which chat column owns the `find_in_chat` shortcut and Escape.
 *
 * Several chat columns can be mounted at once (main chat, VS Code chat views,
 * the agent manager, mini chat). The shortcut registry dispatches one handler
 * per action, so the handler is registered once and resolves the owning column
 * here: the focused scope first, then the last column the user interacted with,
 * then the first active column.
 */

export type ChatFindOwner = {
  id: string;
  element: HTMLElement;
  isActive: () => boolean;
  isOpen: () => boolean;
  /** Open the bar, or re-focus its query when it is already open. */
  open: () => void;
  closeActive: () => void;
};

const owners = new Map<string, ChatFindOwner>();
let lastActiveOwnerId: string | null = null;

export const registerChatFindOwner = (owner: ChatFindOwner): (() => void) => {
  owners.set(owner.id, owner);
  if (!lastActiveOwnerId) {
    lastActiveOwnerId = owner.id;
  }

  const activate = (): void => {
    lastActiveOwnerId = owner.id;
  };
  owner.element.addEventListener('focusin', activate);
  owner.element.addEventListener('pointerdown', activate, true);

  return () => {
    owner.element.removeEventListener('focusin', activate);
    owner.element.removeEventListener('pointerdown', activate, true);
    owners.delete(owner.id);
    if (lastActiveOwnerId === owner.id) {
      lastActiveOwnerId = null;
    }
  };
};

const activeOwners = (): ChatFindOwner[] => [...owners.values()].filter((owner) => owner.isActive());

export const resolveChatFindOwner = (): ChatFindOwner | null => {
  const scope = globalThis.document?.activeElement?.closest('[data-chat-find-scope]');
  if (scope instanceof HTMLElement) {
    for (const owner of owners.values()) {
      if (owner.element === scope) {
        return owner.isActive() ? owner : null;
      }
    }
  }

  const remembered = lastActiveOwnerId ? owners.get(lastActiveOwnerId) : undefined;
  if (remembered?.isActive()) {
    return remembered;
  }
  return activeOwners()[0] ?? null;
};

export const closeAnyChatFind = (): boolean => {
  const openOwner = activeOwners().find((owner) => owner.isOpen());
  if (!openOwner) {
    return false;
  }
  openOwner.closeActive();
  return true;
};
