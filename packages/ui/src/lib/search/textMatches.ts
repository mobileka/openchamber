/**
 * Case- and word-aware plain-text matching shared by the chat find index and
 * its DOM highlighter.
 *
 * The scan semantics are the same non-overlapping `indexOf` walk as
 * standard find-in-page and as `markdownPreviewFind.findMatchRanges`
 * ("aaa" in "aaaa" yields a single [0,3] match).
 */

export type TextMatchRange = {
  start: number;
  end: number;
};

export type TextMatchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
};

const WORD_CHAR_PATTERN = /[\p{L}\p{N}_]/u;

const isWordChar = (value: string | undefined): boolean =>
  value !== undefined && value.length > 0 && WORD_CHAR_PATTERN.test(value);

export const findTextMatches = (
  text: string,
  query: string,
  options: TextMatchOptions = {},
): TextMatchRange[] => {
  if (text.length === 0 || query.length === 0) {
    return [];
  }

  const caseSensitive = options.caseSensitive === true;
  const wholeWord = options.wholeWord === true;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (needle.length === 0 || needle.length > haystack.length) {
    return [];
  }

  const ranges: TextMatchRange[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, cursor);
    if (start === -1) {
      break;
    }
    const end = start + needle.length;
    if (!wholeWord || (!isWordChar(haystack[start - 1]) && !isWordChar(haystack[end]))) {
      ranges.push({ start, end });
    }
    cursor = end;
  }
  return ranges;
};
