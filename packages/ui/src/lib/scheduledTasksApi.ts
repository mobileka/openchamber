import { runtimeFetch } from './runtime-fetch';

export type ScheduledTaskStatus = 'idle' | 'running' | 'success' | 'error';

export type LoopLocation = 'local' | 'shared';

export type ScheduledTask = {
  id: string;
  name: string;
  enabled: boolean;
  /** Absolute path of the `.agents/loops/*.md` file driving this task. */
  loopFile?: string;
  /** Which fixed loops dir drives this task. Attached by the list endpoint. */
  location?: LoopLocation;
  /** Effective execution directory (loop `directory` or the default). Attached by the list endpoint. */
  runDirectory?: string;
  schedule: {
    kind: 'daily' | 'weekly' | 'once' | 'cron';
    times?: string[];
    time?: string;
    date?: string;
    weekdays?: number[];
    cron?: string;
    timezone?: string;
  };
  execution: {
    prompt: string;
    providerID: string;
    modelID: string;
    variant?: string;
    agent?: string;
    directory?: string;
    goalEnabled?: boolean;
    goalTokenBudget?: number;
    permissionAutoAccept?: boolean;
  };
  state: {
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
    lastStatus?: ScheduledTaskStatus;
    lastError?: string;
    lastDurationMs?: number;
    lastSessionId?: string;
    nextRunAt?: number;
  };
};

const parseErrorMessage = async (response: Response, fallback: string) => {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
};

const ensureTaskID = (taskID: string): string => {
  const trimmed = typeof taskID === 'string' ? taskID.trim() : '';
  if (!trimmed) {
    throw new Error('taskId is required');
  }
  return trimmed;
};

export const fetchScheduledTasks = async (): Promise<ScheduledTask[]> => {
  const response = await runtimeFetch('/api/openchamber/scheduled-tasks');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load scheduled tasks'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    return [];
  }
  return parsed.tasks as ScheduledTask[];
};

export const createScheduledTaskFile = async (
  location: LoopLocation,
  task: Partial<ScheduledTask>,
): Promise<ScheduledTask | null> => {
  const response = await runtimeFetch('/api/openchamber/scheduled-tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ location, task }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to create scheduled task'));
  }
  const parsed = await response.json().catch(() => null);
  return (parsed?.task as ScheduledTask | undefined) ?? null;
};

export const setScheduledTaskEnabled = async (taskID: string, enabled: boolean): Promise<void> => {
  const safeTaskID = ensureTaskID(taskID);
  const response = await runtimeFetch(`/api/openchamber/scheduled-tasks/${encodeURIComponent(safeTaskID)}/enabled`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to update loop task'));
  }
};

export const deleteScheduledTaskFile = async (taskID: string): Promise<void> => {
  const safeTaskID = ensureTaskID(taskID);
  const response = await runtimeFetch(`/api/openchamber/scheduled-tasks/${encodeURIComponent(safeTaskID)}`, {
    method: 'DELETE',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to delete loop file'));
  }
};

export const runScheduledTaskNow = async (
  taskID: string,
): Promise<{ sessionId?: string; persistError?: string }> => {
  const safeTaskID = ensureTaskID(taskID);
  const response = await runtimeFetch(`/api/openchamber/scheduled-tasks/${encodeURIComponent(safeTaskID)}/run`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to run scheduled task'));
  }
  const parsed = await response.json().catch(() => null);
  return {
    sessionId: typeof parsed?.sessionId === 'string' && parsed.sessionId.length > 0 ? parsed.sessionId : undefined,
    persistError: typeof parsed?.persistError === 'string' && parsed.persistError.trim().length > 0
      ? parsed.persistError.trim()
      : undefined,
  };
};

export type SchedulerStatus = {
  hasEnabledScheduledTasks: boolean;
  hasRunningScheduledTasks: boolean;
  enabledScheduledTasksCount: number;
  runningScheduledTasksCount: number;
  /** Server-resolved default run directory (absolute). */
  defaultRunDirectory?: string;
};

export const fetchScheduledTasksStatus = async (): Promise<SchedulerStatus> => {
  const response = await runtimeFetch('/api/openchamber/scheduled-tasks/status');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load scheduler status'));
  }
  const parsed = await response.json().catch(() => null);
  return {
    hasEnabledScheduledTasks: parsed?.hasEnabledScheduledTasks === true,
    hasRunningScheduledTasks: parsed?.hasRunningScheduledTasks === true,
    enabledScheduledTasksCount: typeof parsed?.enabledScheduledTasksCount === 'number'
      ? parsed.enabledScheduledTasksCount
      : 0,
    runningScheduledTasksCount: typeof parsed?.runningScheduledTasksCount === 'number'
      ? parsed.runningScheduledTasksCount
      : 0,
    ...(typeof parsed?.defaultRunDirectory === 'string' && parsed.defaultRunDirectory.length > 0
      ? { defaultRunDirectory: parsed.defaultRunDirectory }
      : {}),
  };
};

type ScheduledTasksChangeListener = () => void;

const changeListeners = new Set<ScheduledTasksChangeListener>();

export const subscribeScheduledTaskChanges = (listener: ScheduledTasksChangeListener): (() => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};

/**
 * Re-sync loops server-side (a file save reconciles on list) and tell open
 * scheduled-tasks surfaces to reload. Used by FilesView after saving a file
 * under either loops dir.
 */
export const refreshScheduledTasks = async (): Promise<ScheduledTask[]> => {
  const tasks = await fetchScheduledTasks();
  for (const listener of Array.from(changeListeners)) {
    try {
      listener();
    } catch {
      // A failing listener must not break the refresh for the rest.
    }
  }
  return tasks;
};
