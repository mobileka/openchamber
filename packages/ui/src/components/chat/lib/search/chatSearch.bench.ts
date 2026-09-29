/**
 * Per-delta cost of the chat find index on a long history.
 *
 * Run with:
 *   bun run packages/ui/src/components/chat/lib/search/chatSearch.bench.ts
 *
 * The scenario is a find bar open on a long session while it streams: each
 * event brings a fresh message list where exactly one entry changed. The "full"
 * path reproduces the code as it shipped before the incremental builders (full
 * list rebuild plus a `findTextMatches` scan over every chunk); the
 * "incremental" path reuses unchanged entries and chunks and only scans the
 * message that changed.
 *
 * Last observed (2026-09-29, Bun 1.3.14, Apple Silicon, warm measured pass):
 *   streaming delta, 2500 messages / 10000 chunks / ~1.8M chars:
 *     full rebuild + full scan  median ~2.0 ms
 *     incremental               median ~0.6 ms   (3.3x)
 *   unchanged list event (same entries, fresh array):
 *     full rebuild + full scan  ~2.3 ms
 *     incremental               ~0.04 ms         (57x)
 *
 * These are local microbenchmark numbers, not a browser profile. They cover
 * the index functions only; rendering and highlight work are out of scope.
 */

import type { AssistantMessage, Part, TextPart, UserMessage } from '@/lib/opencode/model';

import { deriveMessageRole } from '../../message/messageRole';
import { attachSyntheticContext } from '../attachSyntheticContext';
import { getNormalizedMessageForDisplay } from '../messageDisplayNormalization';
import type { ChatMessageEntry } from '../turns/types';
import {
  buildChatSearchMatches,
  buildChatSearchMatchesIncremental,
  createChatFindMatchesCache,
  type ChatFindMatchOptions,
} from './chatSearchMatches';
import {
  buildSearchableMessagesIncremental,
  createChatFindSearchableMessagesCache,
  extractSearchableChunks,
} from './chatSearchText';
import type { ChatFindSearchableMessage } from './types';

const MESSAGE_COUNT = 2500;
const CHUNKS_PER_MESSAGE = 4;
const CHUNK_LENGTH = 180;
const DELTAS = 300;
const STATIC_REPEATS = 200;
const QUERY = 'needle';
const OPTIONS: ChatFindMatchOptions = { caseSensitive: false, wholeWord: false };

/**
 * `buildSearchableMessages` as it shipped before the incremental work: the same
 * pipeline, but a fresh wrapper object per message on every rebuild. Kept here
 * as the "before" baseline; the shipped function it mirrors is also exercised
 * by `chatSearchText.test.ts`.
 */
