import React from 'react';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  modifierKeyUpToCombo,
  updateShortcutRecordingState,
  type RecordingKeyboardEvent,
  type ShortcutRecordingState,
} from './shortcutRecorder';

interface ShortcutRecorderFieldProps {
  value: ShortcutRecordingState;
  onChange: (state: ShortcutRecordingState) => void;
  /** Allow a bare-modifier chord (the `prefixStyle` actions) via key-up. */
  prefixStyle?: boolean;
  fieldRef?: React.RefObject<HTMLDivElement | null>;
  /** Accessible name for the focusable capture area. */
  ariaLabel?: string;
  className?: string;
}

const toRecordingEvent = (event: React.KeyboardEvent<HTMLDivElement>): RecordingKeyboardEvent => ({
  altKey: event.altKey,
  code: event.nativeEvent.code,
  ctrlKey: event.ctrlKey,
  isComposing: event.nativeEvent.isComposing,
  key: event.key,
  metaKey: event.metaKey,
  repeat: event.repeat,
  shiftKey: event.shiftKey,
});

export const ShortcutRecorderField: React.FC<ShortcutRecorderFieldProps> = ({
  value,
  onChange,
  prefixStyle = false,
  fieldRef,
  ariaLabel,
  className,
}) => {
  const { t } = useI18n();

  const handleEvent = (event: React.KeyboardEvent<HTMLDivElement>, phase: 'keydown' | 'keyup') => {
    event.preventDefault();
    event.stopPropagation();

    const recordingEvent = toRecordingEvent(event);
    if (phase === 'keyup' && prefixStyle && value.chords.length === 0) {
      const modifierCombo = modifierKeyUpToCombo(recordingEvent);
      if (modifierCombo) {
        onChange({ chords: [modifierCombo], livePreview: null, settled: true });
        return;
      }
    }
    const nextState = updateShortcutRecordingState(value, recordingEvent, phase);
    onChange(prefixStyle && nextState.chords.length > 1 ? value : nextState);
  };

  return (
    <div
      className={cn(
        'flex min-h-28 items-center justify-center rounded-lg border border-border bg-[var(--surface-elevated)] px-4 py-5 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      tabIndex={0}
      ref={fieldRef}
      aria-label={ariaLabel}
      onKeyDown={(event) => handleEvent(event, 'keydown')}
      onKeyUp={(event) => handleEvent(event, 'keyup')}
      onBlur={() => onChange({ ...value, livePreview: null })}
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        {value.chords.map((chord, index) => (
          <kbd key={`${chord}-${index}`} className="rounded-md border border-border bg-muted px-3 py-2 typography-ui-label font-mono text-foreground">
            {formatShortcutForDisplay(chord)}
          </kbd>
        ))}
        {value.livePreview ? (
          <kbd className="rounded-md border border-dashed border-border bg-muted px-3 py-2 typography-ui-label font-mono text-muted-foreground">
            {formatShortcutForDisplay(value.livePreview)}
          </kbd>
        ) : null}
        {value.chords.length === 0 && !value.livePreview ? (
          <span className="typography-ui-label text-muted-foreground">
            {t('settings.openchamber.keyboardShortcuts.dialog.recording')}
          </span>
        ) : null}
      </div>
    </div>
  );
};
