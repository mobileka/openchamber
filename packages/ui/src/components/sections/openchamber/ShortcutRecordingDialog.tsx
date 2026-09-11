import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  formatShortcutForDisplay,
  getShortcutBindingConflicts,
  isRiskyBrowserShortcut,
  normalizeCombo,
  type ShortcutActionId,
  type ShortcutBindingConflict,
  type ShortcutCombo,
  type CustomizableShortcutAction,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { ShortcutRecorderField } from './ShortcutRecorderField';
import {
  EMPTY_SHORTCUT_RECORDING,
  SECOND_CHORD_TIMEOUT_MS,
  settleShortcutRecordingState,
  type ShortcutRecordingState,
} from './shortcutRecorder';

interface ShortcutRecordingDialogProps {
  action: CustomizableShortcutAction | null;
  overrides: Record<string, string>;
  onSave: (
    actionId: ShortcutActionId,
    combo: ShortcutCombo,
    replaceActionId?: ShortcutActionId,
  ) => void;
  onOpenChange: (open: boolean) => void;
}

function isCustomizableConflict(
  conflict: ShortcutBindingConflict,
): conflict is ShortcutBindingConflict & { action: CustomizableShortcutAction } {
  return conflict.action.customizable;
}

export const ShortcutRecordingDialog: React.FC<ShortcutRecordingDialogProps> = ({
  action,
  overrides,
  onSave,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const actionLabel = (shortcut: CustomizableShortcutAction) => t(shortcut.settingsLabelKey);
  const conflictActionLabel = (conflict: ShortcutBindingConflict) => (
    conflict.action.customizable
      ? actionLabel(conflict.action)
      : formatShortcutForDisplay(conflict.action.defaultBinding)
  );
  const [recording, setRecording] = React.useState<ShortcutRecordingState>(EMPTY_SHORTCUT_RECORDING);
  const recordingRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!action) return;
    setRecording(EMPTY_SHORTCUT_RECORDING);
    recordingRef.current?.focus();
  }, [action]);

  const waitingForSecondChord = recording.chords.length === 1 && !recording.settled;

  React.useEffect(() => {
    if (!waitingForSecondChord) return;
    const timeout = window.setTimeout(
      () => setRecording(settleShortcutRecordingState),
      SECOND_CHORD_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [waitingForSecondChord]);

  const combo = normalizeCombo(recording.chords.join(' '));
  const conflicts = React.useMemo(
    () => action && combo ? getShortcutBindingConflicts(action.id, combo, overrides) : [],
    [action, combo, overrides],
  );
  const protectedConflict = conflicts.find((conflict) => (
    !conflict.action.customizable && conflict.kind !== 'contextual-prefix'
  ));
  const customizableConflicts = conflicts.filter(isCustomizableConflict);
  const prefixConflict = customizableConflicts.find((conflict) => conflict.kind === 'prefix');
  const exactConflict = customizableConflicts.find((conflict) => conflict.kind === 'exact');
  const contextualPrefixConflict = conflicts.find((conflict) => conflict.kind === 'contextual-prefix');

  const close = () => onOpenChange(false);
  const confirm = () => {
    if (!recording.settled) setRecording(settleShortcutRecordingState);
    if (!action || !combo || protectedConflict || prefixConflict) return;
    onSave(action.id, combo, exactConflict?.action.id);
    close();
  };

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open, eventDetails) => {
        if (!open) {
          eventDetails.cancel();
        }
      }}
    >
      <DialogContent className="max-w-md" initialFocus={recordingRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {action ? t('settings.openchamber.keyboardShortcuts.dialog.title', { action: actionLabel(action) }) : ''}
          </DialogTitle>
          <DialogDescription>{t('settings.openchamber.keyboardShortcuts.dialog.instructions')}</DialogDescription>
        </DialogHeader>

        <ShortcutRecorderField
          value={recording}
          onChange={setRecording}
          prefixStyle={Boolean(action && 'prefixStyle' in action && action.prefixStyle)}
          fieldRef={recordingRef}
        />

        {recording.settled && protectedConflict ? (
          <p className="typography-meta text-[var(--status-error)]">
            {t('settings.openchamber.keyboardShortcuts.error.internalConflict')}
          </p>
        ) : recording.settled && prefixConflict ? (
          <p className="typography-meta text-[var(--status-error)]">
            {t('settings.openchamber.keyboardShortcuts.error.prefixConflict', { action: actionLabel(prefixConflict.action) })}
          </p>
        ) : null}
        {recording.settled && exactConflict && !protectedConflict && !prefixConflict ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.openchamber.keyboardShortcuts.error.exactConflict', { action: actionLabel(exactConflict.action) })}
          </p>
        ) : null}
        {recording.settled && contextualPrefixConflict && !protectedConflict && !prefixConflict ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.openchamber.keyboardShortcuts.warning.contextualPrefix', {
              action: conflictActionLabel(contextualPrefixConflict),
            })}
          </p>
        ) : null}
        {recording.settled && combo && isRiskyBrowserShortcut(combo) ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.openchamber.keyboardShortcuts.warning.riskyBrowserShortcut')}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!combo || (recording.settled && (Boolean(protectedConflict) || Boolean(prefixConflict)))}
            onClick={confirm}
          >
            {t('settings.openchamber.keyboardShortcuts.actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
