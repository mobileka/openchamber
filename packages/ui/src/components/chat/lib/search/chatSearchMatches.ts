/**
 * Turns searchable messages into the ordered match list the find bar steps
 * through. Counts and stepping come from here, never from the mounted DOM, so
 * a virtualized row cannot change how many matches a query has.
 *
 * `buildChatSearchMatches` is the full pipeline and the correctness oracle.
 * `buildChatSearchMatchesIncremental` maintains the same list across rebuilds:
 * a message whose chunk array is reference-identical to the cached one keeps
 * its match objects, so a streaming delta costs one message's scan plus the
 * flat reassembly, not a rescan of every chunk in the conversation.
 */

import { findTextMatches } from '@/lib/search/textMatches';

import type { ChatFindMatch, ChatFindSearchableChunk, ChatFindSearchableMessage } from './types';

export type ChatFindMatchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
};

const appendMessageMatches = (
  target: ChatFindMatch[],
  message: ChatFindSearchableMessage,
  query: string,
  options: ChatFindMatchOptions,
): void => {
  for (const chunk of message.chunks) {
    const ranges = findTextMatches(chunk.text, query, options);
    for (let occurrence = 0; occurrence < ranges.length; occurrence += 1) {
      const range = ranges[occurrence];
      if (!range) {
        continue;
      }
      target.push({
        key: `${message.messageId}:${chunk.index}:${occurrence}`,
        messageId: message.messageId,
        partId: chunk.partId,
        occurrence,
        start: range.start,
        end: range.end,
      });
    }
  }
};

export const buildChatSearchMatches = (
  messages: ChatFindSearchableMessage[],
  query: string,
  options: ChatFindMatchOptions,
): ChatFindMatch[] => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const matches: ChatFindMatch[] = [];
  for (const message of messages) {
    appendMessageMatches(matches, message, trimmed, options);
  }
  return matches;
};

/**
 * Per-column state the incremental builder keeps between sync events.
 * `byMessageId` reuses one message's match objects while its chunk array is
 * reference-identical; `order` and `output` detect that nothing moved so the
 * previous flat list can be returned as is.
 */
export type ChatFindMatchesCache = {
  /** `trimmed|caseSensitive|wholeWord`; any change rebuilds every entry. */
  signature: string;
  byMessageId: Map<string, { chunks: ChatFindSearchableChunk[]; matches: ChatFindMatch[] }>;
  /** Message ids in the order of the last assembled output. */
  order: string[];
  /** The last assembled list, returned while nothing moved. */
  output: ChatFindMatch[];
};

const NO_MATCHES: ChatFindMatch[] = [];

export const createChatFindMatchesCache = (): ChatFindMatchesCache => ({
  signature: '',
  byMessageId: new Map(),
  order: [],
  output: NO_MATCHES,
});

const matchesSignature = (query: string, options: ChatFindMatchOptions): string =>
  `${query}|${options.caseSensitive ? '1' : '0'}|${options.wholeWord ? '1' : '0'}`;

/**
 * Incremental entry point for `buildChatSearchMatches`. A query or option
 * change clears everything; otherwise each message recomputes only when its
 * chunk array identity changed, ids that left the list are pruned, and the
 * flat list is assembled from the cached per-message arrays. Message ids must
 * be unique, which `buildSearchableMessages` guarantees.
 */
export const buildChatSearchMatchesIncremental = (
  cache: ChatFindMatchesCache,
  messages: ChatFindSearchableMessage[],
  query: string,
  options: ChatFindMatchOptions,
): ChatFindMatch[] => {
  const trimmed = query.trim();
  const signature = matchesSignature(trimmed, options);
  if (cache.signature !== signature) {
    cache.signature = signature;
    cache.byMessageId.clear();
    cache.order = [];
    cache.output = NO_MATCHES;
  }
  if (trimmed.length === 0) {
    return NO_MATCHES;
  }

  let changed = false;
  let sameOrder = cache.order.length === messages.length;
  let index = 0;
  for (const message of messages) {
    const cached = cache.byMessageId.get(message.messageId);
    if (!cached || cached.chunks !== message.chunks) {
      const matches: ChatFindMatch[] = [];
      appendMessageMatches(matches, message, trimmed, options);
      cache.byMessageId.set(message.messageId, { chunks: message.chunks, matches });
      changed = true;
    }
    if (sameOrder && cache.order[index] !== message.messageId) {
      sameOrder = false;
    }
    index += 1;
  }

  if (!changed && sameOrder) {
    return cache.output;
  }

  const liveIds = new Set<string>();
  for (const message of messages) {
    liveIds.add(message.messageId);
  }
  for (const messageId of cache.byMessageId.keys()) {
    if (!liveIds.has(messageId)) {
      cache.byMessageId.delete(messageId);
    }
  }

  const output: ChatFindMatch[] = [];
  const order: string[] = [];
  for (const message of messages) {
    order.push(message.messageId);
    const cached = cache.byMessageId.get(message.messageId);
    if (cached) {
      for (const match of cached.matches) {
        output.push(match);
      }
    }
  }
  cache.order = order;
  cache.output = output;
  return output;
};

/**
 * The first match at or after the viewport's active turn, so opening find in
 * the middle of a long chat does not jump the reader to the top. Falls back to
 * the first match when the viewport has no turn or every match is above it.
 */
export const selectNearestMatchIndex = (
  matches: ChatFindMatch[],
  messageToTurnIndex: ReadonlyMap<string, number>,
  activeTurnIndex: number,
): number => {
  if (matches.length === 0 || activeTurnIndex < 0) {
    return 0;
  }
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) {
      continue;
    }
    const turnIndex = messageToTurnIndex.get(match.messageId);
    if (turnIndex !== undefined && turnIndex >= activeTurnIndex) {
      return index;
    }
  }
  return 0;
};
