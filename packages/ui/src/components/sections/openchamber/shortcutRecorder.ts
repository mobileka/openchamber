import {
  keyToShortcutToken,
  normalizeCombo,
  resolveShortcutEventKey,
  type ShortcutCombo,
} from '@/lib/shortcuts';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);
const MAX_SHORTCUT_KEY_COUNT = 3;
export const SECOND_CHORD_TIMEOUT_MS = 3000;

export interface RecordingKeyboardEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
}

export interface ShortcutRecordingState {
  chords: ShortcutCombo[];
  livePreview: ShortcutCombo | null;
  settled: boolean;
}

export const EMPTY_SHORTCUT_RECORDING: ShortcutRecordingState = {
  chords: [],
  livePreview: null,
  settled: false,
};

function getPhysicalKeyCount(
  event: Pick<RecordingKeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  includeEventKey = false,
): number {
  const keys = new Set<string>();
  if (event.altKey) keys.add('alt');
  if (event.ctrlKey) keys.add('control');
  if (event.metaKey) keys.add('meta');
  if (event.shiftKey) keys.add('shift');
  if (includeEventKey) keys.add(event.key.toLowerCase());
  return keys.size;
}

function getModifierPreview(event: RecordingKeyboardEvent): ShortcutCombo | null {
  if (getPhysicalKeyCount(event) > MAX_SHORTCUT_KEY_COUNT) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

function keyboardEventToCombo(event: RecordingKeyboardEvent): ShortcutCombo | null {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
  if (getPhysicalKeyCount(event, true) > MAX_SHORTCUT_KEY_COUNT) return null;

  const key = keyToShortcutToken(resolveShortcutEventKey(event));
  if (!key) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  parts.push(key);
  return normalizeCombo(parts.join('+'));
}

export function modifierKeyUpToCombo(event: RecordingKeyboardEvent): ShortcutCombo | null {
  const key = event.key.toLowerCase();
  if (!MODIFIER_KEYS.has(key)) return null;
  if (getPhysicalKeyCount(event, true) > MAX_SHORTCUT_KEY_COUNT) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey || key === 'meta' || key === 'control') parts.push('mod');
  if (event.shiftKey || key === 'shift') parts.push('shift');
  if (event.altKey || key === 'alt') parts.push('alt');
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

export function settleShortcutRecordingState(state: ShortcutRecordingState): ShortcutRecordingState {
  return state.chords.length > 0 ? { ...state, livePreview: null, settled: true } : state;
}

export function updateShortcutRecordingState(
  state: ShortcutRecordingState,
  event: RecordingKeyboardEvent,
  phase: 'keydown' | 'keyup',
): ShortcutRecordingState {
  if (event.repeat || event.isComposing) return state;
  if (phase === 'keyup') {
    return { ...state, livePreview: getModifierPreview(event) };
  }

  if (event.key === 'Backspace') {
    return { chords: state.chords.slice(0, -1), livePreview: null, settled: false };
  }

  const chord = keyboardEventToCombo(event);
  if (chord) {
    if (state.settled) {
      return { chords: [chord], livePreview: null, settled: false };
    }
    const chords = state.chords.length < 2 ? [...state.chords, chord] : state.chords;
    return {
      chords,
      livePreview: null,
      settled: chords.length === 2,
    };
  }

  return { ...state, livePreview: getModifierPreview(event) };
}
