import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { useUIStore } from '@/stores/useUIStore';
import { formatTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  createScheduledTaskFile,
  deleteScheduledTaskFile,
  fetchScheduledTasks,
  fetchScheduledTasksStatus,
  runScheduledTaskNow,
  setScheduledTaskEnabled,
  subscribeScheduledTaskChanges,
  type LoopLocation,
  type ScheduledTask,
  type ScheduledTaskStatus,
} from '@/lib/scheduledTasksApi';
import { ScheduledTaskEditorDialog } from './ScheduledTaskEditorDialog';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import { canonicalizeTimezone } from '@/lib/timezones';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';

const scheduleTimes = (task: ScheduledTask): string[] => {
  const raw = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : (task.schedule.time ? [task.schedule.time] : []);
  const valid = raw.filter((value) => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
  return Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
};

const formatSchedule = (task: ScheduledTask, t: ReturnType<typeof useI18n>['t']): string => {
  const timesLabel = scheduleTimes(task).join(', ') || '--:--';
  const formatWeekday = (value: number) => {
    if (value === 0) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun');
    if (value === 1) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon');
    if (value === 2) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue');
    if (value === 3) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed');
    if (value === 4) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu');
    if (value === 5) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri');
    if (value === 6) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat');
    return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown');
  };
  if (task.schedule.kind === 'daily') {
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.dailyWithTimezone', {
        time: timesLabel,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.daily', { time: timesLabel });
  }
  if (task.schedule.kind === 'weekly') {
    const days = Array.isArray(task.schedule.weekdays)
      ? task.schedule.weekdays.map((value) => formatWeekday(value)).join(', ')
      : '';
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone', {
        days,
        time: timesLabel,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.weekly', { days, time: timesLabel });
  }
  if (task.schedule.kind === 'once') {
    const date = typeof task.schedule.date === 'string' && task.schedule.date.trim().length > 0
      ? task.schedule.date
      : t('sessions.scheduledTasks.dialog.schedule.unknownDate');
    const time = typeof task.schedule.time === 'string' && task.schedule.time.trim().length > 0
      ? task.schedule.time
      : '--:--';
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.onceWithTimezone', {
        date,
        time,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.once', { date, time });
  }
  if (task.schedule.timezone) {
    return t('sessions.scheduledTasks.dialog.schedule.cronWithTimezone', {
      cron: task.schedule.cron || '',
      timezone: canonicalizeTimezone(task.schedule.timezone),
    });
  }
  return t('sessions.scheduledTasks.dialog.schedule.cron', { cron: task.schedule.cron || '' });
};

const formatClockTime = (value: number | undefined, timeFormatPreference: TimeFormatPreference): string => {
  if (!value || !Number.isFinite(value)) {
    return '';
  }
  return formatTimeForPreference(value, timeFormatPreference);
};

const formatRelativeTime = (value: number | undefined, t: ReturnType<typeof useI18n>['t']): string => {
  if (!value || !Number.isFinite(value)) {
    return '';
  }
  const diff = value - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff >= 0;
  if (abs < minute) {
    return future ? t('sessions.scheduledTasks.dialog.relativeTime.inLessThanOneMinute') : t('sessions.scheduledTasks.dialog.relativeTime.justNow');
  }
  if (abs < hour) {
    const m = Math.round(abs / minute);
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inMinutes', { count: m })
      : t('sessions.scheduledTasks.dialog.relativeTime.minutesAgo', { count: m });
  }
  if (abs < day) {
    const h = Math.floor(abs / hour);
    const m = Math.round((abs % hour) / minute);
    const body = m > 0 ? `${h}h ${m}m` : `${h}h`;
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
      : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
  }
  const d = Math.floor(abs / day);
  const h = Math.round((abs % day) / hour);
  const body = h > 0 ? `${d}d ${h}h` : `${d}d`;
  return future
    ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
    : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
};

type StatusTone = 'success' | 'error' | 'warning' | 'muted';

const STATUS_META: Record<
  ScheduledTaskStatus,
  {
    tone: StatusTone;
    Icon: IconName;
    spin?: boolean;
  }
> = {
  success: { tone: 'success', Icon: 'checkbox-circle' },
  error: { tone: 'error', Icon: 'error-warning' },
  running: { tone: 'warning', Icon: 'loader-4', spin: true },
  idle: { tone: 'muted', Icon: 'pulse' },
};

const toneStyle = (tone: StatusTone): React.CSSProperties => {
  if (tone === 'muted') {
    return {};
  }
  return {
    color: `var(--status-${tone})`,
    backgroundColor: `var(--status-${tone}-background)`,
    borderColor: `var(--status-${tone}-border)`,
  };
};

const sortTasks = (tasks: ScheduledTask[]): ScheduledTask[] => {
  const next = tasks.slice();
  next.sort((a, b) => {
    if (a.enabled !== b.enabled) {
      return a.enabled ? -1 : 1;
    }
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) {
      return byName;
    }
    return (a.state?.nextRunAt || Number.MAX_SAFE_INTEGER) - (b.state?.nextRunAt || Number.MAX_SAFE_INTEGER);
  });
  return next;
};

