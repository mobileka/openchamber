import { describe, expect, test } from 'bun:test';

import {
  buildChatSearchMatches,
  buildChatSearchMatchesIncremental,
  createChatFindMatchesCache,
  selectNearestMatchIndex,
  type ChatFindMatchOptions,
} from './chatSearchMatches';
import type { ChatFindMatch, ChatFindSearchableMessage } from './types';

const messages: ChatFindSearchableMessage[] = [
  {
    messageId: 'm1',
    chunks: [{ index: 0, partId: 'p1', text: 'cat dog cat' }],
  },
  {
    messageId: 'm2',
    chunks: [
      { index: 0, partId: 'p2', text: 'cat in the second chunk' },
      { index: 1, partId: 'p3', text: 'cat in the third chunk' },
    ],
  },
];

describe('buildChatSearchMatches', () => {
  test('orders matches by message, chunk, and offset with occurrence numbers', () => {
    const matches = buildChatSearchMatches(messages, 'cat', { caseSensitive: false, wholeWord: false });
    expect(matches.map((match) => `${match.messageId}:${match.partId}:${match.occurrence}`)).toEqual([
      'm1:p1:0',
      'm1:p1:1',
      'm2:p2:0',
      'm2:p3:0',
    ]);
    expect(matches[0]?.key).toBe('m1:0:0');
    expect(matches[1]?.key).toBe('m1:0:1');
    expect(matches[0]).toMatchObject({ start: 0, end: 3, partId: 'p1' });
    expect(matches[1]).toMatchObject({ start: 8, end: 11 });
  });

  test('returns no matches for an empty or whitespace query', () => {
    expect(buildChatSearchMatches(messages, '   ', { caseSensitive: false, wholeWord: false })).toEqual([]);
  });

  test('applies whole-word and case options', () => {
    const word = buildChatSearchMatches(
      [{ messageId: 'm1', chunks: [{ index: 0, text: 'cat concatenate' }] }],
      'cat',
      { caseSensitive: false, wholeWord: true },
    );
    expect(word).toHaveLength(1);
    expect(word[0]?.start).toBe(0);

    const caseSensitive = buildChatSearchMatches(
      [{ messageId: 'm1', chunks: [{ index: 0, text: 'Cat cat' }] }],
      'cat',
      { caseSensitive: true, wholeWord: false },
    );
    expect(caseSensitive).toHaveLength(1);
    expect(caseSensitive[0]?.start).toBe(4);
  });
});

describe('selectNearestMatchIndex', () => {
  const matches: ChatFindMatch[] = [
    { key: 'a', messageId: 'm1', occurrence: 0, start: 0, end: 1 },
    { key: 'b', messageId: 'm2', occurrence: 0, start: 0, end: 1 },
    { key: 'c', messageId: 'm3', occurrence: 0, start: 0, end: 1 },
  ];
  const turnIndex = new Map([
    ['m1', 0],
    ['m2', 1],
    ['m3', 2],
  ]);

  test('starts at the first match at or after the active turn', () => {
    expect(selectNearestMatchIndex(matches, turnIndex, 1)).toBe(1);
    expect(selectNearestMatchIndex(matches, turnIndex, 2)).toBe(2);
  });

  test('wraps to the first match when every match is above the viewport', () => {
    expect(selectNearestMatchIndex(matches, turnIndex, 3)).toBe(0);
  });

  test('falls back to the first match without an active turn', () => {
    expect(selectNearestMatchIndex(matches, turnIndex, -1)).toBe(0);
  });

  test('returns zero for an empty match list', () => {
    expect(selectNearestMatchIndex([], turnIndex, 1)).toBe(0);
  });
});

