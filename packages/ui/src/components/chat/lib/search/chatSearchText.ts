/**
 * Builds the searchable text of a session's messages.
 *
 * The index runs on the same display list the timeline renders: duplicates
 * collapse, malformed parts drop, and synthetic context messages fold back
 * onto their user message, so a context quote is searchable exactly where the
 * reader sees it. Only rendered text parts are indexed; reasoning blocks and
 * tool cards are not conversation text, and neither are roles other than
 * user/assistant (compaction, shell, subtask, plumbing).
 */

import { readContextPart, type ContextPartPayload } from '@/lib/messages/contextParts';

import { deriveMessageRole } from '../../message/messageRole';
import { attachSyntheticContext } from '../attachSyntheticContext';
import { getNormalizedMessageForDisplay } from '../messageDisplayNormalization';
import type { ChatMessageEntry } from '../turns/types';
import type { ChatFindSearchableChunk, ChatFindSearchableMessage } from './types';

const contextSearchText = (payload: ContextPartPayload): string => {
  switch (payload.kind) {
    case 'code-comment':
      return `${payload.code}\n${payload.text}`;
    case 'terminal':
      return payload.output;
    case 'browser-annotation':
      return `${payload.prompt}\n${payload.text}`;
    case 'pr-comment':
      return `${payload.body}\n${payload.text}`;
    case 'pr-check':
      return `${payload.output}\n${payload.text}`;
    case 'file-quote':
    case 'chat-quote':
      return `${payload.quote}\n${payload.text}`;
    case 'github-issue':
    case 'github-pr':
      return `#${payload.number} ${payload.title}`;
    case 'linear-issue':
      return `${payload.identifier} ${payload.title}`;
    case 'guest-issue':
    case 'guest-pr':
      return `${payload.id} ${payload.title}`;
  }
};

/**
 * The ordered text chunks one message contributes to the find index.
 * `index` is assigned only to chunks that carry text, so identities stay
 * stable for a given message.
 *
 * Cached by the message entry's identity: the sync layer keeps unchanged
 * message objects stable, so an open bar re-indexing during streaming only
 * re-extracts the message that actually changed.
 */
const chunkCache = new WeakMap<ChatMessageEntry, ChatFindSearchableChunk[]>();

export const extractSearchableChunks = (message: ChatMessageEntry): ChatFindSearchableChunk[] => {
  const cached = chunkCache.get(message);
  if (cached) {
    return cached;
  }

  const chunks: ChatFindSearchableChunk[] = [];
  const push = (partId: string | undefined, text: string): void => {
    if (text.trim().length === 0) {
      return;
    }
    chunks.push({ index: chunks.length, partId, text });
  };

  for (const part of message.parts) {
    if (part.type !== 'text') {
      continue;
    }
    const context = readContextPart(part);
    push(part.id, context ? contextSearchText(context) : part.text);
  }
  chunkCache.set(message, chunks);
  return chunks;
};

/** The display-ordered, deduplicated messages the index searches. */
export const buildSearchableMessages = (
  messages: ChatMessageEntry[],
): ChatFindSearchableMessage[] => {
  if (messages.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const latestById = new Map<string, ChatMessageEntry>();
  for (const message of messages) {
    latestById.set(message.info.id, message);
  }

  const deduped: ChatMessageEntry[] = [];
  for (const message of messages) {
    const messageId = message.info.id;
    if (seen.has(messageId)) {
      continue;
    }
    seen.add(messageId);
    deduped.push(getNormalizedMessageForDisplay(latestById.get(messageId) ?? message));
  }

  const searchable: ChatFindSearchableMessage[] = [];
  for (const message of attachSyntheticContext(deduped)) {
    const role = deriveMessageRole(message.info);
    if (role.role !== 'user' && role.role !== 'assistant') {
      continue;
    }
    const chunks = extractSearchableChunks(message);
    if (chunks.length === 0) {
      continue;
    }
    searchable.push({ messageId: message.info.id, chunks });
  }
  return searchable;
};
