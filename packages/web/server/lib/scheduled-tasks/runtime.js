import { OpenCode } from '@opencode/client';
import { DateTime } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import { expandSnippets } from '../opencode/snippets.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { discoverLoops, resolveDefaultRunDirectory } from './loops.js';

/**
 * Project-free scheduled-task runtime.
 *
 * Loops are discovered from the two fixed `.agents/loops` dirs (local +
 * shared) and reconciled into the single global state document
 * `$OPENCHAMBER_DATA_DIR/scheduled-tasks.json` (store id `scheduled-tasks`),
 * which is machine-local and never shared. There is no project connection:
 * every run executes in the loop's own `directory` frontmatter value, or in
 * the default run directory (the parent of $OPENCODE_CONFIG_DIR).
 */

const DEFAULT_GLOBAL_CONCURRENCY = 4;
const DEFAULT_MAX_RUN_MS = 30 * 60 * 1000;
const JITTER_MAX_MS = 2_000;
const TASK_TITLE_MAX_LENGTH = 120;
const TASK_DUE_SLACK_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Store id of the single global scheduled-tasks document. */
export const GLOBAL_SCHEDULED_TASKS_ID = 'scheduled-tasks';

const parseTimeParts = (time) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof time === 'string' ? time : '');
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};

const applyTimeToDate = (baseDateTime, time) => {
  const parsed = parseTimeParts(time);
  if (!parsed) {
    return null;
  }
  return baseDateTime.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0,
  });
};

const resolveScheduleTimes = (schedule) => {
  const times = [];
  if (Array.isArray(schedule?.times)) {
    for (const candidate of schedule.times) {
      if (typeof candidate === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(candidate)) {
        times.push(candidate);
      }
    }
  }
  if (times.length === 0 && typeof schedule?.time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time)) {
    times.push(schedule.time);
  }
  return Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
};

const weekdayAsZeroBased = (dateTime) => {
  if (!dateTime || typeof dateTime.weekday !== 'number') {
    return null;
  }
  return dateTime.weekday % 7;
};

const safeErrorMessage = (error, maxLength = 2_000) => {
  const raw = error instanceof Error
    ? (error.message || String(error))
    : String(error ?? 'Unknown error');
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'Unknown error';
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

export const parseScheduledCommandPrompt = (prompt) => {
  if (typeof prompt !== 'string') {
    return null;
  }

  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0] || '';
  const [head, ...tail] = firstLine.split(/\s+/);
  const commandName = (head || '').slice(1).trim();
  if (!commandName) {
    return null;
  }

  return {
    command: commandName,
    arguments: tail.join(' ').trim(),
  };
};

