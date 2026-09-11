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
import { normalizeCombo, type ShortcutCombo } from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { ShortcutRecorderField } from './ShortcutRecorderField';
import { EMPTY_SHORTCUT_RECORDING, type ShortcutRecordingState } from './shortcutRecorder';

interface ShortcutSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Apply the recorded combination as the active shortcut filter. */
  onApply: (combo: ShortcutCombo) => void;
}

export const ShortcutSearchDialog: React.FC<ShortcutSearchDialogProps> = ({
  open,
  onOpenChange,
  onApply,
}) => {
  const { t } = useI18n();
  const [recording, setRecording] = React.useState<ShortcutRecordingState>(EMPTY_SHORTCUT_RECORDING);
  const recordingRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setRecording(EMPTY_SHORTCUT_RECORDING);
    recordingRef.current?.focus();
  }, [open]);

  const combo = normalizeCombo(recording.chords.join(' '));
  const apply = () => {
    if (!combo) return;
    onApply(combo);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" initialFocus={recordingRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('settings.openchamber.keyboardShortcuts.search.dialog.title')}</DialogTitle>
          <DialogDescription>{t('settings.openchamber.keyboardShortcuts.search.dialog.instructions')}</DialogDescription>
        </DialogHeader>

        <ShortcutRecorderField
          value={recording}
          onChange={setRecording}
          fieldRef={recordingRef}
          ariaLabel={t('settings.openchamber.keyboardShortcuts.search.dialog.instructions')}
        />

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button type="button" size="sm" disabled={!combo} onClick={apply}>
            {t('settings.openchamber.keyboardShortcuts.actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
