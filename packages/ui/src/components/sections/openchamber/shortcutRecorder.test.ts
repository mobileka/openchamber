import { describe, expect, test } from 'bun:test';
import {
  modifierKeyUpToCombo,
  settleShortcutRecordingState,
  updateShortcutRecordingState,
} from './shortcutRecorder';

const emptyState = { chords: [], livePreview: null, settled: false };

function keyEvent(key: string, modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
  return { key, code, repeat: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
}

describe('shortcut recorder state', () => {
  test('previews modifiers and clears the preview when they are released', () => {
    const pressed = updateShortcutRecordingState(emptyState, keyEvent('Control', { ctrlKey: true, shiftKey: true }), 'keydown', 2, { macModifiers: false });
    expect(pressed.livePreview).toBe('mod+shift');
    expect(updateShortcutRecordingState(pressed, keyEvent('Control'), 'keyup', 2, { macModifiers: false }).livePreview).toBeNull();
  });

  test('previews macOS Control as its own modifier', () => {
    const control = updateShortcutRecordingState(emptyState, keyEvent('Control', { ctrlKey: true, shiftKey: true }), 'keydown', 2, { macModifiers: true });
    const meta = updateShortcutRecordingState(emptyState, keyEvent('Meta', { metaKey: true }), 'keydown', 2, { macModifiers: true });
    expect(control.livePreview).toBe('ctrl+shift');
    expect(meta.livePreview).toBe('mod');
  });

  test('records macOS Control as ctrl and Command as mod', () => {
    expect(updateShortcutRecordingState(emptyState, keyEvent('s', { ctrlKey: true }), 'keydown', 2, { macModifiers: true }).chords).toEqual(['ctrl+s']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('s', { metaKey: true }), 'keydown', 2, { macModifiers: true }).chords).toEqual(['mod+s']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('s', { ctrlKey: true, metaKey: true }), 'keydown', 2, { macModifiers: true }).chords).toEqual(['mod+ctrl+s']);
  });

  test('records Control as the primary modifier elsewhere and Meta as Super', () => {
    expect(updateShortcutRecordingState(emptyState, keyEvent('s', { ctrlKey: true }), 'keydown', 2, { macModifiers: false }).chords).toEqual(['mod+s']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('s', { metaKey: true }), 'keydown', 2, { macModifiers: false }).chords).toEqual(['super+s']);
  });

  test('waits after the first chord and settles when a second chord is recorded', () => {
    const first = updateShortcutRecordingState(emptyState, keyEvent('s', { ctrlKey: true }), 'keydown', 2, { macModifiers: false });
    const second = updateShortcutRecordingState(first, keyEvent('p'), 'keydown', 2, { macModifiers: false });
    const third = updateShortcutRecordingState(second, keyEvent('x'), 'keydown', 2, { macModifiers: false });
    expect(first.chords).toEqual(['mod+s']);
    expect(first.settled).toBe(false);
    expect(second.chords).toEqual(['mod+s', 'p']);
    expect(second.settled).toBe(true);
    expect(third.chords).toEqual(['x']);
    expect(third.settled).toBe(false);
  });

  test('settles a single chord for timeout and Confirm validation', () => {
    const waiting = updateShortcutRecordingState(emptyState, keyEvent('s', { ctrlKey: true }), 'keydown', 2, { macModifiers: false });
    expect(settleShortcutRecordingState(waiting)).toEqual({ chords: ['mod+s'], livePreview: null, settled: true });
  });

  test('records at most three simultaneous keys', () => {
    const previous = { chords: ['mod+k'], livePreview: null, settled: false };
    const threeKeys = updateShortcutRecordingState(
      previous,
      keyEvent('s', { ctrlKey: true, shiftKey: true }),
      'keydown',
      2,
      { macModifiers: false },
    );
    const fourKeys = updateShortcutRecordingState(
      previous,
      keyEvent('s', { ctrlKey: true, metaKey: true, shiftKey: true }),
      'keydown',
      2,
      { macModifiers: false },
    );

    expect(threeKeys.chords).toEqual(['mod+k', 'mod+shift+s']);
    expect(fourKeys.chords).toEqual(['mod+k']);
  });

  test('ignores repeat and IME events', () => {
    expect(updateShortcutRecordingState(emptyState, { ...keyEvent('k', { ctrlKey: true }), repeat: true }, 'keydown', 2, { macModifiers: false })).toEqual(emptyState);
    expect(updateShortcutRecordingState(emptyState, { ...keyEvent('k', { ctrlKey: true }), isComposing: true }, 'keydown', 2, { macModifiers: false })).toEqual(emptyState);
  });

  test('records Enter and Escape while Backspace removes the final chord', () => {
    const state = { chords: ['mod+k', 'mod+p'], livePreview: null, settled: true };
    expect(updateShortcutRecordingState(emptyState, keyEvent('Enter'), 'keydown', 2, { macModifiers: false }).chords).toEqual(['enter']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('Escape'), 'keydown', 2, { macModifiers: false }).chords).toEqual(['escape']);
    expect(updateShortcutRecordingState(state, keyEvent('Backspace'), 'keydown', 2, { macModifiers: false }).chords).toEqual(['mod+k']);
    expect(updateShortcutRecordingState(state, keyEvent('Backspace'), 'keydown', 2, { macModifiers: false }).settled).toBe(false);
    expect(updateShortcutRecordingState({ chords: ['mod+k'], livePreview: null, settled: false }, keyEvent('Backspace'), 'keydown', 2, { macModifiers: false })).toEqual(emptyState);
  });
});

describe('bare modifier recording', () => {
  test('maps a released modifier to its platform chord', () => {
    expect(modifierKeyUpToCombo(keyEvent('Control'), { macModifiers: false })).toBe('mod');
    expect(modifierKeyUpToCombo(keyEvent('Control'), { macModifiers: true })).toBe('ctrl');
    expect(modifierKeyUpToCombo(keyEvent('Meta'), { macModifiers: true })).toBe('mod');
    expect(modifierKeyUpToCombo(keyEvent('Shift'), { macModifiers: false })).toBe('shift');
    expect(modifierKeyUpToCombo(keyEvent('s', { ctrlKey: true }), { macModifiers: true })).toBeNull();
  });

  test('keeps the other held modifiers in the released-modifier chord', () => {
    expect(modifierKeyUpToCombo(keyEvent('Control', { shiftKey: true }), { macModifiers: true })).toBe('ctrl+shift');
    expect(modifierKeyUpToCombo(keyEvent('Control', { metaKey: true }), { macModifiers: true })).toBe('mod+ctrl');
  });
});
