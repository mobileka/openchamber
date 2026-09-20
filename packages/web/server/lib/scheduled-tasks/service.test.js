import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { createScheduledTaskService } from './service.js';
import { registerScheduledTaskRoutes } from './routes.js';

let originalEnv;
let originalHomedir;

beforeEach(() => {
  originalEnv = process.env.OPENCODE_CONFIG_DIR;
  originalHomedir = os.homedir;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = originalEnv;
  }
  os.homedir = originalHomedir;
  vi.restoreAllMocks();
});

const createDirs = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-svc-'));
  const home = path.join(tempRoot, 'home');
  const configDir = path.join(tempRoot, 'opencode-config');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  process.env.OPENCODE_CONFIG_DIR = configDir;
  return {
    tempRoot,
    sharedDir: path.join(configDir, '.agents', 'loops'),
    localDir: path.join(home, '.agents', 'loops'),
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
};

const createService = (overrides = {}) => {
  const scheduledTasksRuntime = {
    syncLoops: vi.fn(async () => []),
    runNow: vi.fn(),
    getStatus: vi.fn(async () => ({})),
    ...(overrides.scheduledTasksRuntime || {}),
  };
  const service = createScheduledTaskService({
    scheduledTasksRuntime,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    ...(overrides.service || {}),
  });
  return { service, scheduledTasksRuntime };
};

const loopTask = {
  id: 'loop:daily-digest',
  name: 'daily-digest',
  enabled: true,
  loopFile: null,
  schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
  execution: { prompt: 'digest', providerID: 'openai', modelID: 'gpt-4.1' },
};

const writeSharedLoop = async (sharedDir, fileName, content) => {
  await mkdir(sharedDir, { recursive: true });
  const filePath = path.join(sharedDir, fileName);
  await writeFile(filePath, content, 'utf8');
  return filePath;
};

describe('scheduled-task service list', () => {
  it('syncs loops and attaches each file location', async () => {
    const ctx = await createDirs();
    try {
      const loopFilePath = await writeSharedLoop(ctx.sharedDir, 'daily-digest.md', `---
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---

Digest.
`);
      const { service, scheduledTasksRuntime } = createService({
        scheduledTasksRuntime: {
          syncLoops: vi.fn(async () => [{ ...loopTask, loopFile: loopFilePath }]),
        },
      });

      const tasks = await service.list();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].location).toBe('shared');
      expect(scheduledTasksRuntime.syncLoops).toHaveBeenCalledOnce();
    } finally {
      await ctx.cleanup();
    }
  });

  it('surfaces sync failure instead of returning a stale list', async () => {
    const syncError = new Error('loop sync failed');
    const { service } = createService({
      scheduledTasksRuntime: {
        syncLoops: vi.fn(async () => {
          throw syncError;
        }),
      },
    });

    await expect(service.list()).rejects.toBe(syncError);
  });
});

