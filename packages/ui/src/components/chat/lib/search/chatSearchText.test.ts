import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, Part, TextPart, ToolPart, UserMessage } from '@/lib/opencode/model';

import type { ChatMessageEntry } from '../turns/types';
import {
  buildSearchableMessages,
  buildSearchableMessagesIncremental,
  createChatFindSearchableMessagesCache,
  extractSearchableChunks,
} from './chatSearchText';
import type { ChatFindSearchableMessage } from './types';

const userMessage = (id: string): UserMessage => ({
  id,
  sessionID: 'ses_1',
  role: 'user',
  time: { created: 1 },
});

const assistantMessage = (id: string): AssistantMessage => ({
  id,
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 2 },
  agent: 'build',
  providerID: 'opencode',
  modelID: 'big-pickle',
});

const textPart = (id: string, text: string, metadata?: TextPart['metadata']): TextPart => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg',
  type: 'text',
  text,
  metadata,
});

const reasoningPart = (id: string, text: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg',
  type: 'reasoning',
  text,
  time: { start: 1, end: 2 },
});

const toolPart = (id: string, output: string): ToolPart => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg',
  type: 'tool',
  callID: `call_${id}`,
  tool: 'shell',
  state: {
    status: 'completed',
    input: { command: 'ls -la' },
    output,
    time: { start: 1, end: 2 },
  },
});

const entry = (info: ChatMessageEntry['info'], parts: Part[]): ChatMessageEntry => ({ info, parts });

describe('extractSearchableChunks', () => {
  test('extracts user and assistant text parts', () => {
    const message = entry(assistantMessage('a1'), [textPart('p1', 'Hello world')]);
    expect(extractSearchableChunks(message)).toEqual([
      { index: 0, partId: 'p1', text: 'Hello world' },
    ]);
  });

  test('skips empty text parts', () => {
    const message = entry(assistantMessage('a1'), [textPart('p1', '   ')]);
    expect(extractSearchableChunks(message)).toEqual([]);
  });

  test('skips reasoning and tool parts', () => {
    const message = entry(assistantMessage('a1'), [
      reasoningPart('r1', 'secret plan'),
      toolPart('t1', 'file-a\nfile-b'),
    ]);
    expect(extractSearchableChunks(message)).toEqual([]);
  });

  test('reads user context payloads from text parts', () => {
    const message = entry(userMessage('u1'), [
      textPart('c1', 'formatted for the model', {
        openchamberContext: {
          kind: 'file-quote',
          fileLabel: 'src/main.ts',
          startLine: 3,
          endLine: 4,
          quote: 'const answer = 42;',
          text: 'why is this here',
        },
      }),
    ]);
    const chunks = extractSearchableChunks(message);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('const answer = 42;');
    expect(chunks[0]?.text).toContain('why is this here');
    expect(chunks[0]?.text).not.toContain('formatted for the model');
  });
});