const buildSearchableMessagesBaseline = (messages: ChatMessageEntry[]): ChatFindSearchableMessage[] => {
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

const messageId = (index: number): string => `msg_${String(index).padStart(6, '0')}`;

const userMessage = (id: string): UserMessage => ({
  id,
  sessionID: 'ses_bench',
  role: 'user',
  time: { created: 1 },
});

const assistantMessage = (id: string): AssistantMessage => ({
  id,
  sessionID: 'ses_bench',
  role: 'assistant',
  time: { created: 2 },
  agent: 'build',
  providerID: 'opencode',
  modelID: 'bench',
});

const textPart = (id: string, messageID: string, text: string): TextPart => ({
  id,
  sessionID: 'ses_bench',
  messageID,
  type: 'text',
  text,
});

const filler = (index: number): string => {
  const base = `step ${index}: the assistant explains the change and its tradeoffs in a few sentences. `;
  return base.repeat(Math.ceil(CHUNK_LENGTH / base.length)).slice(0, CHUNK_LENGTH);
};

const buildFixture = (): ChatMessageEntry[] => {
  const entries: ChatMessageEntry[] = [];
  for (let index = 0; index < MESSAGE_COUNT; index += 1) {
    const id = messageId(index);
    const parts: Part[] = [];
    for (let chunk = 0; chunk < CHUNKS_PER_MESSAGE; chunk += 1) {
      const text = filler(index + chunk) + ((index + chunk) % 7 === 0 ? ' needle' : '');
      parts.push(textPart(`${id}_p${chunk}`, id, text));
    }
    entries.push({ info: index % 2 === 0 ? userMessage(id) : assistantMessage(id), parts });
  }
  return entries;
};

/** Grows the last message's first text part, the way a streaming delta does. */
const growLastMessage = (messages: ChatMessageEntry[], step: number): ChatMessageEntry[] => {
  const last = messages[messages.length - 1];
  if (!last) {
    throw new Error('bench fixture is empty');
  }
  const grown: ChatMessageEntry = {
    info: last.info,
    parts: last.parts.map((part, index) => (
      index === 0 && part.type === 'text' ? { ...part, text: `${part.text} stream-${step}` } : part
    )),
  };
  return [...messages.slice(0, -1), grown];
};

const buildDeltaSequence = (): ChatMessageEntry[][] => {
  let messages = buildFixture();
  const sequence: ChatMessageEntry[][] = [messages];
  for (let step = 0; step < DELTAS; step += 1) {
    messages = growLastMessage(messages, step);
    sequence.push(messages);
  }
  return sequence;
};

type PathResult = {
  samples: number[];
  matchCounts: number[];
};

const runFullPath = (sequence: ChatMessageEntry[][]): PathResult => {
  const samples: number[] = [];
  const matchCounts: number[] = [];
  for (const messages of sequence) {
    const start = performance.now();
    const searchable = buildSearchableMessagesBaseline(messages);
    const matches = buildChatSearchMatches(searchable, QUERY, OPTIONS);
    samples.push(performance.now() - start);
    matchCounts.push(matches.length);
  }
  return { samples, matchCounts };
};

const runIncrementalPath = (sequence: ChatMessageEntry[][]): PathResult => {
  const textCache = createChatFindSearchableMessagesCache();
  const matchCache = createChatFindMatchesCache();
  const samples: number[] = [];
  const matchCounts: number[] = [];
  for (const messages of sequence) {
    const start = performance.now();
    const searchable = buildSearchableMessagesIncremental(textCache, messages);
    const matches = buildChatSearchMatchesIncremental(matchCache, searchable, QUERY, OPTIONS);
    samples.push(performance.now() - start);
    matchCounts.push(matches.length);
  }
  return { samples, matchCounts };
};

const percentile = (samples: number[], fraction: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
};

const formatMs = (value: number): string => `${value.toFixed(3)} ms`;

type StaticListResult = {
  full: number;
  incremental: number;
};

const runStaticList = (
  messages: ChatMessageEntry[],
  repeat: number,
): StaticListResult => {
  const startFull = performance.now();
  for (let index = 0; index < repeat; index += 1) {
    const searchable = buildSearchableMessagesBaseline(messages);
    buildChatSearchMatches(searchable, QUERY, OPTIONS);
  }
  const full = (performance.now() - startFull) / repeat;

  const textCache = createChatFindSearchableMessagesCache();
  const matchCache = createChatFindMatchesCache();
  const startIncremental = performance.now();
  for (let index = 0; index < repeat; index += 1) {
    const searchable = buildSearchableMessagesIncremental(textCache, messages);
    buildChatSearchMatchesIncremental(matchCache, searchable, QUERY, OPTIONS);
  }
  const incremental = (performance.now() - startIncremental) / repeat;
  return { full, incremental };
};

const run = (): void => {
  // Cold: fresh fixtures and caches, so the first event shows the cost of
  // building the index from nothing.
  const coldFull = runFullPath(buildDeltaSequence());
  const coldIncremental = runIncrementalPath(buildDeltaSequence());

  // Warm: one discard pass per path populates JIT and the module-level entry
  // caches the way the first sync event does before the bar settles.
  runFullPath(buildDeltaSequence());
  runIncrementalPath(buildDeltaSequence());
  const full = runFullPath(buildDeltaSequence());
  const incremental = runIncrementalPath(buildDeltaSequence());

  const countsAgree = full.matchCounts.every((count, index) => count === incremental.matchCounts[index]);
  const chunkCount = MESSAGE_COUNT * CHUNKS_PER_MESSAGE;
  const characterCount = MESSAGE_COUNT * CHUNKS_PER_MESSAGE * CHUNK_LENGTH;
  const medianFull = percentile(full.samples, 0.5);
  const medianIncremental = percentile(incremental.samples, 0.5);
  const p95Full = percentile(full.samples, 0.95);
  const p95Incremental = percentile(incremental.samples, 0.95);

  console.log('=== streaming delta: one changed message per event ===');
  console.log(`  fixture: ${MESSAGE_COUNT} messages, ${chunkCount} chunks, ~${characterCount} characters`);
  console.log(`  events: ${DELTAS}, query "${QUERY}", matches: ${full.matchCounts[0] ?? 0}`);
  console.log(`  full rebuild + full scan: median ${formatMs(medianFull)}, p95 ${formatMs(p95Full)}`);
  console.log(`  incremental:              median ${formatMs(medianIncremental)}, p95 ${formatMs(p95Incremental)}`);
  console.log(`  speedup:                  median ${(medianFull / medianIncremental).toFixed(1)}x, p95 ${(p95Full / p95Incremental).toFixed(1)}x`);
  console.log(`  first (cold) event:       full ${formatMs(coldFull.samples[0] ?? 0)}, incremental ${formatMs(coldIncremental.samples[0] ?? 0)}`);
  console.log(`  match counts agree on every event: ${countsAgree ? 'yes' : 'NO'}`);

  const staticSelected = buildDeltaSequence();
  const staticList = runStaticList(staticSelected[staticSelected.length - 1] ?? [], STATIC_REPEATS);
  console.log('=== unchanged list event (same entries, fresh array) ===');
  console.log(`  full rebuild + full scan: ${formatMs(staticList.full)}`);
  console.log(`  incremental:              ${formatMs(staticList.incremental)}`);
  console.log(`  speedup:                  ${(staticList.full / staticList.incremental).toFixed(1)}x`);
};

if (import.meta.main) {
  run();
}
