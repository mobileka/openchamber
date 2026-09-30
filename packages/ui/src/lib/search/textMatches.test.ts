import { describe, expect, test } from 'bun:test';

import { findTextMatches } from './textMatches';

describe('findTextMatches', () => {
  test('matches case-insensitively by default', () => {
    expect(findTextMatches('Hello World', 'world')).toEqual([{ start: 6, end: 11 }]);
  });

  test('honors case-sensitive matching', () => {
    expect(findTextMatches('Hello World', 'world', { caseSensitive: true })).toEqual([]);
    expect(findTextMatches('Hello World', 'World', { caseSensitive: true })).toEqual([{ start: 6, end: 11 }]);
  });

  test('finds non-overlapping matches only', () => {
    expect(findTextMatches('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(findTextMatches('aaa', 'aa')).toEqual([{ start: 0, end: 2 }]);
  });

  test('returns every occurrence in order', () => {
    expect(findTextMatches('one two one', 'one')).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  test('whole-word rejects matches inside a longer word', () => {
    expect(findTextMatches('cat concatenate cat', 'cat', { wholeWord: true })).toEqual([
      { start: 0, end: 3 },
      { start: 16, end: 19 },
    ]);
  });

  test('whole-word treats string edges as boundaries', () => {
    expect(findTextMatches('cat', 'cat', { wholeWord: true })).toEqual([{ start: 0, end: 3 }]);
  });

  test('whole-word uses unicode word characters', () => {
    expect(findTextMatches('кот котик', 'кот', { wholeWord: true })).toEqual([{ start: 0, end: 3 }]);
    expect(findTextMatches('café cafés', 'café', { wholeWord: true })).toEqual([{ start: 0, end: 4 }]);
  });

  test('whole-word does not treat an underscore as a boundary', () => {
    expect(findTextMatches('foo_bar foo', 'foo', { wholeWord: true })).toEqual([{ start: 8, end: 11 }]);
  });

  test('empty input returns no matches', () => {
    expect(findTextMatches('', 'cat')).toEqual([]);
    expect(findTextMatches('cat', '')).toEqual([]);
  });

  test('query longer than the text returns no matches', () => {
    expect(findTextMatches('cat', 'concatenate')).toEqual([]);
  });

  test('query with punctuation keeps plain substring semantics', () => {
    expect(findTextMatches('a.b a-b', 'a.b')).toEqual([{ start: 0, end: 3 }]);
  });
});
