import {
  getShortcutConflict,
  isValidShortcutCombo,
  normalizeCombo,
  parseShortcut,
  UNASSIGNED_SHORTCUT,
  type ShortcutCombo,
  type ShortcutConflict,
} from './bindings';
import { SHORTCUT_SCHEMA } from './config';

export { SHORTCUT_SCHEMA } from './config';

export type ShortcutAction = (typeof SHORTCUT_SCHEMA)[number];
export type ShortcutActionId = ShortcutAction['id'];
export type ShortcutCategory = ShortcutAction['category'];
export type CustomizableShortcutAction = Extract<ShortcutAction, { customizable: true }>;
/** 'contextual-prefix' is kept in the union for the recording dialog's
    messaging even though no default layout produces it any more. */
export type ShortcutBindingConflictKind = ShortcutConflict | 'contextual-prefix';
export type ShortcutBindingConflict = {
  action: ShortcutAction;
  kind: ShortcutBindingConflictKind;
};

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_SCHEMA.find((action) => action.id === id);
}

export function getCustomizableShortcutActions(): ReadonlyArray<CustomizableShortcutAction> {
  return SHORTCUT_SCHEMA.filter(
    (action): action is CustomizableShortcutAction => action.customizable,
  );
}

export function getEffectiveShortcutCombo(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';
  const defaultBinding = action.defaultBinding === UNASSIGNED_SHORTCUT ? '' : action.defaultBinding;
  if (!action.customizable) return defaultBinding;

  const override = overrides?.[actionId];
  if (typeof override === 'string') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return '';
    if (isValidShortcutCombo(normalized)) return normalized;
  }

  return defaultBinding;
}

export function getEffectiveShortcutPrefix(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';
  if (!action.customizable) return action.defaultBinding;

  const override = overrides?.[actionId];
  if (typeof override === 'string' && override.trim() !== '') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return UNASSIGNED_SHORTCUT;
    const chord = parseShortcut(normalized)?.chords[0];
    if (chord && (chord.modifiers.size > 0 || chord.key)) return normalized;
  }

  return action.defaultBinding;
}

export function getShortcutBindingConflicts(
  actionId: ShortcutActionId,
  combo: ShortcutCombo,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutBindingConflict[] {
  const conflicts: ShortcutBindingConflict[] = [];
  const action = getShortcutAction(actionId);
  if (!action) return conflicts;
  for (const candidate of SHORTCUT_SCHEMA) {
    if (candidate.id === actionId) continue;
    const candidateCombo = ('prefixStyle' in candidate && candidate.prefixStyle)
      ? getEffectiveShortcutPrefix(candidate.id, overrides)
      : getEffectiveShortcutCombo(candidate.id, overrides);
    const kind = getShortcutConflict(combo, candidateCombo);
    if (!kind) continue;
    conflicts.push({ action: candidate, kind });
  }
  return conflicts;
}

/**
 * A recorded press completes a bare-modifier prefix when it is one chord of
 * the prefix's modifiers plus a single digit (`mod+1`, `mod+alt+0`). The
 * digits are how the held-prefix actions are addressed at runtime.
 */
function recordedCompletesPrefix(prefixCombo: ShortcutCombo, recordedCombo: ShortcutCombo): boolean {
  const prefix = parseShortcut(prefixCombo)?.chords[0];
  const recorded = parseShortcut(recordedCombo)?.chords;
  if (!prefix || prefix.key || prefix.modifiers.size === 0) return false;
  if (!recorded || recorded.length !== 1) return false;
  const chord = recorded[0];
  if (!/^\d$/.test(chord.key)) return false;
  if (chord.modifiers.size !== prefix.modifiers.size) return false;
  for (const modifier of prefix.modifiers) {
    if (!chord.modifiers.has(modifier)) return false;
  }
  return true;
}

/**
 * Schema actions whose effective binding is the recorded combo: an exact
 * match, or a digit completion of a `prefixStyle` action (`mod` → session
 * tabs, `mod+alt` → context surfaces). Unassigned actions never match.
 */
export function getShortcutActionsForCombo(
  combo: ShortcutCombo,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutAction[] {
  const normalized = normalizeCombo(combo);
  if (!normalized || normalized === UNASSIGNED_SHORTCUT) return [];
  return SHORTCUT_SCHEMA.filter((action) => {
    if ('prefixStyle' in action && action.prefixStyle) {
      return recordedCompletesPrefix(getEffectiveShortcutPrefix(action.id, overrides), normalized);
    }
    return getEffectiveShortcutCombo(action.id, overrides) === normalized;
  });
}
