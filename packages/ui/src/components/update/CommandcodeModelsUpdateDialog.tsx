import * as React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { CommandcodeModelsUpdateNotice } from '@/lib/commandcodeModelsUpdate';

interface CommandcodeModelsUpdateDialogProps {
  open: boolean;
  notice: CommandcodeModelsUpdateNotice | null;
  isRestarting: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onRestart: () => void;
}

/**
 * Shows what the scheduled model list update changed. Styled after the update
 * dialog so both read as the same surface: details on top, the action that
 * applies the change at the bottom.
 */
export const CommandcodeModelsUpdateDialog: React.FC<CommandcodeModelsUpdateDialogProps> = ({
  open,
  notice,
  isRestarting,
  error,
  onOpenChange,
  onRestart,
}) => {
  const { t } = useI18n();

  if (!notice) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={isRestarting ? undefined : onOpenChange}>
      <DialogContent className="max-w-3xl p-5 bg-background border-[var(--interactive-border)]" showCloseButton={true}>
        <div className="flex items-center mb-1">
          <DialogTitle className="flex items-center gap-2.5">
            <Icon name="refresh" className="h-5 w-5 text-[var(--primary-base)]" />
            <span className="text-lg font-semibold text-foreground">
              {t('commandcodeModelsUpdate.dialog.title')}
            </span>
          </DialogTitle>
          {notice.commit ? (
            <span className="ml-3 font-mono text-sm text-muted-foreground">
              {notice.commit}
            </span>
          ) : null}
        </div>

        <p className="typography-meta text-muted-foreground">
          {t('commandcodeModelsUpdate.dialog.description')}
        </p>

        <div className="mt-3 rounded-lg border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/20 overflow-hidden">
          <ScrollableOverlay className="max-h-[420px] p-0" fillContainer={false}>
            <div className="p-4 space-y-3">
              <div className="typography-ui-label font-medium text-foreground break-words">
                {notice.summary}
              </div>
              <div className="typography-markdown-body text-foreground leading-relaxed break-words [&_a]:!text-[var(--primary-base)] [&_a]:!no-underline [&_a:hover]:!underline">
                <SimpleMarkdownRenderer content={notice.details} disableLinkSafety={true} enableFileReferences={false} />
              </div>
            </div>
          </ScrollableOverlay>
        </div>

        {error ? (
          <div className="mt-4 p-3 bg-[var(--status-error-background)] border border-[var(--status-error-border)] rounded-lg">
            <p className="text-sm text-[var(--status-error)]">{error}</p>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isRestarting}
          >
            {t('commandcodeModelsUpdate.dialog.actions.close')}
          </Button>
          <Button
            onClick={onRestart}
            disabled={isRestarting}
          >
            {isRestarting ? (
              <Icon name="loader" className="h-4 w-4 animate-spin" />
            ) : (
              <Icon name="restart" className="h-4 w-4" />
            )}
            {isRestarting
              ? t('commandcodeModelsUpdate.dialog.actions.restarting')
              : t('commandcodeModelsUpdate.dialog.actions.restart')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