export const expandCommandGoalObjective = (template, argumentsText) => {
  if (typeof template !== 'string' || !template.trim()) {
    return null;
  }

  const rawArguments = String(argumentsText ?? '');
  if (template.includes('$ARGUMENTS')) {
    return template.replaceAll('$ARGUMENTS', rawArguments);
  }

  const positions = [...template.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  if (positions.length > 0) {
    const parsedArguments = [...rawArguments.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
    const lastPosition = Math.max(...positions);
    return template.replace(/\$(\d+)/g, (_match, value) => {
      const position = Number(value);
      return position === lastPosition
        ? parsedArguments.slice(position - 1).join(' ')
        : (parsedArguments[position - 1] ?? '');
    });
  }

  return rawArguments ? `${template}\n\n${rawArguments}` : template;
};

export const computeNextRunAt = (task, nowMs = Date.now()) => {
  if (!task?.enabled) {
    return null;
  }

  const schedule = task.schedule;
  if (!schedule || typeof schedule !== 'object') {
    return null;
  }

  const zone = typeof schedule.timezone === 'string' && schedule.timezone.trim().length > 0
    ? schedule.timezone.trim()
    : DateTime.local().zoneName;

  const now = DateTime.fromMillis(nowMs, { zone });
  if (!now.isValid) {
    return null;
  }

  if (schedule.kind === 'daily') {
    const times = resolveScheduleTimes(schedule);
    if (times.length === 0) {
      return null;
    }
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (const time of times) {
      const candidateToday = applyTimeToDate(now, time);
      if (!candidateToday || !candidateToday.isValid) {
        continue;
      }
      if (candidateToday > minAllowed) {
        return candidateToday.toMillis();
      }
    }

    const tomorrow = now.plus({ days: 1 });
    const firstTomorrow = applyTimeToDate(tomorrow, times[0]);
    return firstTomorrow?.isValid ? firstTomorrow.toMillis() : null;
  }

  if (schedule.kind === 'weekly') {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      return null;
    }
    const times = resolveScheduleTimes(schedule);
    if (times.length === 0) {
      return null;
    }
    const weekdaysSet = new Set(schedule.weekdays);
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
      const dayCandidate = now.plus({ days: dayOffset });
      const zeroBasedWeekday = weekdayAsZeroBased(dayCandidate);
      if (zeroBasedWeekday === null || !weekdaysSet.has(zeroBasedWeekday)) {
        continue;
      }
      for (const time of times) {
        const withTime = applyTimeToDate(dayCandidate, time);
        if (!withTime || !withTime.isValid) {
          continue;
        }
        if (withTime > minAllowed) {
          return withTime.toMillis();
        }
      }
    }
    return null;
  }

  if (schedule.kind === 'once') {
    if (typeof schedule.date !== 'string' || typeof schedule.time !== 'string') {
      return null;
    }

    const parsed = DateTime.fromFormat(
      `${schedule.date} ${schedule.time}`,
      'yyyy-LL-dd HH:mm',
      { zone },
    );
    if (!parsed.isValid) {
      return null;
    }

    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });
    if (parsed <= minAllowed) {
      return null;
    }

    return parsed.toMillis();
  }

  if (schedule.kind === 'cron') {
    try {
      const iterator = CronExpressionParser.parse(schedule.cron, {
        tz: zone,
        currentDate: new Date(nowMs),
      });
      return iterator.next().getTime();
    } catch {
      return null;
    }
  }

  return null;
};

export const formatScheduledSessionTitle = (task, nowMs = Date.now()) => {
  const timezone = typeof task?.schedule?.timezone === 'string' && task.schedule.timezone.trim().length > 0
    ? task.schedule.timezone.trim()
    : DateTime.local().zoneName;
  const stamp = DateTime.fromMillis(nowMs, { zone: timezone }).toFormat('yyyy-LL-dd HH:mm');
  const taskName = typeof task?.name === 'string' && task.name.trim().length > 0
    ? task.name.trim()
    : 'Scheduled task';
  const suffix = ` ${stamp}`;
  const maxTaskNameLength = Math.max(1, TASK_TITLE_MAX_LENGTH - suffix.length);
  const trimmedName = taskName.length > maxTaskNameLength
    ? taskName.slice(0, maxTaskNameLength)
    : taskName;
  return `${trimmedName}${suffix}`;
};

