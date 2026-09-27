import { describe, expect, test } from 'bun:test';

import { capitalizeWords } from './utils';

describe('capitalizeWords', () => {
  test('uppercases the first letter of every word', () => {
    expect(capitalizeWords('user experience')).toBe('User Experience');
  });

  test('treats hyphen and underscore as word boundaries', () => {
    expect(capitalizeWords('code-reviewer')).toBe('Code-Reviewer');
    expect(capitalizeWords('code_reviewer')).toBe('Code_Reviewer');
  });

  test('never lowercases an existing capital', () => {
    expect(capitalizeWords('UX')).toBe('UX');
    expect(capitalizeWords('openChamber')).toBe('OpenChamber');
  });

  test('leaves a bare lowercase word with one capital', () => {
    expect(capitalizeWords('build')).toBe('Build');
  });

  test('handles empty and whitespace-only values', () => {
    expect(capitalizeWords('')).toBe('');
    expect(capitalizeWords('   ')).toBe('   ');
  });
});
