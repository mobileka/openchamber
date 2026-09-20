import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { requestControlAction } from './cli-control.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const assertRequired = (value, flagName) => {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    throw new TunnelCliError(`Missing required ${flagName}.`, EXIT_CODE.USAGE_ERROR);
  }
  return normalized;
};

const formatGoal = (execution) => {
  if (execution?.goalEnabled !== true) return 'goal:no';
  return Number.isFinite(execution.goalTokenBudget)
    ? `goal:yes budget:${execution.goalTokenBudget}`
    : 'goal:yes';
};

const formatSchedule = (schedule) => {
  if (!schedule || typeof schedule !== 'object') return 'unknown';
  if (schedule.kind === 'daily') return `daily ${Array.isArray(schedule.times) ? schedule.times.join(',') : ''}`.trim();
  if (schedule.kind === 'weekly') return `weekly days:${Array.isArray(schedule.weekdays) ? schedule.weekdays.join(',') : ''} time:${Array.isArray(schedule.times) ? schedule.times.join(',') : ''}`;
  if (schedule.kind === 'once') return `once ${schedule.date || ''} ${schedule.time || ''}`.trim();
  if (schedule.kind === 'cron') return `cron ${schedule.cron || ''}`.trim();
  return schedule.kind || 'unknown';
};

const outputTasks = (options, tasks) => {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  if (isJsonMode(options)) {
    printJson({ tasks: normalizedTasks });
    return;
  }
  if (isQuietMode(options)) {
    for (const task of normalizedTasks) {
      process.stdout.write(`${task.id} enabled:${task.enabled === false ? 'no' : 'yes'} ${formatGoal(task.execution)} status:${task.state?.lastStatus || 'idle'} ${formatSchedule(task.schedule)} ${task.name || ''}\n`);
    }
    return;
  }

  clackIntro('Scheduled Tasks');
  if (normalizedTasks.length === 0) {
    logStatus('info', 'No scheduled tasks found');
    clackOutro('0 tasks');
    return;
  }
  for (const task of normalizedTasks) {
    const status = task.enabled === false ? 'warning' : 'success';
    const detail = `id: ${task.id}; ${formatGoal(task.execution)}; status: ${task.state?.lastStatus || 'idle'}; ${formatSchedule(task.schedule)}`;
    logStatus(status, task.name || task.id, detail);
  }
  clackOutro(`${normalizedTasks.length} task(s)`);
};

async function scheduleCommand(options = {}, action = 'help') {
  if (action === 'help') {
    process.stdout.write(`OpenChamber Schedule Commands\n\nUSAGE:\n  openchamber schedule status [OPTIONS]\n  openchamber schedule list [OPTIONS]\n  openchamber schedule create --location <local|shared> --name <name> --prompt <prompt> --model <provider/model> --cron <expr> [OPTIONS]\n  openchamber schedule run --task <taskId> [OPTIONS]\n  openchamber schedule delete --task <taskId> [OPTIONS]\n  openchamber schedule enable --task <taskId> [OPTIONS]\n  openchamber schedule disable --task <taskId> [OPTIONS]\n\nOPTIONS:\n  --location <local|shared>   Loop location (required for create; shared loops sync via git)\n  -p, --port <port>       OpenChamber server port\n  --timezone <zone>       IANA timezone for created tasks\n  --agent <id>            Agent to use when running task\n  --dir <path>            Working directory for runs (defaults to the synced repo root)\n  --disabled              Create task disabled\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print concise output\n`);
    return;
  }

  const port = await resolveTargetPort(options);

  if (action === 'status') {
    const body = await requestControlAction(port, 'schedule.status', {}, options);
    if (isJsonMode(options)) {
      printJson(body || {});
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`enabled:${body?.enabledScheduledTasksCount ?? 0} running:${body?.runningScheduledTasksCount ?? 0}\n`);
      return;
    }
    clackIntro('Scheduled Task Status');
    logStatus(body?.hasEnabledScheduledTasks ? 'success' : 'info', `enabled: ${body?.enabledScheduledTasksCount ?? 0}`);
    logStatus(body?.hasRunningScheduledTasks ? 'success' : 'info', `running: ${body?.runningScheduledTasksCount ?? 0}`);
    clackOutro('status loaded');
    return;
  }

  if (action === 'list') {
    const body = await requestControlAction(port, 'schedule.list', {}, options);
    outputTasks(options, body?.tasks);
    return;
  }

  if (action === 'create') {
    const input = {
      location: options.location,
      name: options.name,
      prompt: options.prompt,
      model: options.model,
      cron: options.cron,
      timezone: options.timezone,
      agent: options.agent,
      directory: options.directory,
      disabled: options.disabled === true,
    };
    const body = await requestControlAction(port, 'schedule.create', input, options);
    if (isJsonMode(options)) {
      printJson({ task: body?.task, created: body?.created === true });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${body?.task?.id || ''}\n`);
      return;
    }
    clackIntro('Scheduled Task Created');
    logStatus('success', body?.task?.name || options.name, `id: ${body?.task?.id || 'unknown'}; ${formatGoal(body?.task?.execution)}; ${formatSchedule(body?.task?.schedule)}`);
    clackOutro('created');
    return;
  }

  if (action === 'run') {
    const taskID = assertRequired(options.task, '--task');
    const body = await requestControlAction(port, 'schedule.run', { taskId: taskID }, options);
    if (isJsonMode(options)) {
      printJson({ task: body?.task, sessionId: body?.sessionId });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${body?.sessionId || ''}\n`);
      return;
    }
    clackIntro('Scheduled Task Run');
    logStatus('success', body?.task?.name || taskID, `session: ${body?.sessionId || 'unknown'}`);
    clackOutro('started');
    return;
  }

  if (action === 'delete') {
    const taskID = assertRequired(options.task, '--task');
    const body = await requestControlAction(port, 'schedule.delete', { taskId: taskID }, options);
    if (isJsonMode(options)) {
      printJson({ deleted: true, tasks: body?.tasks || [] });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`deleted ${taskID}\n`);
      return;
    }
    clackIntro('Scheduled Task Deleted');
    logStatus('success', `deleted ${taskID}`);
    clackOutro('deleted');
    return;
  }

  if (action === 'enable' || action === 'disable') {
    const taskID = assertRequired(options.task, '--task');
    const enabled = action === 'enable';
    const { task } = await requestControlAction(port, 'schedule.toggle', { taskId: taskID, disabled: !enabled }, options);
    if (isJsonMode(options)) {
      printJson({ task, enabled });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${taskID} enabled:${enabled ? 'yes' : 'no'}\n`);
      return;
    }
    clackIntro(enabled ? 'Scheduled Task Enabled' : 'Scheduled Task Disabled');
    logStatus('success', task?.name || taskID, `enabled: ${enabled ? 'yes' : 'no'}`);
    clackOutro(enabled ? 'enabled' : 'disabled');
    return;
  }

  throw new TunnelCliError(`Unknown schedule command '${action}'.`, EXIT_CODE.USAGE_ERROR);
}

export { scheduleCommand, formatGoal };