export const createScheduledTasksRuntime = (deps) => {
  const {
    projectConfigRuntime,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    emitTaskRunEvent,
    setSessionAutoAccept,
    sessionKnowledgeRuntime = null,
    // The goal record lives in OpenChamber's metadata store (OpenCode 2.x takes
    // session metadata only at create time); without it goal mode cannot run.
    persistSessionGoal = null,
    logger = console,
    maxGlobalConcurrency = DEFAULT_GLOBAL_CONCURRENCY,
    maxRunDurationMs = DEFAULT_MAX_RUN_MS,
    defaultRunDirectory,
  } = deps;

  const runDirectoryFallback = typeof defaultRunDirectory === 'string' && defaultRunDirectory.trim().length > 0
    ? defaultRunDirectory
    : resolveDefaultRunDirectory();

  // Every OpenCode route lives under /api in v2 and the client appends it, so
  // the client only wants the origin. Directory scoping is a request header.
  const openCodeOrigin = () => new URL(buildOpenCodeUrl('/api/info', '')).origin;
  const createScopedClient = (directory) => OpenCode.make({
    baseUrl: openCodeOrigin(),
    headers: {
      ...getOpenCodeAuthHeaders(),
      ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
    },
    fetch,
  });

  let started = false;
  const tasksByID = new Map();
  const timersByTaskID = new Map();
  const queuedTaskIDs = new Set();
  const runningTaskIDs = new Set();
  let runningCount = 0;
  const queue = [];

  const clearTimerForID = (taskID) => {
    const timer = timersByTaskID.get(taskID);
    if (timer) {
      clearTimeout(timer);
      timersByTaskID.delete(taskID);
    }
  };

  const scheduleTask = (taskID, nextRunAt) => {
    clearTimerForID(taskID);

    if (!started) {
      return;
    }

    if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) {
      return;
    }

    const delayBase = Math.max(0, Math.round(nextRunAt - Date.now()));
    const jitter = Math.floor(Math.random() * (JITTER_MAX_MS + 1));
    const delay = delayBase + jitter;
    const boundedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    const timer = setTimeout(async () => {
      if (delay > MAX_TIMER_DELAY_MS) {
        scheduleTask(taskID, nextRunAt);
        return;
      }

      clearTimerForID(taskID);
      const task = tasksByID.get(taskID);
      if (!task || !task.enabled) {
        return;
      }
      queueTaskRun(taskID, 'scheduled', nextRunAt);
      pumpQueue();
    }, boundedDelay);

    timersByTaskID.set(taskID, timer);
  };

  const updateInMemoryTask = (nextTask) => {
    if (!nextTask) {
      return;
    }
    tasksByID.set(nextTask.id, nextTask);
  };

  const syncTaskSchedule = async (task) => {
    if (!task) {
      return;
    }
    const nextRunAt = computeNextRunAt(task, Date.now());
    const statePatch = {
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
      updatedAt: Date.now(),
    };
    const result = await projectConfigRuntime.updateScheduledTaskState(GLOBAL_SCHEDULED_TASKS_ID, task.id, statePatch);
    if (result.task) {
      updateInMemoryTask(result.task);
      if (result.task.enabled && Number.isFinite(result.task.state?.nextRunAt)) {
        scheduleTask(result.task.id, result.task.state.nextRunAt);
      }
    }
  };

  const resolveRunDirectory = (task) => {
    const configured = typeof task?.execution?.directory === 'string' ? task.execution.directory.trim() : '';
    return configured || runDirectoryFallback;
  };

  const syncLoops = async () => {
    // Reconcile the `.agents/loops` definitions with the persisted task list:
    // loop files are authoritative while present, removed files unschedule
    // their task, and runtime state is preserved (see loops.js).
    const loops = await discoverLoops();
    const reconciled = await projectConfigRuntime.reconcileLoopTasks(GLOBAL_SCHEDULED_TASKS_ID, loops);

    // Attach the effective execution directory here so every consumer (API,
    // UI anchors) agrees with where runs actually execute. Unknown to older
    // readers, preserved verbatim like loopFile.
    const tasks = reconciled.map((task) => ({
      ...task,
      runDirectory: resolveRunDirectory(task),
    }));

    for (const [taskID] of tasksByID) {
      if (!tasks.some((task) => task.id === taskID)) {
        clearTimerForID(taskID);
        queuedTaskIDs.delete(taskID);
      }
    }
    tasksByID.clear();
    for (const task of tasks) {
      tasksByID.set(task.id, task);
    }

    for (const task of tasks) {
      await syncTaskSchedule(task);
    }

    return tasks;
  };

  const queueTaskRun = (taskID, reason, scheduledFor) => {
    if (queuedTaskIDs.has(taskID) || runningTaskIDs.has(taskID)) {
      return;
    }
    queuedTaskIDs.add(taskID);
    queue.push({
      taskID,
      reason,
      ...(Number.isFinite(scheduledFor) ? { scheduledFor } : {}),
    });
  };

  const canRunTask = () => runningCount < maxGlobalConcurrency;

  // Never allowed to fail the run: a task that executes without its
  // background is a lesser loss than a task that does not execute.
  const resolveKnowledge = (sessionID, runDirectory) => (sessionKnowledgeRuntime
    ? sessionKnowledgeRuntime.resolvePendingForSession(sessionID, runDirectory)
      .catch(() => ({ text: '', signature: '' }))
    : Promise.resolve({ text: '', signature: '' }));

  // Recorded only after the send is accepted, so a failed dispatch carries
  // the context again on the next run.
  const recordKnowledge = async (sessionID, runDirectory, knowledge) => {
    if (knowledge.text && sessionKnowledgeRuntime) {
      await sessionKnowledgeRuntime.recordDelivered(sessionID, runDirectory, knowledge.signature)
        .catch(() => undefined);
    }
  };

  const runPrompt = async ({ client, sessionID, runDirectory, task }) => {
    const knowledge = await resolveKnowledge(sessionID, runDirectory);

    // A v2 prompt carries a single authored text. Standing project context and
    // the goal briefing therefore travel as synthetic messages sent first, so
    // the model still reads the prompt against them exactly as before. A
    // synthetic message schedules execution unless `resume: false`: without
    // it the model would start on the briefing alone, before the task arrived.
    if (knowledge.text) {
      await client.session.synthetic({ sessionID, text: knowledge.text, resume: false });
    }
    if (task.execution.goalEnabled) {
      await client.session.synthetic({ sessionID, text: buildGoalIntroText(task.execution.goalTokenBudget), resume: false });
    }

    await client.session.prompt({
      sessionID,
      text: expandSnippets(task.execution.prompt, runDirectory),
    });

    await recordKnowledge(sessionID, runDirectory, knowledge);
  };

  const resolveScheduledCommand = async ({ client, runDirectory, task }) => {
    const parsed = parseScheduledCommandPrompt(task?.execution?.prompt);
    if (!parsed) {
      return null;
    }

    let commands = [];
    try {
      const response = await client.command.list({ location: { directory: runDirectory } });
      commands = Array.isArray(response?.data) ? response.data : [];
    } catch {
      return null;
    }

    // v2 CommandInfo carries no template, so a goal objective distilled from
    // the command body is no longer available; the goal falls back to the
    // prompt text, which expandCommandGoalObjective already handles.
    const command = commands.find((candidate) => candidate?.name === parsed.command);
    return command ? { ...parsed, template: command.template } : null;
  };

  const runScheduledCommand = async ({ client, runDirectory, sessionID, command }) => {
    // The command route takes no extra parts, so standing context goes in
    // first as a synthetic message that does not start execution.
    const knowledge = await resolveKnowledge(sessionID, runDirectory);
    if (knowledge.text) {
      await client.session.synthetic({ sessionID, text: knowledge.text, resume: false });
    }
    // Agent, model and variant are session properties in v2 and were already
    // set when the run created the session; the command body only carries text.
    await client.session.command({
      sessionID,
      // OpenCode 2.0.8 renamed the command body field `command` to `name`.
      name: command.command,
      text: command.arguments,
    });
    await recordKnowledge(sessionID, runDirectory, knowledge);
  };

  const runTaskWithWatchdog = async (task, reason) => {
    const startedAt = Date.now();
    const title = formatScheduledSessionTitle(task, startedAt);
    const runDirectory = resolveRunDirectory(task);

    if (typeof waitForOpenCodeReady === 'function') {
      await waitForOpenCodeReady(10_000, 250);
    }

    const baseUrl = openCodeOrigin();
    const authHeaders = getOpenCodeAuthHeaders();
    const client = createScopedClient(runDirectory);

    // Agent, model and variant belong to the session in v2: a scheduled run
    // fixes them here instead of repeating them on every prompt.
    const session = await client.session.create({
      title,
      location: { directory: runDirectory },
      model: {
        providerID: task.execution.providerID,
        id: task.execution.modelID,
        ...(task.execution.variant ? { variant: task.execution.variant } : {}),
      },
      ...(task.execution.agent ? { agent: task.execution.agent } : {}),
    });
    const sessionID = session?.id;
    if (!sessionID) {
      throw new Error('failed to create session');
    }

    try {
      emitTaskRunEvent?.({
        taskID: task.id,
        ranAt: startedAt,
        status: 'running',
        sessionID,
      });
    } catch {
    }

    if (task.execution.permissionAutoAccept && typeof setSessionAutoAccept === 'function') {
      // Enroll before the prompt goes out so the very first permission request
      // is already auto-approved. Enrollment failure must not kill the run —
      // the task still executes, permissions just wait for the user.
      try {
        await setSessionAutoAccept(sessionID, true, runDirectory);
      } catch (error) {
        logger.warn?.('[scheduled-tasks] failed to enable permission auto-accept for session', sessionID, error?.message ?? error);
      }
    }

    const scheduledCommand = await resolveScheduledCommand({ client, runDirectory, task });

    if (task.execution.goalEnabled) {
      const commandObjective = scheduledCommand
        ? expandCommandGoalObjective(scheduledCommand.template, scheduledCommand.arguments)
        : null;
      await createSessionGoal({
        baseUrl,
        authHeaders,
        persistSessionGoal,
        sessionID,
        directory: runDirectory,
        objective: commandObjective ?? expandSnippets(task.execution.prompt, runDirectory),
        tokenBudget: task.execution.goalTokenBudget,
        providerID: task.execution.providerID,
        modelID: task.execution.modelID,
        onWarning: (message, error) => console.warn(`[scheduled-tasks] ${message}:`, error?.message || error),
      });
    }

    if (scheduledCommand) {
      await runScheduledCommand({ client, runDirectory, sessionID, command: scheduledCommand });
    } else {
      await runPrompt({ client, sessionID, runDirectory, task });
    }

    const finishedAt = Date.now();
    return {
      sessionID,
      durationMs: Math.max(0, finishedAt - startedAt),
      reason,
      startedAt,
      finishedAt,
    };
  };

  const releaseRunningSlot = (taskID) => {
    runningTaskIDs.delete(taskID);
    runningCount = Math.max(0, runningCount - 1);
  };

  /**
   * Arm a timer only for a future occurrence. Scheduling a past nextRunAt
   * (delay 0 + jitter) re-enters the claim path immediately and can spin —
   * especially for once tasks where the claim cannot advance nextRunAt.
   */
  const scheduleFutureRun = (taskID, nextRunAt, fromMs = Date.now()) => {
    if (!Number.isFinite(nextRunAt)) {
      return false;
    }
    const base = Number.isFinite(fromMs) ? fromMs : Date.now();
    if (nextRunAt <= base) {
      return false;
    }
    scheduleTask(taskID, nextRunAt);
    return true;
  };

  const rearmFromTaskOrCompute = (taskID, fallbackTask, fromMs) => {
    const latest = tasksByID.get(taskID) || fallbackTask;
    if (!latest?.enabled) {
      return;
    }
    const base = Number.isFinite(fromMs) ? fromMs : Date.now();
    const persistedNext = latest.state?.nextRunAt;
    // Prefer a still-future persisted slot; never re-arm a past occurrence
    // (that created silent once-task loser loops and claim-failed retry spam).
    if (scheduleFutureRun(taskID, persistedNext, base)) {
      return;
    }
    const computedNext = computeNextRunAt(latest, base);
    scheduleFutureRun(taskID, computedNext, base);
  };

  const runTask = async (taskID, reason, scheduledFor) => {
    const task = tasksByID.get(taskID);
    // Manual runNow runs paused tasks too; only scheduled dispatches skip them.
    if (!task || (reason !== 'manual' && !task.enabled)) {
      return { ok: false, skipped: true };
    }

    if (runningTaskIDs.has(taskID)) {
      return { ok: false, running: true };
    }

    runningTaskIDs.add(taskID);
    runningCount += 1;

    // Every path that holds the running slot must exit through this finally so
    // lock timeouts / fs errors on claim, manual-start, or completion writes
    // cannot permanently stuck-run the task in this process.
    try {
      const runStartedAt = Date.now();

      // Scheduled dispatches must claim the occurrence in shared config
      // before creating a session. Two server instances (e.g. CLI serve +
      // desktop) each arm their own timer; without this claim both would run.
      if (reason === 'scheduled') {
        if (!Number.isFinite(scheduledFor)) {
          return { ok: false, skipped: true, reason: 'missing-scheduled-for' };
        }

        const nextAfterClaim = computeNextRunAt(task, Math.max(runStartedAt, scheduledFor + 1));
        const claimPatch = {
          lastScheduledFor: Math.round(scheduledFor),
          lastRunAt: runStartedAt,
          lastStatus: 'running',
          lastError: undefined,
          updatedAt: runStartedAt,
          // Always set nextRunAt so a past once-slot is cleared when there is
          // no following occurrence (omitting the key would leave the past value).
          nextRunAt: Number.isFinite(nextAfterClaim) ? nextAfterClaim : undefined,
        };

        // Duplicate protection is solely lastScheduledFor within slack of this
        // occurrence. Do not reject on advanced disk nextRunAt: lastScheduledFor
        // persists across days, so a second-instance sync inside TASK_DUE_SLACK_MS
        // would otherwise suppress every armed occurrence after the first.
        const canClaimOccurrence = (candidate) => {
          if (!candidate?.enabled) {
            return false;
          }
          const lastScheduledFor = candidate.state?.lastScheduledFor;
          if (
            Number.isFinite(lastScheduledFor)
            && Math.abs(lastScheduledFor - scheduledFor) <= TASK_DUE_SLACK_MS
          ) {
            return false;
          }
          return true;
        };

        let claimResult;
        try {
          if (typeof projectConfigRuntime.updateScheduledTaskStateIf === 'function') {
            claimResult = await projectConfigRuntime.updateScheduledTaskStateIf(
              GLOBAL_SCHEDULED_TASKS_ID,
              taskID,
              canClaimOccurrence,
              claimPatch,
            );
          } else {
            // Fallback for older test doubles: unconditional update (single-instance only).
            claimResult = await projectConfigRuntime.updateScheduledTaskState(GLOBAL_SCHEDULED_TASKS_ID, taskID, claimPatch);
            claimResult = { ...claimResult, updated: Boolean(claimResult?.task) };
          }
        } catch (claimError) {
          const message = safeErrorMessage(claimError);
          logger.warn?.('[ScheduledTasks] occurrence claim failed', {
            taskID,
            error: message,
          });
          rearmFromTaskOrCompute(taskID, task, Math.max(runStartedAt, scheduledFor + 1));

          // Best-effort record so once tasks are not left enabled-but-inert with
          // no UI signal. Do not clobber a winner that claimed this occurrence.
          const claimFailurePatch = {
            lastStatus: 'error',
            lastError: `Scheduled claim failed: ${message}`,
            updatedAt: Date.now(),
          };
          try {
            if (typeof projectConfigRuntime.updateScheduledTaskStateIf === 'function') {
              const recorded = await projectConfigRuntime.updateScheduledTaskStateIf(
                GLOBAL_SCHEDULED_TASKS_ID,
                taskID,
                (candidate) => {
                  const lastScheduledFor = candidate.state?.lastScheduledFor;
                  if (
                    Number.isFinite(lastScheduledFor)
                    && Math.abs(lastScheduledFor - scheduledFor) <= TASK_DUE_SLACK_MS
                  ) {
                    return false;
                  }
                  return true;
                },
                claimFailurePatch,
              );
              if (recorded.task) {
                updateInMemoryTask(recorded.task);
              }
            } else {
              const recorded = await projectConfigRuntime.updateScheduledTaskState(
                GLOBAL_SCHEDULED_TASKS_ID,
                taskID,
                claimFailurePatch,
              );
              if (recorded.task) {
                updateInMemoryTask(recorded.task);
              }
            }
          } catch {
            updateInMemoryTask({
              ...task,
              state: {
                ...(task.state || {}),
                ...claimFailurePatch,
              },
            });
          }

          return { ok: false, skipped: true, reason: 'claim-failed', error: message };
        }

        if (!claimResult?.updated) {
          if (claimResult?.task) {
            updateInMemoryTask(claimResult.task);
            // Loser must not schedule a past nextRunAt (once-task spin).
            rearmFromTaskOrCompute(
              taskID,
              claimResult.task,
              Math.max(Date.now(), scheduledFor + 1),
            );
          }
          return { ok: false, skipped: true, reason: 'occurrence-claimed' };
        }

        if (claimResult.task) {
          updateInMemoryTask(claimResult.task);
        }
      } else {
        try {
          const startResult = await projectConfigRuntime.updateScheduledTaskState(GLOBAL_SCHEDULED_TASKS_ID, taskID, {
            lastRunAt: runStartedAt,
            lastStatus: 'running',
            lastError: undefined,
            updatedAt: runStartedAt,
          });
          if (startResult.task) {
            updateInMemoryTask(startResult.task);
          }
        } catch (startError) {
          const message = safeErrorMessage(startError);
          logger.warn?.('[ScheduledTasks] manual start state write failed', {
            taskID,
            error: message,
          });
          return { ok: false, error: message, reason: 'start-state-failed' };
        }
      }

      let status = 'success';
      let sessionID;
      let durationMs = 0;
      let errorMessage;

      try {
        const runPromise = runTaskWithWatchdog(task, reason);
        let timeoutID;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutID = setTimeout(() => {
            reject(new Error('scheduled task run timed out'));
          }, maxRunDurationMs);
        });

        const result = await Promise.race([runPromise, timeoutPromise]).finally(() => {
          if (timeoutID) {
            clearTimeout(timeoutID);
          }
        });
        sessionID = result.sessionID;
        durationMs = result.durationMs;
        status = 'success';
        logger.info?.(
          '[ScheduledTasks] run completed',
          { taskID, status, reason, sessionID, durationMs }
        );
      } catch (error) {
        status = 'error';
        errorMessage = safeErrorMessage(error);
        logger.warn?.('[ScheduledTasks] run failed', {
          taskID,
          reason,
          status,
          error: errorMessage,
        });
      }

      const finishedAt = Date.now();
      if (!durationMs) {
        durationMs = Math.max(0, finishedAt - runStartedAt);
      }
      let latestTask = tasksByID.get(taskID) || task;
      const shouldConsumeOneTimeTask = latestTask?.schedule?.kind === 'once' && reason === 'scheduled';
      if (shouldConsumeOneTimeTask && latestTask?.enabled) {
        try {
          const consumed = await projectConfigRuntime.upsertScheduledTask(GLOBAL_SCHEDULED_TASKS_ID, {
            ...latestTask,
            enabled: false,
          });
          latestTask = consumed.task || latestTask;
          updateInMemoryTask(latestTask);
        } catch (consumeError) {
          logger.warn?.('[ScheduledTasks] failed to consume one-time task', {
            taskID,
            error: safeErrorMessage(consumeError),
          });
        }
      }

      const nextRunAt = computeNextRunAt(latestTask, finishedAt);

      const statePatch = {
        lastStatus: status,
        lastDurationMs: durationMs,
        lastError: status === 'error' ? errorMessage : undefined,
        lastSessionId: status === 'success' ? sessionID : undefined,
        nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
        updatedAt: finishedAt,
      };

      let stateResult = { task: null };
      try {
        stateResult = await projectConfigRuntime.updateScheduledTaskState(GLOBAL_SCHEDULED_TASKS_ID, taskID, statePatch);
        if (stateResult.task) {
          updateInMemoryTask(stateResult.task);
          if (stateResult.task.enabled) {
            scheduleFutureRun(
              taskID,
              stateResult.task.state?.nextRunAt,
              finishedAt,
            );
          }
        }
      } catch (persistError) {
        const message = safeErrorMessage(persistError);
        logger.warn?.('[ScheduledTasks] run completion state write failed', {
          taskID,
          reason,
          error: message,
        });

        // Keep in-memory status terminal so this process does not advertise
        // a stuck "running" task after the session already finished.
        const recoveredTask = {
          ...latestTask,
          state: {
            ...(latestTask.state || {}),
            lastStatus: status,
            lastDurationMs: durationMs,
            lastError: status === 'error' ? errorMessage : undefined,
            lastSessionId: status === 'success' ? sessionID : undefined,
            nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
            updatedAt: finishedAt,
          },
        };
        updateInMemoryTask(recoveredTask);

        // Best-effort single retry so persisted lastStatus does not stay 'running'.
        try {
          const retry = await projectConfigRuntime.updateScheduledTaskState(GLOBAL_SCHEDULED_TASKS_ID, taskID, statePatch);
          if (retry.task) {
            updateInMemoryTask(retry.task);
            stateResult = retry;
            if (retry.task.enabled) {
              scheduleFutureRun(taskID, retry.task.state?.nextRunAt, finishedAt);
            }
          }
        } catch (retryError) {
          logger.warn?.('[ScheduledTasks] run completion state retry failed', {
            taskID,
            reason,
            error: safeErrorMessage(retryError),
          });
          stateResult = { task: recoveredTask };
          rearmFromTaskOrCompute(taskID, recoveredTask, finishedAt);
        }

        // The session already ran — surface persist failure without treating a
        // successful dispatch as a hard run failure (manual runNow would 500).
        return {
          ok: status === 'success',
          status,
          sessionID,
          task: stateResult.task || recoveredTask,
          error: status === 'error' ? errorMessage : undefined,
          persistError: message,
          reason: 'completion-state-failed',
        };
      }

      try {
        emitTaskRunEvent?.({
          taskID,
          ranAt: finishedAt,
          status,
          ...(sessionID ? { sessionID } : {}),
        });
      } catch {
      }

      return {
        ok: status === 'success',
        status,
        sessionID,
        task: stateResult.task || null,
        error: errorMessage,
      };
    } finally {
      releaseRunningSlot(taskID);
    }
  };

  const pumpQueue = () => {
    if (!started) {
      return;
    }

    let consumed = false;
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!canRunTask()) {
        continue;
      }

      queue.splice(index, 1);
      index -= 1;

      queuedTaskIDs.delete(item.taskID);
      consumed = true;

      void runTask(item.taskID, item.reason, item.scheduledFor)
        .catch((error) => {
          logger.warn?.('[ScheduledTasks] queued run rejected', {
            taskID: item.taskID,
            reason: item.reason,
            error: safeErrorMessage(error),
          });
        })
        .finally(() => {
          pumpQueue();
        });
    }

    if (!consumed && queue.length > 0) {
      return;
    }
  };

  const runNow = async (taskID) => {
    if (runningTaskIDs.has(taskID)) {
      return {
        ok: false,
        running: true,
        error: 'task is already running',
      };
    }
    if (queuedTaskIDs.has(taskID)) {
      return {
        ok: false,
        queued: true,
        error: 'task is already queued',
      };
    }

    return runTask(taskID, 'manual');
  };

  const start = async () => {
    if (started) {
      return;
    }
    started = true;
    await syncLoops();
  };

  const stop = () => {
    if (!started) {
      return;
    }
    started = false;
    for (const timer of timersByTaskID.values()) {
      clearTimeout(timer);
    }
    timersByTaskID.clear();
    queuedTaskIDs.clear();
    queue.length = 0;
  };

  const getStatus = () => {
    let enabledCount = 0;
    for (const task of tasksByID.values()) {
      if (task?.enabled) {
        enabledCount += 1;
      }
    }

    const runningCountSnapshot = runningTaskIDs.size;
    return {
      hasEnabledScheduledTasks: enabledCount > 0,
      hasRunningScheduledTasks: runningCountSnapshot > 0,
      enabledScheduledTasksCount: enabledCount,
      runningScheduledTasksCount: runningCountSnapshot,
      defaultRunDirectory: runDirectoryFallback,
    };
  };

  return {
    start,
    stop,
    syncLoops,
    runNow,
    getStatus,
  };
};
