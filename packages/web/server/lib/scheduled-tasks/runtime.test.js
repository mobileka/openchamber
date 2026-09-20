import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import {
  computeNextRunAt,
  expandCommandGoalObjective,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
  createScheduledTasksRuntime,
} from './runtime.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';

const sdk = vi.hoisted(() => ({
  sessionCreates: [],
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: () => ({
    session: {
      create: async (args) => {
        sdk.sessionCreates.push(args);
        return { data: { id: `ses-${sdk.sessionCreates.length}` } };
      },
    },
    command: { list: async () => ({ data: [] }) },
  }),
}));

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });

  it('expands command arguments into the goal objective', () => {
    expect(expandCommandGoalObjective(
      'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
      'LIN-123 --draft',
    )).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
    expect(expandCommandGoalObjective(undefined, 'LIN-123')).toBeNull();
    expect(expandCommandGoalObjective('Move $1 to $2', '"src old" dist extra')).toBe('Move src old to dist extra');
    expect(expandCommandGoalObjective('Review the requested scope.', 'auth module'))
      .toBe('Review the requested scope.\n\nauth module');
  });
});

describe('scheduled-tasks runtime syncLoops wiring', () => {
  let tempRoot;
  let home;
  let configDir;
  let originalEnv;
  let originalHomedir;
  let originalFetch;
  let runtimes;

  const createRuntimeDeps = (overrides = {}) => ({
    buildOpenCodeUrl: () => 'http://localhost',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    ...overrides,
  });

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-loop-'));
    home = path.join(tempRoot, 'home');
    configDir = path.join(tempRoot, 'opencode-config');
    originalEnv = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = configDir;
    originalHomedir = os.homedir;
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => '' }));
    sdk.sessionCreates.length = 0;
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      runtime.stop();
    }
    if (originalEnv === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalEnv;
    }
    os.homedir = originalHomedir;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const createProjectConfig = async () => createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'state'),
    createTaskID: () => 'task-fixed-id',
  });

  const track = (runtime) => {
    runtimes.push(runtime);
    return runtime;
  };

  it('reconciles discovered loops into the single global document', async () => {
    const sharedDir = path.join(configDir, '.agents', 'loops');
    await mkdir(sharedDir, { recursive: true });
    await writeFile(path.join(sharedDir, 'daily.md'), `---
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

    const projectConfigRuntime = await createProjectConfig();
    const runtime = track(createScheduledTasksRuntime({
      ...createRuntimeDeps(),
      projectConfigRuntime,
      defaultRunDirectory: path.join(tempRoot, 'work'),
    }));

    const tasks = await runtime.syncLoops();

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('loop:daily');
    expect(tasks[0].loopFile).toBe(path.join(sharedDir, 'daily.md'));
    // syncTaskSchedule computed and persisted the next run for the enabled task.
    const stored = await projectConfigRuntime.listScheduledTasks('scheduled-tasks');
    expect(stored[0].state.nextRunAt).toBeGreaterThan(0);
    // The global document lives at the state dir root, not per-project.
    expect(projectConfigRuntime.resolveProjectConfigPath('scheduled-tasks'))
      .toBe(path.join(tempRoot, 'state', 'scheduled-tasks.json'));
    // Status exposes the resolved default so the UI can display it exactly.
    expect(runtime.getStatus().defaultRunDirectory).toBe(path.join(tempRoot, 'work'));
  });

  it('unschedules tasks whose loop file was removed', async () => {
    const sharedDir = path.join(configDir, '.agents', 'loops');
    await mkdir(sharedDir, { recursive: true });
    const loopFile = path.join(sharedDir, 'daily.md');
    await writeFile(loopFile, `---
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

    const projectConfigRuntime = await createProjectConfig();
    const runtime = track(createScheduledTasksRuntime({
      ...createRuntimeDeps(),
      projectConfigRuntime,
      defaultRunDirectory: path.join(tempRoot, 'work'),
    }));

    expect(await runtime.syncLoops()).toHaveLength(1);
    await rm(loopFile, { force: true });
    expect(await runtime.syncLoops()).toHaveLength(0);
  });

  it('runs tasks in their loop directory, defaulting to the run directory', async () => {
    const sharedDir = path.join(configDir, '.agents', 'loops');
    await mkdir(sharedDir, { recursive: true });
    const customDir = path.join(tempRoot, 'custom');
    await writeFile(path.join(sharedDir, 'custom-dir.md'), `---
schedule: "0 9 * * *"
enabled: false
model: openai/gpt-5
directory: "${customDir}"
---
Run elsewhere.
`, 'utf8');
    await writeFile(path.join(sharedDir, 'default-dir.md'), `---
schedule: "0 9 * * *"
enabled: false
model: openai/gpt-5
---
Run at default.
`, 'utf8');

    const projectConfigRuntime = await createProjectConfig();
    const defaultRunDirectory = path.join(tempRoot, 'work');
    const runtime = track(createScheduledTasksRuntime({
      ...createRuntimeDeps(),
      projectConfigRuntime,
      defaultRunDirectory,
    }));

    await runtime.syncLoops();

    // Manual runs execute paused tasks too.
    const custom = await runtime.runNow('loop:custom-dir');
    expect(custom.ok).toBe(true);
    const fallback = await runtime.runNow('loop:default-dir');
    expect(fallback.ok).toBe(true);

    expect(sdk.sessionCreates).toHaveLength(2);
    expect(sdk.sessionCreates[0].directory).toBe(customDir);
    expect(sdk.sessionCreates[1].directory).toBe(defaultRunDirectory);
  });
});
