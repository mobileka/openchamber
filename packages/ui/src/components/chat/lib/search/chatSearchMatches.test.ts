import { describe, expect, test } from 'bun:test';

import { buildChatSearchMatches, selectNearestMatchIndex } from './chatSearchMatches';
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
