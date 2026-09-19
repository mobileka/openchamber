import * as React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
  dismissCommandcodeModelsUpdateNotice,
  fetchCommandcodeModelsUpdateNotice,
  restartOpenChamber,
  type CommandcodeModelsUpdateNotice as ModelsUpdateNotice,
} from '@/lib/commandcodeModelsUpdate';
import { CommandcodeModelsUpdateDialog } from './CommandcodeModelsUpdateDialog';

const NOTICE_TOAST_ID = 'commandcode-models-update';
const RESTART_DELAY_SECONDS = 5;

interface NoticeToastBodyProps {
  summary: string;
  onView: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

const NoticeToastBody: React.FC<NoticeToastBodyProps> = ({ summary, onView, onRestart, onDismiss }) => {
  const { t } = useI18n();

  return (
    <div className="space-y-2">
      <div className="typography-meta text-muted-foreground break-words">{summary}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" onClick={onView}>
          {t('commandcodeModelsUpdate.toast.actions.view')}
        </Button>
        <Button size="xs" onClick={onRestart}>
          {t('commandcodeModelsUpdate.toast.actions.restart')}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          {t('commandcodeModelsUpdate.toast.actions.dismiss')}
        </Button>
      </div>
    </div>
  );
};

/**
 * Shows the model list update the scheduled `/commandcode_update_models` run
 * published: a toast with View, Restart, and Dismiss, where View opens the
 * details dialog. The notice lives on the server until dismissed or the app is
 * restarted through it, so it survives a reload and follows the user across
 * clients.
 */
export const CommandcodeModelsUpdateNotice: React.FC = () => {
  const { t } = useI18n();
  const [notice, setNotice] = React.useState<ModelsUpdateNotice | null>(null);
  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  const [isRestarting, setIsRestarting] = React.useState(false);
  const [restartError, setRestartError] = React.useState<string | null>(null);

  const loadNotice = React.useCallback(async (runtimeKey: string) => {
    try {
      const next = await fetchCommandcodeModelsUpdateNotice();
      if (runtimeKey === getRuntimeKey()) {
        setNotice(next);
      }
    } catch {
      // A failed read keeps whatever is on screen. An unreachable server must
      // not look like "no update".
    }
  }, []);

  React.useEffect(() => {
    if (isVSCodeRuntime()) return;

    void loadNotice(getRuntimeKey());
    const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'commandcode-models-updated') return;
      void loadNotice(getRuntimeKey());
    });
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(({ runtimeKey }) => {
      setNotice(null);
      void loadNotice(runtimeKey);
    });

    return () => {
      unsubscribeEvents();
      unsubscribeRuntime();
    };
  }, [loadNotice]);

  const runRestart = React.useCallback(async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    setRestartError(null);

    try {
      await restartOpenChamber(RESTART_DELAY_SECONDS);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('commandcodeModelsUpdate.toast.restartFailed');
      setIsRestarting(false);
      setRestartError(message);
      toast.error(t('commandcodeModelsUpdate.toast.restartFailed'), { description: message });
      return;
    }

    // The host is restarting on its own now. Clear the notice so it does not
    // come back with the next launch.
    toast.dismiss(NOTICE_TOAST_ID);
    toast.message(t('commandcodeModelsUpdate.toast.restarting'), { duration: Infinity });
    setNotice(null);
    setIsDialogOpen(false);
    void dismissCommandcodeModelsUpdateNotice().catch(() => undefined);
  }, [isRestarting, t]);

  const runDismiss = React.useCallback(async () => {
    try {
      await dismissCommandcodeModelsUpdateNotice();
    } catch (error) {
      toast.error(t('commandcodeModelsUpdate.toast.dismissFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }

    toast.dismiss(NOTICE_TOAST_ID);
    setNotice(null);
    setIsDialogOpen(false);
  }, [t]);

  const openDialog = React.useCallback(() => {
    setRestartError(null);
    setIsDialogOpen(true);
  }, []);

  React.useEffect(() => {
    if (!notice) {
      toast.dismiss(NOTICE_TOAST_ID);
      return;
    }

    toast.message(t('commandcodeModelsUpdate.toast.title'), {
      id: NOTICE_TOAST_ID,
      duration: Infinity,
      description: (
        <NoticeToastBody
          summary={notice.summary}
          onView={openDialog}
          onRestart={runRestart}
          onDismiss={runDismiss}
        />
      ),
    });
  }, [notice, openDialog, runDismiss, runRestart, t]);

  return (
    <CommandcodeModelsUpdateDialog
      open={isDialogOpen}
      notice={notice}
      isRestarting={isRestarting}
      error={restartError}
      onOpenChange={setIsDialogOpen}
      onRestart={runRestart}
    />
  );
};
