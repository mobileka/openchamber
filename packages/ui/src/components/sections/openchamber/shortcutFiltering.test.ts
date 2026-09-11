import { describe, expect, test } from 'bun:test';
import { getCustomizableShortcutActions, type CustomizableShortcutAction } from '@/lib/shortcuts';
import { rankVisibleShortcutActions } from './shortcutFiltering';

const actions = getCustomizableShortcutActions();

const options = (query: string, shortcutFilter: string | null = null, overrides: Record<string, string> = {}) => ({
  query,
  shortcutFilter,
  overrides,
  labelOf: (action: CustomizableShortcutAction) => action.id,
});

const ids = (list: readonly CustomizableShortcutAction[]) => list.map((action) => action.id);

describe('rankVisibleShortcutActions', () => {
  test('returns schema order with no filters', () => {
    expect(ids(rankVisibleShortcutActions(actions, options('')))).toEqual(ids(actions));
  });

  test('filters by a recorded combination, including held-prefix completions', () => {
    expect(ids(rankVisibleShortcutActions(actions, options('', 'mod+n')))).toEqual(['new_chat']);
    expect(ids(rankVisibleShortcutActions(actions, options('', 'mod+1')))).toEqual(['switch_session_tab']);
    expect(ids(rankVisibleShortcutActions(actions, options('', 'mod+alt+2')))).toEqual(['switch_context_surface']);
  });

  test('fuzzy-ranks by label and shrinks as the query narrows', () => {
    const broad = ids(rankVisibleShortcutActions(actions, options('new')));
    expect(broad).toContain('new_chat');
    expect(broad).toContain('new_mini_chat');
    expect(broad).not.toContain('toggle_sidebar');

    expect(ids(rankVisibleShortcutActions(actions, options('new mini')))).toEqual(['new_mini_chat']);
  });

  test('ranks prefix label matches first and tolerates a typo', () => {
    expect(ids(rankVisibleShortcutActions(actions, options('term')))[0]).toBe('toggle_terminal');
    expect(ids(rankVisibleShortcutActions(actions, options('sidbar')))).toContain('toggle_sidebar');
  });

  test('combines a shortcut filter with a text query', () => {
    expect(ids(rankVisibleShortcutActions(actions, options('switch', 'mod+1')))).toEqual(['switch_session_tab']);
    expect(ids(rankVisibleShortcutActions(actions, options('sidebar', 'mod+1')))).toEqual([]);
  });

  test('honors overrides when filtering by a recorded combination', () => {
    expect(ids(rankVisibleShortcutActions(actions, options('', 'mod+shift+n', { new_chat_worktree: 'mod+shift+w' })))).toEqual([]);
    expect(ids(rankVisibleShortcutActions(actions, options('', 'mod+shift+w', { new_chat_worktree: 'mod+shift+w' })))).toEqual(['new_chat_worktree']);
  });
});
