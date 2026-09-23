import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { setLoopFileEnabled, writeLoopFile, discoverLoops, normalizeLoopFileStem } from './loops.js';

const LOOP_LOCATIONS = new Set(['local', 'shared']);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const expandLeadingTilde = (value) => {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
};

const isValidTimezone = (value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const createScheduledTaskService = (dependencies) => {
  const {
    scheduledTasksRuntime,
    validateDirectoryPath,
  } = dependencies;

  const syncAndLocate = async (taskId) => {
    const tasks = await scheduledTasksRuntime.syncLoops();
    const normalizedTaskID = asNonEmptyString(taskId);
    if (!normalizedTaskID) throw new OpenChamberControlError('taskId is required', 400);
    const task = tasks.find((entry) => entry?.id === normalizedTaskID) || null;
    if (!task) throw new OpenChamberControlError('Task not found', 404);
    return { tasks, task };
  };

  const locationByLoopFile = () => {
    const byFile = new Map();
    for (const loop of discoverLoops()) {
      if (loop?.filePath && !byFile.has(loop.filePath)) {
        byFile.set(loop.filePath, loop.location);
      }
    }
    return byFile;
  };

  const list = async () => {
    const tasks = await scheduledTasksRuntime.syncLoops();
    const byFile = locationByLoopFile();
    return tasks.map((task) => ({
      ...task,
      ...(task?.loopFile && byFile.has(task.loopFile) ? { location: byFile.get(task.loopFile) } : {}),
    }));
  };

  const findLoopTask = async (taskId) => {
    const { task } = await syncAndLocate(taskId);
    if (!task.loopFile) throw new OpenChamberControlError('Task is not managed by a loop file', 400);
    if (!fs.existsSync(task.loopFile)) throw new OpenChamberControlError('Loop file not found', 404);
    return task;
  };

  const setLoopEnabled = async (taskId, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new OpenChamberControlError('enabled must be a boolean', 400);
    }
    const task = await findLoopTask(taskId);
    try {
      if (!setLoopFileEnabled(task.loopFile, enabled)) {
        throw new OpenChamberControlError('Loop file must be valid before changing its enabled state', 400);
      }
    } catch (error) {
      if (error instanceof OpenChamberControlError) throw error;
      const message = error instanceof Error ? error.message : 'Failed to update loop file';
      throw new OpenChamberControlError(message, 500);
    }
    const tasks = await scheduledTasksRuntime.syncLoops();
    return tasks.find((entry) => entry.id === task.id) || null;
  };

  const removeLoopFile = async (taskId) => {
    const task = await findLoopTask(taskId);
    try {
      fs.unlinkSync(task.loopFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete loop file';
      throw new OpenChamberControlError(message, 500);
    }
    return scheduledTasksRuntime.syncLoops();
  };

  const validateNewTask = async ({ location, task }) => {
    if (!LOOP_LOCATIONS.has(location)) {
      throw new OpenChamberControlError('location must be local or shared', 400);
    }
    if (!task || typeof task !== 'object') {
      throw new OpenChamberControlError('task payload is required', 400);
    }
    let stem;
    try {
      stem = normalizeLoopFileStem(task.name);
    } catch (error) {
      throw new OpenChamberControlError(error instanceof Error ? error.message : 'name is required', 400);
    }

    const execution = task.execution && typeof task.execution === 'object' ? task.execution : {};
    const prompt = asNonEmptyString(execution.prompt);
    if (!prompt) throw new OpenChamberControlError('execution.prompt is required', 400);
    const providerID = asNonEmptyString(execution.providerID);
    const modelID = asNonEmptyString(execution.modelID);
    if (!providerID || !modelID) {
      throw new OpenChamberControlError('execution model must be provider/model', 400);
    }
    const agent = asNonEmptyString(execution.agent);

    let directory;
    const rawDirectory = asNonEmptyString(execution.directory);
    if (rawDirectory) {
      const expanded = expandLeadingTilde(rawDirectory);
      if (typeof validateDirectoryPath === 'function') {
        const validated = await validateDirectoryPath(expanded);
        if (!validated?.ok) {
          throw new OpenChamberControlError(validated?.error || 'Invalid directory', 400);
        }
        directory = validated.directory || expanded;
      } else {
        directory = expanded;
      }
    }

    const schedule = task.schedule && typeof task.schedule === 'object' ? task.schedule : {};
    if (asNonEmptyString(schedule.kind) && schedule.kind !== 'cron') {
      throw new OpenChamberControlError('Loop files support cron schedules only', 400);
    }
    const cron = asNonEmptyString(schedule.cron);
    if (!cron) throw new OpenChamberControlError('schedule.cron is required', 400);
    try {
      CronExpressionParser.parse(cron, { currentDate: new Date() });
    } catch {
      throw new OpenChamberControlError('schedule.cron is invalid', 400);
    }
    const timezone = asNonEmptyString(schedule.timezone);
    if (timezone && !isValidTimezone(timezone)) {
      throw new OpenChamberControlError('schedule.timezone must be a valid IANA timezone', 400);
    }

    return {
      location,
      stem,
      enabled: typeof task.enabled === 'boolean' ? task.enabled : true,
      frontmatter: {
        schedule: cron,
        enabled: typeof task.enabled === 'boolean' ? task.enabled : true,
        model: `${providerID}/${modelID}`,
        ...(agent ? { agent } : {}),
        ...(timezone ? { timezone } : {}),
        ...(directory ? { directory: rawDirectory } : {}),
      },
      body: prompt,
    };
  };

  const create = async ({ location, task }) => {
    const validated = await validateNewTask({ location, task });
    let written;
    try {
      written = writeLoopFile({
        location: validated.location,
        name: validated.stem,
        frontmatter: validated.frontmatter,
        body: validated.body,
      });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new OpenChamberControlError(`A loop named "${validated.stem}" already exists`, 409);
      }
      const message = error instanceof Error ? error.message : 'Failed to create loop file';
      const statusCode = /required|invalid|must be|unknown loop location/i.test(message) ? 400 : 500;
      throw new OpenChamberControlError(message, statusCode);
    }
    const tasks = await scheduledTasksRuntime.syncLoops();
    const created = tasks.find((entry) => entry?.id === `loop:${written.name}`) || null;
    return { task: created, created: true };
  };

  const run = async (taskId) => {
    const { task } = await syncAndLocate(taskId);
    const result = await scheduledTasksRuntime.runNow(task.id);
    if (result.running || result.queued) {
      throw new OpenChamberControlError(result.error || 'Task already running', 409);
    }
    if (result.skipped) throw new OpenChamberControlError('Task not found or disabled', 404);
    if (!result.ok) {
      throw new OpenChamberControlError(result.error || 'Task run failed', 500, { task: result.task });
    }
    return {
      task: result.task,
      sessionId: result.sessionID,
      ...(typeof result.persistError === 'string' && result.persistError.trim()
        ? { persistError: result.persistError.trim() }
        : {}),
    };
  };

  const status = async () => {
    if (typeof scheduledTasksRuntime.getStatus === 'function') {
      return scheduledTasksRuntime.getStatus();
    }
    return {
      hasEnabledScheduledTasks: false,
      hasRunningScheduledTasks: false,
      enabledScheduledTasksCount: 0,
      runningScheduledTasksCount: 0,
    };
  };

  return {
    list,
    create,
    run,
    setLoopEnabled,
    removeLoopFile,
    status,
  };
};
