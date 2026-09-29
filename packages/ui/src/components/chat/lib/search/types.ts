/**
 * Data model for in-chat find.
 *
 * Matches are computed on message text (the timeline is virtualized, so the
 * rendered DOM is not a complete source); each match carries the message and
 * part identity the highlight layer uses to place it back in the DOM.
 */

export type ChatFindMatch = {
  /** Stable identity across re-indexing: message + chunk + occurrence. */
  key: string;
  messageId: string;
  partId?: string;
  /** Ordinal of this occurrence inside its chunk. */
  occurrence: number;
  start: number;
  end: number;
};

export type ChatFindSearchableChunk = {
  /** Ordinal inside its message; part of the match key. */
  index: number;
  partId?: string;
  text: string;
};

export type ChatFindSearchableMessage = {
  messageId: string;
  chunks: ChatFindSearchableChunk[];
};