describe('buildSearchableMessages', () => {
  test('keeps only user and assistant conversation roles', () => {
    const messages: ChatMessageEntry[] = [
      entry(userMessage('u1'), [textPart('p1', 'prompt')]),
      entry(assistantMessage('a1'), [textPart('p2', 'answer')]),
      entry(
        {
          id: 'c1',
          sessionID: 'ses_1',
          role: 'compaction',
          time: { created: 3 },
          status: 'completed',
          reason: 'auto',
          summary: 'compacted summary text',
        },
        [textPart('p3', 'compacted summary text')],
      ),
    ];
    const searchable = buildSearchableMessages(messages);
    expect(searchable.map((message) => message.messageId)).toEqual(['u1', 'a1']);
  });

  test('deduplicates by message id, keeping the latest content', () => {
    const messages: ChatMessageEntry[] = [
      entry(userMessage('u1'), [textPart('p1', 'old prompt')]),
      entry(userMessage('u1'), [textPart('p1', 'new prompt')]),
    ];
    const searchable = buildSearchableMessages(messages);
    expect(searchable).toHaveLength(1);
    expect(searchable[0]?.chunks[0]?.text).toBe('new prompt');
  });

  test('folds a synthetic context message onto its user message', () => {
    const synthetic = entry(
      {
        id: 's1',
        sessionID: 'ses_1',
        role: 'synthetic',
        time: { created: 1 },
        text: 'terminal output body',
        metadata: {
          openchamberContext: {
            kind: 'terminal',
            terminalId: 'term-1',
            terminalLabel: 'Terminal',
            startLine: 1,
            endLine: 2,
            output: 'terminal output body',
          },
        },
      },
      [],
    );
    const messages: ChatMessageEntry[] = [synthetic, entry(userMessage('u1'), [textPart('p1', 'look at this')])];
    const searchable = buildSearchableMessages(messages);
    expect(searchable).toHaveLength(1);
    expect(searchable[0]?.messageId).toBe('u1');
    const joined = searchable[0]?.chunks.map((chunk) => chunk.text).join('\n') ?? '';
    expect(joined).toContain('terminal output body');
    expect(joined).toContain('look at this');
  });
});

const syntheticContext = (id: string, output: string): ChatMessageEntry => entry(
  {
    id,
    sessionID: 'ses_1',
    role: 'synthetic',
    time: { created: 1 },
    text: output,
    metadata: {
      openchamberContext: {
        kind: 'terminal',
        terminalId: 'term-1',
        terminalLabel: 'Terminal',
        startLine: 1,
        endLine: 2,
        output,
      },
    },
  },
  [],
);

const joinedChunkText = (messages: ChatFindSearchableMessage[]): string =>
  messages.flatMap((message) => message.chunks.map((chunk) => chunk.text)).join('\n');

