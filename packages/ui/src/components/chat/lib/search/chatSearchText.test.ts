import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, Part, TextPart, ToolPart, UserMessage } from '@/lib/opencode/model';

import type { ChatMessageEntry } from '../turns/types';
import { buildSearchableMessages, extractSearchableChunks } from './chatSearchText';

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
