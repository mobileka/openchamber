import { rankByQuery } from '@/lib/search/fuzzySearch';
import {
  getShortcutActionsForCombo,
  type CustomizableShortcutAction,
  type ShortcutCombo,
} from '@/lib/shortcuts';

export interface ShortcutFilterOptions {
  query: string;
  /** Recorded combination to narrow against, or `null` for no shortcut filter. */
  shortcutFilter: ShortcutCombo | null;
  overrides: Record<string, ShortcutCombo>;
  labelOf: (action: CustomizableShortcutAction) => string;
}

/**
 * The visible shortcut rows for the active filters. The shortcut filter picks
 * actions by their effective binding; the text query then fuzzy-ranks them by
 * localized label (typo-tolerant via `rankByQuery`). No query and no shortcut
 * filter returns the schema order unchanged.
 */
export function rankVisibleShortcutActions(
  actions: readonly CustomizableShortcutAction[],
  { query, shortcutFilter, overrides, labelOf }: ShortcutFilterOptions,
): CustomizableShortcutAction[] {
  const matchingIds = shortcutFilter
    ? new Set(getShortcutActionsForCombo(shortcutFilter, overrides).map((action) => action.id))
    : null;
  const visible = matchingIds
    ? actions.filter((action) => matchingIds.has(action.id))
    : [...actions];

  const trimmedQuery = query.trim();
  if (!trimmedQuery) return visible;
  return rankByQuery(visible, trimmedQuery, (action) => [labelOf(action)]);
}
