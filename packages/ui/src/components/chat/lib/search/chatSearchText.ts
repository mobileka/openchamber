/**
 * Builds the searchable text of a session's messages.
 *
 * The index runs on the same display list the timeline renders: duplicates
 * collapse, malformed parts drop, and synthetic context messages fold back
 * onto their user message, so a context quote is searchable exactly where the
 * reader sees it. Roles other than user/assistant (compaction, shell, subtask,
 * plumbing) are not conversation text and stay out of scope.
 */

import { readContextPart, type ContextPartPayload } from '@/lib/messages/contextParts';
import { toolDescription, type ToolDescription } from '@/lib/opencode/tools';
import type { ToolPart } from '@/lib/opencode/model';

import { deriveMessageRole } from '../../message/messageRole';
import { attachSyntheticContext } from '../attachSyntheticContext';
import { getNormalizedMessageForDisplay } from '../messageDisplayNormalization';
import type { ChatMessageEntry } from '../turns/types';
import type { ChatFindMatchKind, ChatFindSearchableChunk, ChatFindSearchableMessage } from './types';

export type ChatFindExtractionOptions = {
  includeReasoning: boolean;
  includeTools: boolean;
};

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

/** The row subtitle a tool card already shows, flattened for matching. */
const toolDescriptionSearchText = (description: ToolDescription | null): string => {
  if (!description) {
    return '';
  }
  switch (description.kind) {
    case 'path':
    case 'text':
      return description.value;
    case 'files':
      return description.files.join('\n');
    case 'tools':
      return description.calls.map((call) => call.name).join('\n');
    case 'questions':
      // The row renders a localized count, not searchable content.
      return '';
  }
};

const toolSearchText = (part: ToolPart): string => {
  const fields: string[] = [part.tool];
  const { state } = part;
  const metadata = 'metadata' in state ? state.metadata : undefined;
  const description = toolDescriptionSearchText(toolDescription(part.tool, state.input, metadata));
  if (description) {
    fields.push(description);
  }
  fields.push(JSON.stringify(state.input));
  if (state.status === 'completed' || state.status === 'error') {
    if (state.output) {
      fields.push(state.output);
    }
    if (state.status === 'error' && state.error) {
      fields.push(state.error);
    }
  }
  return fields.join('\n');
};

/**
 * The ordered text chunks one message contributes to the find index.
 * `index` is assigned only to chunks that carry text, so identities stay
 * stable for a given message and settings combination.
 *
 * Cached by the message entry's identity: the sync layer keeps unchanged
 * message objects stable, so an open bar re-indexing during streaming only
 * re-extracts the message that actually changed.
 */
const chunkCache = new WeakMap<
  ChatMessageEntry,
  { includeReasoning: boolean; includeTools: boolean; chunks: ChatFindSearchableChunk[] }
>();

export const extractSearchableChunks = (
  message: ChatMessageEntry,
  options: ChatFindExtractionOptions,
): ChatFindSearchableChunk[] => {
  const cached = chunkCache.get(message);
  if (cached && cached.includeReasoning === options.includeReasoning && cached.includeTools === options.includeTools) {
    return cached.chunks;
  }

  const chunks: ChatFindSearchableChunk[] = [];
  const push = (kind: ChatFindMatchKind, partId: string | undefined, text: string): void => {
    if (text.trim().length === 0) {
      return;
    }
    chunks.push({ index: chunks.length, partId, kind, text });
  };

  for (const part of message.parts) {
    if (part.type === 'text') {
      const context = readContextPart(part);
      push('text', part.id, context ? contextSearchText(context) : part.text);
      continue;
    }
    if (part.type === 'reasoning') {
      if (options.includeReasoning) {
        push('reasoning', part.id, part.text);
      }
      continue;
    }
    if (part.type === 'tool' && options.includeTools) {
      push('tool', part.id, toolSearchText(part));
    }
  }
  chunkCache.set(message, { ...options, chunks });
  return chunks;
};

/** The display-ordered, deduplicated messages the index searches. */
export const buildSearchableMessages = (
  messages: ChatMessageEntry[],
  options: ChatFindExtractionOptions,
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
    const chunks = extractSearchableChunks(message, options);
    if (chunks.length === 0) {
      continue;
    }
    searchable.push({ messageId: message.info.id, chunks });
  }
  return searchable;
};
