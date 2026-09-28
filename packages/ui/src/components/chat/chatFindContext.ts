/**
 * The chat column's find API, consumed by the composer footer button.
 *
 * Kept in its own module so the composer does not import the search controller
 * (and with it the index and highlight stack) just to render one button.
 */

import React from 'react';

export type ChatFindApi = {
  isOpen: boolean;
  hasSession: boolean;
  /** Open the bar, or re-focus its query when it is already open. */
  open: () => void;
};

export const ChatFindContext = React.createContext<ChatFindApi | null>(null);

export const useChatFindApi = (): ChatFindApi | null => React.useContext(ChatFindContext);
