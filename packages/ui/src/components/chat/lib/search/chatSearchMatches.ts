/**
 * Turns searchable messages into the ordered match list the find bar steps
 * through. Counts and stepping come from here, never from the mounted DOM, so
 * a virtualized row cannot change how many matches a query has.
 */

import { findTextMatches } from '@/lib/search/textMatches';

import type { ChatFindMatch, ChatFindSearchableMessage } from './types';

export type ChatFindMatchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
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
    for (const chunk of message.chunks) {
      const ranges = findTextMatches(chunk.text, trimmed, options);
      for (let occurrence = 0; occurrence < ranges.length; occurrence += 1) {
        const range = ranges[occurrence];
        if (!range) {
          continue;
        }
        matches.push({
          key: `${message.messageId}:${chunk.index}:${occurrence}`,
          messageId: message.messageId,
          partId: chunk.partId,
          occurrence,
          start: range.start,
          end: range.end,
        });
      }
    }
  }
  return matches;
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