export function ScheduledTasksDialog() {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const isMobile = useUIStore((state) => state.isMobile);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const effectiveDirectory = useEffectiveDirectory();

  const [tasks, setTasks] = React.useState<ScheduledTask[]>([]);
  // Start in loading state so the first frame after open shows the spinner,
  // not an empty flash before the fetch effect runs.
  const [loading, setLoading] = React.useState(true);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [defaultDirectory, setDefaultDirectory] = React.useState<string | null>(null);
  const [mutatingTaskID, setMutatingTaskID] = React.useState<string | null>(null);

  const reloadTasks = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      setTasks(sortTasks(await fetchScheduledTasks()));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.loadFailed'));
      if (!options?.silent) {
        setTasks([]);
      }
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [t]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    void reloadTasks();
    // The exact default run directory is server-resolved; show it verbatim in
    // the editor instead of a vague label.
    fetchScheduledTasksStatus()
      .then((status) => setDefaultDirectory(status.defaultRunDirectory ?? null))
      .catch(() => setDefaultDirectory(null));
  }, [open, reloadTasks]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    let timeoutID: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
      timeoutID = setTimeout(() => {
        void reloadTasks({ silent: true });
      }, 400);
    };
    const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'scheduled-task-ran') {
        return;
      }
      scheduleReload();
    });
    const unsubscribeChanges = subscribeScheduledTaskChanges(() => {
      scheduleReload();
    });
    return () => {
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
      unsubscribeEvents();
      unsubscribeChanges();
    };
  }, [open, reloadTasks]);

  const handleSaveTask = React.useCallback(async (input: { location: LoopLocation; task: Partial<ScheduledTask> }) => {
    await createScheduledTaskFile(input.location, input.task);
    await reloadTasks();
    toast.success(t('sessions.scheduledTasks.dialog.toast.saved'));
  }, [reloadTasks, t]);

  const handleToggleEnabled = React.useCallback(async (task: ScheduledTask, enabled: boolean) => {
    setMutatingTaskID(task.id);
    setTasks((prev) => prev.map((item) => (item.id === task.id ? { ...item, enabled } : item)));
    try {
      await setScheduledTaskEnabled(task.id, enabled);
      await reloadTasks({ silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.updateFailed'));
      await reloadTasks({ silent: true });
    } finally {
      setMutatingTaskID(null);
    }
  }, [reloadTasks, t]);

  const handleDeleteTask = React.useCallback(async (task: ScheduledTask) => {
    const confirmed = window.confirm(
      t('sessions.scheduledTasks.dialog.confirm.deleteLoopFile', { taskName: task.name }));
    if (!confirmed) {
      return;
    }

    setMutatingTaskID(task.id);
    try {
      await deleteScheduledTaskFile(task.id);
      await reloadTasks({ silent: true });
      toast.success(t('sessions.scheduledTasks.dialog.toast.deleted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.deleteFailed'));
    } finally {
      setMutatingTaskID(null);
    }
  }, [reloadTasks, t]);

  const handleEditTask = React.useCallback(async (task: ScheduledTask) => {
    if (!task.loopFile) {
      return;
    }
    // The file editor is the context panel's file surface, which is keyed and
    // rooted on the effective directory; the loop's own run directory would
    // put the tab in a directory bucket nothing renders.
    const anchor = effectiveDirectory || homeDirectory || null;
    if (!anchor) {
      return;
    }
    // Loop files live outside every workspace by design; mint the outside-file
    // grant first like every other outside-file flow, or the read 403s.
    await ensureOutsideFileGrantForDesktop(task.loopFile, anchor);
    setOpen(false);
    useFilesViewTabsStore.getState().setSelectedPath(anchor, task.loopFile, { allowOutsideRoot: true, editableOutsideRoot: true });
    useUIStore.getState().openContextFile(anchor, task.loopFile);
  }, [effectiveDirectory, homeDirectory, setOpen]);

  const handleRunNow = React.useCallback(async (task: ScheduledTask) => {
    setMutatingTaskID(task.id);
    try {
      const { sessionId, persistError } = await runScheduledTaskNow(task.id);
      await Promise.all([
        reloadTasks({ silent: true }),
        refreshGlobalSessions(),
      ]);
      if (persistError) {
        toast.warning(t('sessions.scheduledTasks.dialog.toast.startedPersistWarning'));
      } else {
        toast.success(t('sessions.scheduledTasks.dialog.toast.started'));
      }
      if (sessionId) {
        // Jump straight into the started session; selecting it also closes
        // this surface (MainLayout closes surfaces on session selection).
        useSessionUIStore.getState().setCurrentSession(sessionId, task.runDirectory ?? null);
        }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.runFailed'));
    } finally {
      setMutatingTaskID(null);
    }
  }, [reloadTasks, t]);

  const openNewTaskEditor = () => {
    setEditorOpen(true);
  };

  // Display the server-resolved default with the home dir shortened to `~`.
  const defaultDirectoryLabel = React.useMemo(() => {
    if (!defaultDirectory) {
      return null;
    }
    const home = homeDirectory || '';
    if (home && (defaultDirectory === home || defaultDirectory.startsWith(`${home}/`))) {
      return `~${defaultDirectory.slice(home.length)}`;
    }
    return defaultDirectory;
  }, [defaultDirectory, homeDirectory]);

  const locationBadge = (task: ScheduledTask) => {
    if (task.location !== 'local' && task.location !== 'shared') {
      return null;
    }
    return (
      <span className="inline-flex shrink-0 items-center rounded-full border border-border px-1.5 py-0.5 typography-micro font-medium text-muted-foreground">
        {task.location === 'local'
          ? t('sessions.scheduledTasks.dialog.badge.local')
          : t('sessions.scheduledTasks.dialog.badge.shared')}
      </span>
    );
  };

  const tasksList = (
      <div className="min-h-[280px]">
      {loading ? (
        <div className="flex items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="h-4 w-4 animate-spin" /> {t('sessions.scheduledTasks.dialog.loading')}
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">
          {t('sessions.scheduledTasks.dialog.empty.noTasks')}
        </div>
      ) : (
        <div className="space-y-2.5">
          {tasks.map((task) => {
            const isBusy = mutatingTaskID === task.id;
            const status = (task.state?.lastStatus || 'idle') as ScheduledTaskStatus;
            const meta = STATUS_META[status];
            const statusLabel = status === 'success'
              ? t('sessions.scheduledTasks.dialog.status.success')
              : status === 'error'
                ? t('sessions.scheduledTasks.dialog.status.error')
                : status === 'running'
                  ? t('sessions.scheduledTasks.dialog.status.running')
                  : t('sessions.scheduledTasks.dialog.status.idle');
            const nextAt = task.state?.nextRunAt;
            const lastAt = task.state?.lastRunAt;

            return (
              <div
                key={task.id}
                className={cn(
                  'rounded-lg border border-border p-4 transition-opacity',
                )}
              >
                <div className={cn('min-w-0', !task.enabled && 'opacity-60')}>
                  <div className="flex items-center gap-2">
                    <div className="typography-ui-header min-w-0 flex-1 truncate font-semibold text-foreground">
                      {task.name}
                    </div>
                    {locationBadge(task)}
                  </div>
                  <div className="typography-micro truncate text-muted-foreground">
                    {formatSchedule(task, t)}
                  </div>
                  {task.loopFile ? (
                    <div
                      className="typography-micro truncate text-muted-foreground/70"
                      title={task.loopFile}
                    >
                      {t('sessions.scheduledTasks.dialog.loopFile.note', { file: task.loopFile })}
                    </div>
                  ) : null}
                </div>

                <div className={cn('mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 typography-micro text-muted-foreground', !task.enabled && 'opacity-60')}>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="timer" className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">{t('sessions.scheduledTasks.dialog.nextRun.label')}</span>
                    {nextAt ? (
                      <>
                        <span className="text-foreground">{formatRelativeTime(nextAt, t)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatClockTime(nextAt, timeFormatPreference)}</span>
                      </>
                    ) : (
                      <span>—</span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="history" className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">{t('sessions.scheduledTasks.dialog.lastRun.label')}</span>
                    {status === 'running' ? (
                      <span
                        className="inline-flex items-center gap-1"
                        style={{ color: 'var(--status-warning)' }}
                      >
                        <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
                        {t('sessions.scheduledTasks.dialog.lastRun.runningNow')}
                      </span>
                    ) : lastAt ? (
                      <>
                        {meta.tone !== 'muted' ? (
                          <span
                            className="inline-flex items-center gap-1"
                            style={{ color: `var(--status-${meta.tone})` }}
                          >
                            <Icon name={meta.Icon} className="h-3.5 w-3.5" />
                            {statusLabel}
                          </span>
                        ) : null}
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatRelativeTime(lastAt, t)}</span>
                      </>
                    ) : (
                      <span>{t('sessions.scheduledTasks.dialog.lastRun.never')}</span>
                    )}
                  </span>
                </div>

                {task.state?.lastError ? (
                  <div
                    className={cn('mt-3 flex items-start gap-2 rounded-md border p-2 typography-micro', !task.enabled && 'opacity-60')}
                    style={toneStyle('error')}
                  >
                    <Icon name="error-warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{task.state.lastError}</span>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <label
                    className={cn(
                      'inline-flex cursor-pointer items-center gap-2 typography-micro font-medium',
                      task.enabled ? 'text-foreground' : 'text-muted-foreground',
                      isBusy && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Checkbox
                      checked={task.enabled}
                      onChange={(enabled) => void handleToggleEnabled(task, enabled)}
                      ariaLabel={task.enabled
                        ? t('sessions.scheduledTasks.dialog.taskToggle.pauseAria', { taskName: task.name })
                        : t('sessions.scheduledTasks.dialog.taskToggle.enableAria', { taskName: task.name })}
                      disabled={isBusy}
                    />
                    {task.enabled ? t('sessions.scheduledTasks.dialog.taskToggle.enabled') : t('sessions.scheduledTasks.dialog.taskToggle.paused')}
                  </label>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRunNow(task)}
                      disabled={isBusy}
                    >
                      <Icon name="play" className="h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.runNow')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEditTask(task)}
                      disabled={isBusy || !task.loopFile}
                      aria-label={t('sessions.scheduledTasks.dialog.actions.editAria', { taskName: task.name })}
                    >
                      <Icon name="edit-2" className="h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.edit')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleDeleteTask(task)}
                      disabled={isBusy}
                      aria-label={t('sessions.scheduledTasks.dialog.actions.deleteAria', { taskName: task.name })}
                    >
                      <Icon name="delete-bin" className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
  );

  const tasksContent = (
    <div className="space-y-4">
      {tasksList}
    </div>
  );

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel
          open={open}
          title={t('sessions.scheduledTasks.dialog.title')}
          onClose={() => setOpen(false)}
          contentMaxHeightClassName="max-h-[min(80vh,640px)]"
          renderHeader={(closeButton) => (
            <div className="flex flex-col gap-1 border-b border-border/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="typography-ui-label font-semibold text-foreground">{t('sessions.scheduledTasks.dialog.title')}</h2>
                {closeButton}
              </div>
              <p className="typography-micro text-muted-foreground">
                {t('sessions.scheduledTasks.dialog.description')}
              </p>
            </div>
          )}
          footer={(
            <Button
              className="w-full"
              onClick={openNewTaskEditor}
            >
              <Icon name="add" className="mr-1 h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.newTask')}
            </Button>
          )}
        >
          {tasksContent}
        </MobileOverlayPanel>
      ) : open ? (
        // Full-page surface replacing the chat area (mounted inside <main>).
        // The app Header shows the surface title, so the page itself only
        // carries the close affordance.
        <div className="absolute inset-0 z-10 flex flex-col bg-background">
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Pages have no close button: you leave by picking a session,
                a draft, or another surface in the sidebar. */}
            <div className="flex items-center px-6 pt-3">
              <Button size="sm" onClick={openNewTaskEditor}>
                <Icon name="add" className="mr-1 h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.newTask')}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              <div className="mx-auto w-full max-w-3xl">
                {tasksContent}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ScheduledTaskEditorDialog
        open={editorOpen}
        task={null}
        defaultDirectoryLabel={defaultDirectoryLabel}
        onOpenChange={setEditorOpen}
        onSave={handleSaveTask}
      />
    </>
  );
}
