import {
  keyToShortcutToken,
  normalizeCombo,
  resolveShortcutEventKey,
  type ShortcutCombo,
} from '@/lib/shortcuts';
import { isMacOS } from '@/lib/utils';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);
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

export interface RecordingOptions {
  maxKeys: number;
  /** On macOS Control and Command are separate keys and record separately. */
  macModifiers: boolean;
}

const DEFAULT_RECORDING_OPTIONS: RecordingOptions = { maxKeys: 3, macModifiers: isMacOS() };

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

// `mod` is Command on macOS and Control elsewhere. On macOS a held Control is
// its own `ctrl` modifier, so Ctrl+N never records as Cmd+N; elsewhere Meta is
// the Windows / Super key and records as `super`, never as Control.
function modifierTokensForEvent(
  event: Pick<RecordingKeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  { macModifiers }: RecordingOptions,
  releasedKey?: string,
): string[] {
  const tokens = new Set<string>();
  const meta = event.metaKey || releasedKey === 'meta';
  const control = event.ctrlKey || releasedKey === 'control';
  if (macModifiers) {
    if (meta) tokens.add('mod');
    if (control) tokens.add('ctrl');
  } else {
    if (control) tokens.add('mod');
    if (meta) tokens.add('super');
  }
  if (event.shiftKey || releasedKey === 'shift') tokens.add('shift');
  if (event.altKey || releasedKey === 'alt') tokens.add('alt');
  return [...tokens];
}

function getModifierPreview(event: RecordingKeyboardEvent, options: RecordingOptions): ShortcutCombo | null {
  if (getPhysicalKeyCount(event) > options.maxKeys) return null;
  const parts = modifierTokensForEvent(event, options);
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

function keyboardEventToCombo(event: RecordingKeyboardEvent, options: RecordingOptions): ShortcutCombo | null {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
  if (getPhysicalKeyCount(event, true) > options.maxKeys) return null;

  const key = keyToShortcutToken(resolveShortcutEventKey(event));
  if (!key) return null;

  return normalizeCombo([...modifierTokensForEvent(event, options), key].join('+'));
}

export function modifierKeyUpToCombo(
  event: RecordingKeyboardEvent,
  options: Partial<RecordingOptions> = {},
): ShortcutCombo | null {
  const recordingOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  const key = event.key.toLowerCase();
  if (!MODIFIER_KEYS.has(key)) return null;
  if (getPhysicalKeyCount(event, true) > recordingOptions.maxKeys) return null;

  // The released modifier no longer shows in the event's flags; count it as held.
  const parts = modifierTokensForEvent({
    metaKey: event.metaKey || key === 'meta',
    ctrlKey: event.ctrlKey || key === 'control',
    shiftKey: event.shiftKey || key === 'shift',
    altKey: event.altKey || key === 'alt',
  }, recordingOptions, key);
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

export function settleShortcutRecordingState(state: ShortcutRecordingState): ShortcutRecordingState {
  return state.chords.length > 0 ? { ...state, livePreview: null, settled: true } : state;
}

export function updateShortcutRecordingState(
  state: ShortcutRecordingState,
  event: RecordingKeyboardEvent,
  phase: 'keydown' | 'keyup',
  maxChords = 2,
  options: Partial<RecordingOptions> = {},
): ShortcutRecordingState {
  const recordingOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  if (event.repeat || event.isComposing) return state;
  if (phase === 'keyup') {
    return { ...state, livePreview: getModifierPreview(event, recordingOptions) };
  }

  if (event.key === 'Backspace') {
    return { chords: state.chords.slice(0, -1), livePreview: null, settled: false };
  }

  const chord = keyboardEventToCombo(event, recordingOptions);
  if (chord) {
    if (state.settled) {
      const chords = [chord];
      return { chords, livePreview: null, settled: chords.length >= maxChords };
    }
    const chords = state.chords.length < maxChords ? [...state.chords, chord] : state.chords;
    return {
      chords,
      livePreview: null,
      settled: chords.length >= maxChords,
    };
  }

  return { ...state, livePreview: getModifierPreview(event, recordingOptions) };
}