describe('scheduled-task loop-file mutations', () => {
  it('updates only enabled in loop frontmatter and syncs', async () => {
    const ctx = await createDirs();
    try {
      const loopFilePath = await writeSharedLoop(ctx.sharedDir, 'daily.md', `---
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
custom: keep-me
---

Run the digest.
`);
      const currentTask = { ...loopTask, loopFile: loopFilePath };
      const updatedTask = { ...currentTask, enabled: false };
      const syncLoops = vi.fn()
        .mockResolvedValueOnce([currentTask])
        .mockResolvedValueOnce([updatedTask]);
      const { service } = createService({ scheduledTasksRuntime: { syncLoops } });

      await expect(service.setLoopEnabled(currentTask.id, false)).resolves.toEqual(updatedTask);

      const content = await readFile(loopFilePath, 'utf8');
      expect(content).toContain('enabled: false');
      expect(content).toContain('custom: keep-me');
      expect(content).toContain('Run the digest.');
      expect(syncLoops).toHaveBeenCalledTimes(2);
    } finally {
      await ctx.cleanup();
    }
  });

  it('deletes the authoritative loop file and syncs the task away', async () => {
    const ctx = await createDirs();
    try {
      const loopFilePath = await writeSharedLoop(ctx.sharedDir, 'daily.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
Run.
`);
      const currentTask = { ...loopTask, loopFile: loopFilePath };
      const syncLoops = vi.fn()
        .mockResolvedValueOnce([currentTask])
        .mockResolvedValueOnce([]);
      const { service } = createService({ scheduledTasksRuntime: { syncLoops } });

      await expect(service.removeLoopFile(currentTask.id)).resolves.toEqual([]);
      await expect(readFile(loopFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(syncLoops).toHaveBeenCalledTimes(2);
    } finally {
      await ctx.cleanup();
    }
  });

  it('does not rewrite a malformed loop when toggling', async () => {
    const ctx = await createDirs();
    try {
      const loopFilePath = await writeSharedLoop(ctx.sharedDir, 'daily.md', '---\nschedule: "0 9 * * *"\n---\nRun.\n');
      const currentTask = { ...loopTask, loopFile: loopFilePath };
      const syncLoops = vi.fn(async () => [currentTask]);
      const { service } = createService({ scheduledTasksRuntime: { syncLoops } });

      await expect(service.setLoopEnabled(currentTask.id, false)).rejects.toMatchObject({ statusCode: 400 });
      await expect(readFile(loopFilePath, 'utf8')).resolves.toBe('---\nschedule: "0 9 * * *"\n---\nRun.\n');
      expect(syncLoops).toHaveBeenCalledOnce();
    } finally {
      await ctx.cleanup();
    }
  });

  it('404s unknown task ids', async () => {
    const { service } = createService({
      scheduledTasksRuntime: { syncLoops: vi.fn(async () => []) },
    });

    await expect(service.setLoopEnabled('loop:nope', true)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.removeLoopFile('loop:nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.run('loop:nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('scheduled-task service create', () => {
  const validTask = {
    name: 'daily-digest',
    enabled: true,
    schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
    execution: { prompt: 'Run the digest.', providerID: 'openai', modelID: 'gpt-5', agent: 'plan' },
  };

  it('writes a new loop file without a name key and returns the synced task', async () => {
    const ctx = await createDirs();
    try {
      const createdTask = { ...loopTask, loopFile: path.join(ctx.sharedDir, 'daily-digest.md') };
      const syncLoops = vi.fn(async () => [createdTask]);
      const { service } = createService({ scheduledTasksRuntime: { syncLoops } });

      const result = await service.create({ location: 'shared', task: validTask });

      expect(result.created).toBe(true);
      expect(result.task).toEqual(createdTask);
      const content = await readFile(path.join(ctx.sharedDir, 'daily-digest.md'), 'utf8');
      expect(content).toContain('Run the digest.');
      expect(content).toContain('openai/gpt-5');
      expect(content).not.toMatch(/^name:/m);
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects invalid payloads with 400', async () => {
    const { service } = createService();
    await expect(service.create({ location: 'nowhere', task: validTask }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create({ location: 'shared', task: { ...validTask, name: '  ' } }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create({ location: 'shared', task: { ...validTask, schedule: { kind: 'daily', time: '09:00' } } }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('cron') });
    await expect(service.create({ location: 'shared', task: { ...validTask, schedule: { kind: 'cron', cron: 'not a cron' } } }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create({
      location: 'shared',
      task: { ...validTask, schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'Mars/Olympus' } },
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects invalid directories with 400', async () => {
    const { service } = createService({
      service: {
        validateDirectoryPath: async () => ({ ok: false, error: 'Directory not found' }),
      },
    });
    await expect(service.create({
      location: 'local',
      task: { ...validTask, execution: { ...validTask.execution, directory: '/nope' } },
    })).rejects.toMatchObject({ statusCode: 400, message: 'Directory not found' });
  });

  it('returns 409 when the loop file already exists', async () => {
    const ctx = await createDirs();
    try {
      await writeSharedLoop(ctx.sharedDir, 'daily-digest.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
Taken.
`);
      const { service } = createService();
      await expect(service.create({ location: 'shared', task: validTask }))
        .rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('scheduled-task global routes', () => {
  const createResponse = () => ({
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  });

  const captureHandlers = (scheduledTaskService) => {
    const handlers = new Map();
    // Routes may carry Express middleware (e.g. express.json()) ahead of the
    // handler; the last function arg is the handler, mirroring Express.
    const capture = (key) => (route, ...fns) => handlers.set(`${key} ${route}`, fns[fns.length - 1]);
    const app = {
      get: vi.fn(capture('GET')),
      put: vi.fn(capture('PUT')),
      post: vi.fn(capture('POST')),
      patch: vi.fn(capture('PATCH')),
      delete: vi.fn(capture('DELETE')),
    };
    registerScheduledTaskRoutes(app, {
      scheduledTaskService,
      getOpenChamberEventClients: () => new Set(),
      writeSseEvent: vi.fn(),
    });
    return handlers;
  };

  it('lists tasks globally without a project id', async () => {
    const list = vi.fn(async () => [loopTask]);
    const handlers = captureHandlers({ list });
    const handler = handlers.get('GET /api/openchamber/scheduled-tasks');
    const res = createResponse();

    await handler({}, res);

    expect(list).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ tasks: [loopTask] });
    expect(handlers.has('GET /api/projects/:projectId/scheduled-tasks')).toBe(false);
  });

  it('creates loop files through the global endpoint', async () => {
    const create = vi.fn(async () => ({ task: loopTask, created: true }));
    const handlers = captureHandlers({ create });
    const handler = handlers.get('POST /api/openchamber/scheduled-tasks');
    const res = createResponse();
    const task = { name: 'x' };

    await handler({ body: { location: 'local', task } }, res);

    expect(create).toHaveBeenCalledWith({ location: 'local', task });
    expect(res.statusCode).toBe(201);
  });

  it('routes loop enabled changes through the loop-file service', async () => {
    const setLoopEnabled = vi.fn(async () => ({ ...loopTask, enabled: false }));
    const handlers = captureHandlers({ setLoopEnabled });
    const handler = handlers.get('PATCH /api/openchamber/scheduled-tasks/:taskId/enabled');
    const res = createResponse();

    await handler({ params: { taskId: loopTask.id }, body: { enabled: false } }, res);

    expect(setLoopEnabled).toHaveBeenCalledWith(loopTask.id, false);
    expect(res.statusCode).toBe(200);
    expect(res.payload.task.enabled).toBe(false);
  });

  it('routes loop deletion through the loop-file service', async () => {
    const removeLoopFile = vi.fn(async () => []);
    const handlers = captureHandlers({ removeLoopFile });
    const handler = handlers.get('DELETE /api/openchamber/scheduled-tasks/:taskId');
    const res = createResponse();

    await handler({ params: { taskId: loopTask.id } }, res);

    expect(removeLoopFile).toHaveBeenCalledWith(loopTask.id);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ tasks: [] });
  });

  it('routes manual runs through the global run endpoint', async () => {
    const run = vi.fn(async () => ({ sessionId: 'ses-1' }));
    const handlers = captureHandlers({ run });
    const handler = handlers.get('POST /api/openchamber/scheduled-tasks/:taskId/run');
    const res = createResponse();

    await handler({ params: { taskId: loopTask.id } }, res);

    expect(run).toHaveBeenCalledWith(loopTask.id);
    expect(res.payload).toEqual({ ok: true, sessionId: 'ses-1' });
  });
});

describe('scheduled-task service run', () => {
  it('forwards persistError when the runtime reports a completion persist failure', async () => {
    const { service } = createService({
      scheduledTasksRuntime: {
        syncLoops: vi.fn(async () => [{ ...loopTask }]),
        runNow: vi.fn(async () => ({
          ok: true,
          sessionID: 'sess-1',
          task: { id: 'task-1', state: { lastStatus: 'success' } },
          persistError: 'timeout acquiring scheduled-tasks config lock',
          reason: 'completion-state-failed',
        })),
      },
    });

    const result = await service.run('loop:daily-digest');
    expect(result.sessionId).toBe('sess-1');
    expect(result.persistError).toMatch(/timeout acquiring scheduled-tasks config lock/);
  });
});
