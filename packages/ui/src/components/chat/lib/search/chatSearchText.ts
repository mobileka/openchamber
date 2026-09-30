/**
 * Builds the searchable text of a session's messages.
 *
 * The index runs on the same display list the timeline renders: duplicates
 * collapse, malformed parts drop, and synthetic context messages fold back
 * onto their user message, so a context quote is searchable exactly where the
 * reader sees it. Only rendered text parts are indexed; reasoning blocks and
 * tool cards are not conversation text, and neither are roles other than
 * user/assistant (compaction, shell, subtask, plumbing).
 *
 * Both builders treat the message list and its entries as immutable. The sync
 * layer keeps the entry object of an unchanged message stable and replaces an
 * entry when its content changes, so every cache in this file can key on entry
 * identity: a streaming delta re-indexes exactly the message that changed.
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

/**
 * The index wrapper one entry contributes, or `null` when it contributes
 * nothing (a filtered role or no text chunks). Cached by entry identity like
 * the chunks above, so an unchanged message keeps its wrapper object too.
 */
const searchableMessageByEntry = new WeakMap<ChatMessageEntry, ChatFindSearchableMessage | null>();

const toSearchableMessage = (message: ChatMessageEntry): ChatFindSearchableMessage | null => {
  const cached = searchableMessageByEntry.get(message);
  if (cached !== undefined) {
    return cached;
  }

  const role = deriveMessageRole(message.info);
  const chunks = role.role === 'user' || role.role === 'assistant'
    ? extractSearchableChunks(message)
    : [];
  const searchable = chunks.length === 0 ? null : { messageId: message.info.id, chunks };
  searchableMessageByEntry.set(message, searchable);
  return searchable;
};

/** The display-ordered, deduplicated messages the index searches. */
export const buildSearchableMessages = (
  messages: ChatMessageEntry[],
): ChatFindSearchableMessage[] => {
  if (messages.length === 0) {
    return [];
  }

  // Re-setting an existing key keeps its first-appearance slot, so the map
  // ends up holding each id's newest entry in display order.
  const latestById = new Map<string, ChatMessageEntry>();
  for (const message of messages) {
    latestById.set(message.info.id, message);
  }

  const deduped: ChatMessageEntry[] = [];
  for (const message of latestById.values()) {
    deduped.push(getNormalizedMessageForDisplay(message));
  }

  const searchable: ChatFindSearchableMessage[] = [];
  for (const message of attachSyntheticContext(deduped)) {
    const entry = toSearchableMessage(message);
    if (entry) {
      searchable.push(entry);
    }
  }
  return searchable;
};

/**
 * Per-column state the incremental builder keeps between sync events. `input`
 * holds the message list the last build consumed by reference, so re-deciding
 * an unchanged list is a pointer scan.
 */
export type ChatFindSearchableMessagesCache = {
  input: ChatMessageEntry[] | null;
  output: ChatFindSearchableMessage[];
};

export const createChatFindSearchableMessagesCache = (): ChatFindSearchableMessagesCache => ({
  input: null,
  output: [],
});

const sameEntryList = (left: ChatMessageEntry[], right: ChatMessageEntry[]): boolean => {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

/**
 * Incremental entry point for `buildSearchableMessages`. A list whose entries
 * are all reference-identical to the previous build returns the previous
 * output array, so a no-op sync event leaves the match list untouched. A
 * changed entry still re-walks the list, but unchanged entries keep their
 * wrappers and chunk arrays from the per-entry caches.
 */
export const buildSearchableMessagesIncremental = (
  cache: ChatFindSearchableMessagesCache,
  messages: ChatMessageEntry[],
): ChatFindSearchableMessage[] => {
  if (cache.input !== null && sameEntryList(cache.input, messages)) {
    return cache.output;
  }

  const output = buildSearchableMessages(messages);
  cache.input = messages;
  cache.output = output;
  return output;
};
