/**
 * Which chat column owns the `find_in_chat` shortcut and Escape.
 *
 * Several chat columns can be mounted at once (main chat, VS Code chat views,
 * the agent manager, mini chat). The shortcut registry dispatches one handler
 * per action, so the handler is registered once and resolves the owning column
 * here: the focused scope first, then the last column the user interacted with,
 * then the first active column. `openChatFindFromEvent` and `closeAnyChatFind`
 * are the entry points the shortcut layer calls.
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

const resolveChatFindOwner = (): ChatFindOwner | null => {
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
  return [...owners.values()].find((owner) => owner.isActive()) ?? null;
};

/**
 * The `find_in_chat` handler: opens the bar in the owner the event arrived in,
 * or reports that another surface keeps the keystroke (each has its own find).
 */
export const openChatFindFromEvent = (event: KeyboardEvent): boolean => {
  const owner = resolveChatFindOwner();
  if (!owner || !owner.isActive()) {
    return false;
  }
  const target = event.target;
  const insideScope = target instanceof Node && owner.element.contains(target);
  const neutralTarget = target === null || target === document.body || target === document.documentElement;
  if (!insideScope && !neutralTarget) {
    return false;
  }
  owner.open();
  return true;
};

export const closeAnyChatFind = (): boolean => {
  for (const owner of owners.values()) {
    if (owner.isActive() && owner.isOpen()) {
      owner.closeActive();
      return true;
    }
  }
  return false;
};