describe('buildSearchableMessagesIncremental', () => {
  const compaction = (): ChatMessageEntry => entry(
    {
      id: 'c1',
      sessionID: 'ses_1',
      role: 'compaction',
      time: { created: 3 },
      status: 'completed',
      reason: 'auto',
      summary: 'compacted summary text',
    },
    [textPart('p3', 'compacted summary text')],
  );

  test('stays equivalent to the full builder across a sequence of list changes', () => {
    const cache = createChatFindSearchableMessagesCache();
    const u1 = entry(userMessage('u1'), [textPart('p1', 'first prompt')]);
    const a1 = entry(assistantMessage('a1'), [textPart('p2', 'first answer')]);
    const a1Grown = entry(assistantMessage('a1'), [textPart('p2', 'first answer continued')]);
    const a1Emptied = entry(assistantMessage('a1'), [textPart('p2', '   ')]);
    const a2 = entry(assistantMessage('a2'), [textPart('p4', 'second answer')]);
    const earlyContext = syntheticContext('s1', 'early terminal');
    const lateContext = syntheticContext('s2', 'late terminal');

    const snapshots: ChatMessageEntry[][] = [
      [u1, a1, compaction()],
      [u1, a1],
      [u1, a1, a2],
      [u1, a1Grown, a2],
      [u1, a1Grown, a2, compaction()],
      [earlyContext, u1, a1Grown, a2],
      [earlyContext, u1, lateContext, a1Grown, a2],
      [earlyContext, u1, a1Grown, a2, lateContext],
      [earlyContext, u1, a1Emptied, a2],
      [earlyContext, u1, a1Emptied],
      [lateContext, u1, a1Emptied],
      [],
      [],
      [u1, a1],
    ];

    for (const snapshot of snapshots) {
      expect(buildSearchableMessagesIncremental(cache, snapshot))
        .toEqual(buildSearchableMessages(snapshot));
    }
  });

  test('returns the previous list while the entries are reference-identical', () => {
    const cache = createChatFindSearchableMessagesCache();
    const messages = [
      entry(userMessage('u1'), [textPart('p1', 'first prompt')]),
      entry(assistantMessage('a1'), [textPart('p2', 'first answer')]),
    ];

    const first = buildSearchableMessagesIncremental(cache, messages);
    expect(buildSearchableMessagesIncremental(cache, messages)).toBe(first);
    expect(buildSearchableMessagesIncremental(cache, messages.slice())).toBe(first);

    const changed = [...messages.slice(0, 1), entry(assistantMessage('a1'), [textPart('p2', 'first answer continued')])];
    const second = buildSearchableMessagesIncremental(cache, changed);
    expect(second).not.toBe(first);
    expect(second).toEqual(buildSearchableMessages(changed));
  });

  test('reuses wrappers and chunks for unchanged entries and rebuilds the changed one', () => {
    const cache = createChatFindSearchableMessagesCache();
    const u1 = entry(userMessage('u1'), [textPart('p1', 'hello world')]);
    const a1 = entry(assistantMessage('a1'), [textPart('p2', 'the answer')]);

    const first = buildSearchableMessagesIncremental(cache, [u1, a1]);
    const a1Grown = entry(assistantMessage('a1'), [textPart('p2', 'the answer continued')]);
    const second = buildSearchableMessagesIncremental(cache, [u1, a1Grown]);

    expect(second[0]).toBe(first[0]);
    expect(second[0]?.chunks).toBe(first[0]?.chunks);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.chunks).not.toBe(first[1]?.chunks);
  });

  test('re-materializes a deduplicated id when its latest entry changes', () => {
    const cache = createChatFindSearchableMessagesCache();
    const older = entry(userMessage('u1'), [textPart('p1', 'old prompt')]);
    const latest = entry(userMessage('u1'), [textPart('p1', 'new prompt')]);

    const first = buildSearchableMessagesIncremental(cache, [older, latest]);
    expect(first).toHaveLength(1);
    expect(first[0]?.chunks[0]?.text).toBe('new prompt');

    const latestChanged = entry(userMessage('u1'), [textPart('p1', 'newest prompt')]);
    const second = buildSearchableMessagesIncremental(cache, [older, latestChanged]);
    expect(second).toEqual(buildSearchableMessages([older, latestChanged]));
    expect(second[0]?.chunks[0]?.text).toBe('newest prompt');
    expect(second[0]).not.toBe(first[0]);
  });

  test('re-folds changed synthetic context onto its user message', () => {
    const cache = createChatFindSearchableMessagesCache();
    const user = entry(userMessage('u1'), [textPart('p1', 'look at this')]);

    const before = buildSearchableMessagesIncremental(cache, [syntheticContext('s1', 'before output'), user]);
    expect(before).toHaveLength(1);
    expect(joinedChunkText(before)).toContain('before output');

    const after = buildSearchableMessagesIncremental(cache, [syntheticContext('s1', 'after output'), user]);
    expect(after).toEqual(buildSearchableMessages([syntheticContext('s1', 'after output'), user]));
    expect(joinedChunkText(after)).toContain('after output');
    expect(joinedChunkText(after)).not.toContain('before output');
    expect(after[0]).not.toBe(before[0]);
  });

  test('drops an entry that stops contributing chunks', () => {
    const cache = createChatFindSearchableMessagesCache();
    const user = entry(userMessage('u1'), [textPart('p1', 'prompt')]);
    const assistant = entry(assistantMessage('a1'), [textPart('p2', 'answer')]);

    expect(buildSearchableMessagesIncremental(cache, [user, assistant])).toHaveLength(2);

    const emptied = entry(assistantMessage('a1'), [textPart('p2', '   ')]);
    const next = buildSearchableMessagesIncremental(cache, [user, emptied]);
    expect(next).toHaveLength(1);
    expect(next[0]?.messageId).toBe('u1');
    expect(next).toEqual(buildSearchableMessages([user, emptied]));
  });
});