describe('buildChatSearchMatchesIncremental', () => {
  const options: ChatFindMatchOptions = { caseSensitive: false, wholeWord: false };
  const m1: ChatFindSearchableMessage = {
    messageId: 'm1',
    chunks: [{ index: 0, partId: 'p1', text: 'cat dog cat' }],
  };
  const m2: ChatFindSearchableMessage = {
    messageId: 'm2',
    chunks: [
      { index: 0, partId: 'p2', text: 'cat in the second chunk' },
      { index: 1, partId: 'p3', text: 'cat in the third chunk' },
    ],
  };
  const m3: ChatFindSearchableMessage = {
    messageId: 'm3',
    chunks: [{ index: 0, partId: 'p4', text: 'a later cat' }],
  };

  test('stays equivalent to the full builder across a sequence of changes', () => {
    const cache = createChatFindMatchesCache();
    const m2Streamed: ChatFindSearchableMessage = {
      messageId: 'm2',
      chunks: [
        { index: 0, partId: 'p2', text: 'cat in the second chunk' },
        { index: 1, partId: 'p3', text: 'cat in the third chunk grows' },
      ],
    };

    const steps: Array<{ messages: ChatFindSearchableMessage[]; query: string; options: ChatFindMatchOptions }> = [
      { messages: [m1, m2], query: 'cat', options },
      { messages: [m1, m2, m3], query: 'cat', options },
      { messages: [m1, m2Streamed, m3], query: 'cat', options },
      { messages: [m1, m2Streamed, m3], query: 'dog', options },
      { messages: [m1, m2Streamed, m3], query: 'cat', options: { ...options, wholeWord: true } },
      { messages: [m1, m2Streamed, m3], query: 'cat', options: { ...options, caseSensitive: true } },
      { messages: [m1, m3], query: 'cat', options },
      { messages: [m3, m1], query: 'cat', options },
      { messages: [], query: 'cat', options },
      { messages: [m1, m2], query: '   ', options },
      { messages: [m1, m2], query: 'cat', options },
    ];

    for (const step of steps) {
      expect(buildChatSearchMatchesIncremental(cache, step.messages, step.query, step.options))
        .toEqual(buildChatSearchMatches(step.messages, step.query, step.options));
    }
  });

  test('returns the previous list while no chunk array changed', () => {
    const cache = createChatFindMatchesCache();

    const first = buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', options);
    expect(buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', options)).toBe(first);
    expect(buildChatSearchMatchesIncremental(cache, [m1, m2].slice(), 'cat', options)).toBe(first);
    expect(buildChatSearchMatchesIncremental(cache, [m1, m2], ' cat ', options)).toBe(first);
  });

  test('reuses match objects for messages whose chunk array did not change', () => {
    const cache = createChatFindMatchesCache();
    const first = buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', options);

    const m2Streamed: ChatFindSearchableMessage = {
      messageId: 'm2',
      chunks: [
        { index: 0, partId: 'p2', text: 'cat in the second chunk' },
        { index: 1, partId: 'p3', text: 'cat in the third chunk cat' },
      ],
    };
    const second = buildChatSearchMatchesIncremental(cache, [m1, m2Streamed], 'cat', options);

    expect(second).toEqual(buildChatSearchMatches([m1, m2Streamed], 'cat', options));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
  });

  test('reorders the flat list while reusing match objects', () => {
    const cache = createChatFindMatchesCache();
    const first = buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', options);

    const reordered = buildChatSearchMatchesIncremental(cache, [m2, m1], 'cat', options);
    expect(reordered.map((match) => match.key)).toEqual([
      'm2:0:0',
      'm2:1:0',
      'm1:0:0',
      'm1:0:1',
    ]);
    expect(reordered[0]).toBe(first[2]);
    expect(reordered[2]).toBe(first[0]);
  });

  test('prunes messages that left the list', () => {
    const cache = createChatFindMatchesCache();
    const first = buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', options);
    const before = first.filter((match) => match.messageId === 'm2');

    buildChatSearchMatchesIncremental(cache, [m1], 'cat', options);
    const readded = buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', options);
    const after = readded.filter((match) => match.messageId === 'm2');

    expect(after.map((match) => match.key)).toEqual(before.map((match) => match.key));
    expect(after[0]).not.toBe(before[0]);
  });

  test('rebuilds every message when the query or options change', () => {
    const cache = createChatFindMatchesCache();
    const first = buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', options);

    const queryChanged = buildChatSearchMatchesIncremental(cache, [m1, m2], 'dog', options);
    expect(queryChanged).toEqual(buildChatSearchMatches([m1, m2], 'dog', options));
    expect(queryChanged).not.toBe(first);

    const caseChanged = buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', {
      ...options,
      caseSensitive: true,
    });
    expect(caseChanged).toEqual(buildChatSearchMatches([m1, m2], 'cat', { ...options, caseSensitive: true }));

    const wholeWordChanged = buildChatSearchMatchesIncremental(cache, [m1, m2], 'cat', {
      ...options,
      wholeWord: true,
    });
    expect(wholeWordChanged).toEqual(buildChatSearchMatches([m1, m2], 'cat', { ...options, wholeWord: true }));
  });
});
