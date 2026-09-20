import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import {
  parseLoopDefinition,
  discoverLoops,
  discoverLoopFiles,
  writeLoopFile,
  normalizeLoopFileStem,
  loopNameFromFilePath,
  resolveSharedLoopDir,
  resolveDefaultRunDirectory,
} from './loops.js';

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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loops-'));
  const home = path.join(tempRoot, 'home');
  const configDir = path.join(tempRoot, 'opencode-config');
  const localDir = path.join(home, '.agents', 'loops');
  const sharedDir = path.join(configDir, '.agents', 'loops');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  process.env.OPENCODE_CONFIG_DIR = configDir;
  return {
    tempRoot,
    home,
    configDir,
    localDir,
    sharedDir,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
};

const writeLoop = async (dir, fileName, content) => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, 'utf8');
};

describe('parseLoopDefinition', () => {
  it('derives the task name from the file name and maps the rest', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.localDir, 'daily-digest.md', `---
schedule: "0 9 * * *"
enabled: true
model: anthropic/claude-sonnet-4-5
agent: plan
timezone: Europe/Kyiv
---
Summarize repository changes since yesterday.
`);

      const definition = parseLoopDefinition(path.join(ctx.localDir, 'daily-digest.md'));

      expect(definition).toEqual({
        name: 'daily-digest',
        enabled: true,
        schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'Europe/Kyiv' },
        execution: {
          prompt: 'Summarize repository changes since yesterday.',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          agent: 'plan',
        },
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it('ignores a stray name frontmatter key', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.localDir, 'from-file.md', `---
name: ignored-name
schedule: "0 9 * * *"
model: openai/gpt-5
---
Run.
`);

      expect(parseLoopDefinition(path.join(ctx.localDir, 'from-file.md')).name).toBe('from-file');
    } finally {
      await ctx.cleanup();
    }
  });

  it('splits model ids containing a slash on the first separator', async () => {
    const ctx = await createDirs();
    try {
      const filePath = path.join(ctx.localDir, 'nested-model.md');
      await writeLoop(ctx.localDir, 'nested-model.md', `---
schedule: "0 8 * * 1"
model: openai/gpt-5
---
Run weekly checks.
`);

      const definition = parseLoopDefinition(filePath);

      expect(definition.execution.providerID).toBe('openai');
      expect(definition.execution.modelID).toBe('gpt-5');
      expect(definition.enabled).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  it('defaults enabled to false and omits optional fields', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.localDir, 'minimal.md', `---
schedule: "*/30 * * * *"
model: openai/gpt-5
---
Run every half hour.
`);

      const definition = parseLoopDefinition(path.join(ctx.localDir, 'minimal.md'));

      // Loops only run when the file explicitly enables them: discovery of
      // repository content must never auto-execute scheduled sessions.
      expect(definition.enabled).toBe(false);
      expect(definition.schedule).toEqual({ kind: 'cron', cron: '*/30 * * * *' });
      expect(definition.execution.agent).toBeUndefined();
      expect(definition.execution.directory).toBeUndefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it('expands a leading tilde in the optional directory', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.localDir, 'with-dir.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
directory: ~/work/repo
---
Run.
`);

      expect(parseLoopDefinition(path.join(ctx.localDir, 'with-dir.md')).execution.directory)
        .toBe(path.join(ctx.home, 'work', 'repo'));
    } finally {
      await ctx.cleanup();
    }
  });

  it('returns null for files missing required fields or with a blank directory', async () => {
    const ctx = await createDirs();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await writeLoop(ctx.localDir, 'noschedule.md', `---
model: openai/gpt-5
---
Prompt only.
`);
        expect(parseLoopDefinition(path.join(ctx.localDir, 'noschedule.md'))).toBeNull();

        await writeLoop(ctx.localDir, 'nomodel.md', `---
schedule: "0 9 * * *"
---
Prompt only.
`);
        expect(parseLoopDefinition(path.join(ctx.localDir, 'nomodel.md'))).toBeNull();

        await writeLoop(ctx.localDir, 'malformed.md', 'not a markdown frontmatter file at all');
        expect(parseLoopDefinition(path.join(ctx.localDir, 'malformed.md'))).toBeNull();

        await writeLoop(ctx.localDir, 'blank-dir.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
directory: "   "
---
Prompt only.
`);
        expect(parseLoopDefinition(path.join(ctx.localDir, 'blank-dir.md'))).toBeNull();
      } finally {
        warn.mockRestore();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it('treats a missing body as an invalid loop', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.localDir, 'empty-body.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
`);

      expect(parseLoopDefinition(path.join(ctx.localDir, 'empty-body.md'))).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects file names longer than the storage limit', async () => {
    const ctx = await createDirs();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const fileName = `${'x'.repeat(81)}.md`;
        await writeLoop(ctx.localDir, fileName, `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
Run.
`);

        // Task names are clamped to 80 chars at storage time; a raw name that
        // exceeds it could never match the stored task, so the file is treated
        // as malformed rather than creating an unreachable definition.
        expect(parseLoopDefinition(path.join(ctx.localDir, fileName))).toBeNull();
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('loop file name helpers', () => {
  it('derives the name from the file stem', () => {
    expect(loopNameFromFilePath('/x/.agents/loops/daily.md')).toBe('daily');
    expect(() => loopNameFromFilePath('/x/.agents/loops/.md')).toThrow();
  });

  it('normalizes user-supplied names into safe stems', () => {
    expect(normalizeLoopFileStem('  Daily Digest  ')).toBe('Daily Digest');
    expect(normalizeLoopFileStem('daily.md')).toBe('daily');
    expect(() => normalizeLoopFileStem('   ')).toThrow();
    expect(() => normalizeLoopFileStem('a/b')).toThrow();
    expect(() => normalizeLoopFileStem('..')).toThrow();
    expect(() => normalizeLoopFileStem(`${'x'.repeat(81)}`)).toThrow();
  });
});

describe('loop dir resolution', () => {
  it('resolves the shared dir strictly from the environment', () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    expect(resolveSharedLoopDir()).toBeNull();

    process.env.OPENCODE_CONFIG_DIR = '/tmp/oc-config';
    expect(resolveSharedLoopDir()).toBe(path.join('/tmp/oc-config', '.agents', 'loops'));
  });

  it('defaults the run directory to the parent of the config dir', () => {
    process.env.OPENCODE_CONFIG_DIR = '/tmp/oc-config';
    expect(resolveDefaultRunDirectory()).toBe('/tmp');

    delete process.env.OPENCODE_CONFIG_DIR;
    expect(resolveDefaultRunDirectory()).toBe(path.join(os.homedir(), 'dev', 'opencode'));
  });
});

describe('writeLoopFile', () => {
  it('writes a new loop file without a name key and creates the dir', async () => {
    const ctx = await createDirs();
    try {
      const { filePath, name } = writeLoopFile({
        location: 'shared',
        name: 'daily-digest',
        frontmatter: {
          name: 'should-be-dropped',
          schedule: '0 9 * * *',
          enabled: true,
          model: 'openai/gpt-5',
        },
        body: 'Summarize.',
      });

      expect(name).toBe('daily-digest');
      expect(filePath).toBe(path.join(ctx.sharedDir, 'daily-digest.md'));
      const content = await readFile(filePath, 'utf8');
      expect(content).toContain('Summarize.');
      expect(content).not.toContain('should-be-dropped');
      expect(parseLoopDefinition(filePath).name).toBe('daily-digest');
    } finally {
      await ctx.cleanup();
    }
  });

  it('refuses to overwrite an existing file', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.localDir, 'taken.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
Taken.
`);
      expect(() => writeLoopFile({
        location: 'local',
        name: 'taken',
        frontmatter: { schedule: '0 9 * * *', model: 'openai/gpt-5' },
        body: 'Other.',
      })).toThrowError(expect.objectContaining({ code: 'EEXIST' }));
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects unknown locations and unsafe names', async () => {
    const ctx = await createDirs();
    try {
      expect(() => writeLoopFile({
        location: 'project',
        name: 'x',
        frontmatter: {},
        body: 'x',
      })).toThrow(/unknown loop location/);
      expect(() => writeLoopFile({
        location: 'local',
        name: '../evil',
        frontmatter: {},
        body: 'x',
      })).toThrow();
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('discoverLoops', () => {
  it('discovers loops from both fixed dirs with locations', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.localDir, 'digest.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
Summarize.
`);
      await writeLoop(ctx.sharedDir, 'sync.md', `---
schedule: "0 7 * * *"
model: openai/gpt-5
---
Synced.
`);

      const loops = discoverLoops();

      expect(loops).toHaveLength(2);
      expect(loops.find((loop) => loop.definition?.name === 'digest').location).toBe('local');
      expect(loops.find((loop) => loop.definition?.name === 'sync').location).toBe('shared');
    } finally {
      await ctx.cleanup();
    }
  });

  it('lets local loops shadow shared loops with the same file stem', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.sharedDir, 'same.md', `---
schedule: "0 7 * * *"
model: openai/gpt-5
---
Shared version.
`);
      await writeLoop(ctx.localDir, 'same.md', `---
schedule: "0 8 * * *"
model: anthropic/claude-sonnet-4-5
---
Local version.
`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const loops = discoverLoops();

        expect(loops).toHaveLength(1);
        expect(loops[0].location).toBe('local');
        expect(loops[0].definition.execution.providerID).toBe('anthropic');
        expect(loops[0].definition.schedule.cron).toBe('0 8 * * *');
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it('reports malformed files as unparsed entries without blocking valid ones', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.sharedDir, 'bad.md', `---
schedule: "0 9 * * *"
---
No model.
`);
      await writeLoop(ctx.sharedDir, 'good.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
Valid.
`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const loops = discoverLoops();

        // The malformed file stays visible as a `definition: null` entry so
        // the scheduler can keep its task alive while the file is fixed.
        const bad = loops.find((loop) => loop.filePath.endsWith(path.join('.agents', 'loops', 'bad.md')));
        expect(bad.definition).toBeNull();
        expect(bad.location).toBe('shared');

        const good = loops.find((loop) => loop.filePath.endsWith(path.join('.agents', 'loops', 'good.md')));
        expect(good.definition.name).toBe('good');
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it('returns an empty list when neither dir exists', async () => {
    const ctx = await createDirs();
    try {
      // Neither loops dir was created: missing means no jobs, not an error.
      expect(discoverLoops()).toEqual([]);
      expect(discoverLoopFiles()).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it('lists raw loop files without parsing and ignores non-markdown files', async () => {
    const ctx = await createDirs();
    try {
      await writeLoop(ctx.localDir, 'one.md', `---
schedule: "0 9 * * *"
model: openai/gpt-5
---
One.
`);
      await writeFile(path.join(ctx.localDir, 'not-a-loop.txt'), 'ignore me', 'utf8');

      const files = discoverLoopFiles();

      expect(files).toHaveLength(1);
      expect(files[0].location).toBe('local');
      expect(files[0].filePath.endsWith(path.join('.agents', 'loops', 'one.md'))).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });
});
