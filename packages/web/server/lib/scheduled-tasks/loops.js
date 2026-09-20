/**
 * Markdown loops — portable scheduled-task definitions.
 *
 * Loops are git-commit-able markdown files with YAML frontmatter, discovered
 * from two fixed flat directories (no project ancestors, no fallback):
 * - local:  `~/.agents/loops/*.md` (this machine only)
 * - shared: `$OPENCODE_CONFIG_DIR/.agents/loops/*.md` (synced via git)
 *
 * A missing directory simply contributes no loops. Only the create-file flow
 * creates directories (the one it writes into).
 *
 * File format (the task name is the file name without `.md`):
 *
 *   ---
 *   schedule: "0 9 * * *"
 *   enabled: true
 *   model: anthropic/claude-sonnet-4-5
 *   agent: plan
 *   timezone: Europe/Kyiv
 *   directory: ~/dev/opencode
 *   ---
 *   Summarize repository changes since yesterday and post the digest.
 *
 * Field mapping (see packages/ui/src/lib/scheduledTasksApi.ts):
 *   filename -> task.name (required: non-empty stem, max 80 characters)
 *   schedule -> task.schedule.kind "cron" + task.schedule.cron
 *   enabled  -> task.enabled (default false — loops only run when the file
 *               explicitly enables them, so discovery never auto-executes
 *               repository content)
 *   model    -> split into task.execution.providerID / task.execution.modelID
 *   agent    -> task.execution.agent (optional)
 *   timezone -> task.schedule.timezone (optional, defaults to the server zone)
 *   directory -> task.execution.directory (optional, `~` expanded at read
 *               time so shared files stay portable; defaults downstream to
 *               the parent of $OPENCODE_CONFIG_DIR)
 *   body     -> task.execution.prompt
 *
 * A stray `name` frontmatter key is ignored: renaming a task means renaming
 * its file. `thinking_level` and `goalEnabled`/`goalTokenBudget` are not part
 * of the portable format (they are UI-only today); editing them in the file
 * has no effect.
 *
 * Runtime state (lastRunAt, nextRunAt, lastStatus, ...) is never written to
 * the markdown file; it lives in the single global state document
 * `$OPENCHAMBER_DATA_DIR/scheduled-tasks.json`, which is machine-local and
 * never shared — only the `.md` definitions are synced.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseMdFile, writeMdFile } from '../opencode/shared.js';
import { MAX_TASK_NAME_LENGTH } from '../projects/project-config.js';

const LOOP_DIR_NAME = 'loops';
const LOCAL_LOOP_ROOT = () => path.join(os.homedir(), '.agents', LOOP_DIR_NAME);

/**
 * Strictly resolve the shared loops dir from the environment. No fallback:
 * when $OPENCODE_CONFIG_DIR is unset there is no shared dir (and no shared
 * jobs) rather than a guess at one.
 */
export const resolveSharedLoopDir = () => {
  const configured = typeof process.env.OPENCODE_CONFIG_DIR === 'string'
    ? process.env.OPENCODE_CONFIG_DIR.trim()
    : '';
  if (!configured) {
    return null;
  }
  return path.join(path.resolve(configured), '.agents', LOOP_DIR_NAME);
};

/** Fixed execution directory for runs: the repo root holding the config. */
export const resolveDefaultRunDirectory = () => {
  const configured = typeof process.env.OPENCODE_CONFIG_DIR === 'string'
    ? process.env.OPENCODE_CONFIG_DIR.trim()
    : '';
  if (configured) {
    return path.resolve(configured, '..');
  }
  return path.join(os.homedir(), 'dev', 'opencode');
};

export const resolveLoopDirs = () => ([
  { dir: LOCAL_LOOP_ROOT(), location: 'local' },
  { dir: resolveSharedLoopDir(), location: 'shared' },
]);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Split a `provider/model` string into its two parts. Splits on the first `/`
 * so model ids containing a slash (e.g. `openai/gpt-5`) still resolve.
 */
const splitProviderModel = (value) => {
  const raw = asNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) {
    return null;
  }
  return {
    providerId: raw.slice(0, separator).trim(),
    modelId: raw.slice(separator + 1).trim(),
  };
};

const expandLeadingTilde = (value) => {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
};

/**
 * Derive and validate the task name from a loop file path: the file stem.
 * Throws on anything that cannot be a stable task name.
 */
export const loopNameFromFilePath = (filePath) => {
  const base = path.basename(filePath);
  const name = base.toLowerCase().endsWith('.md') ? base.slice(0, -3).trim() : base.trim();
  if (!name) {
    throw new Error('loop file name is required');
  }
  if (name.length > MAX_TASK_NAME_LENGTH) {
    // Reject instead of clamping: task names are clamped to this length at
    // storage time, so identity keys must match the stored value exactly.
    throw new Error(`loop file name exceeds ${MAX_TASK_NAME_LENGTH} characters`);
  }
  return name;
};

/**
 * Normalize a user-supplied loop name into a safe file stem. A single
 * trailing `.md` is accepted as a convenience and stripped. Throws on
 * anything that cannot become a file name.
 */
export const normalizeLoopFileStem = (value) => {
  let stem = asNonEmptyString(value);
  if (!stem) {
    throw new Error('name is required');
  }
  if (stem.toLowerCase().endsWith('.md')) {
    stem = stem.slice(0, -3).trim();
  }
  if (!stem) {
    throw new Error('name is required');
  }
  if (stem === '.' || stem === '..' || stem.includes('/') || stem.includes('\\') || stem.includes('\0')) {
    throw new Error('name must be a plain file name without path separators');
  }
  if (stem.length > MAX_TASK_NAME_LENGTH) {
    throw new Error(`name exceeds ${MAX_TASK_NAME_LENGTH} characters`);
  }
  return stem;
};

/**
 * Parse one loop markdown file into a scheduled-task definition, or return
 * null when the file is malformed. Malformed files are skipped with a warning
 * and never prevent valid files from loading.
 */
export const parseLoopDefinition = (filePath) => {
  let name;
  try {
    name = loopNameFromFilePath(filePath);
  } catch (error) {
    console.warn(`[loops] skipped ${filePath}:`, error?.message ?? error);
    return null;
  }

  let parsed;
  try {
    parsed = parseMdFile(filePath);
  } catch (error) {
    console.warn(`[loops] skipped malformed loop file ${filePath}:`, error?.message ?? error);
    return null;
  }

  const frontmatter = parsed.frontmatter && typeof parsed.frontmatter === 'object'
    ? parsed.frontmatter
    : {};

  const cron = asNonEmptyString(frontmatter.schedule);
  if (!cron) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "schedule" (cron expression) is required`);
    return null;
  }

  const prompt = asNonEmptyString(parsed.body);
  if (!prompt) {
    console.warn(`[loops] skipped ${filePath}: markdown body (the execution prompt) is required`);
    return null;
  }

  const providerModel = splitProviderModel(frontmatter.model);
  if (!providerModel) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "model" must be "provider/model"`);
    return null;
  }

  const timezone = asNonEmptyString(frontmatter.timezone);
  const agent = asNonEmptyString(frontmatter.agent);

  // Optional execution directory, `~` expanded at read time so shared files
  // stay portable across machines. Present-but-blank is a likely typo, so it
  // is malformed rather than silently defaulted.
  let directory;
  if (frontmatter.directory !== undefined && frontmatter.directory !== null) {
    const rawDirectory = typeof frontmatter.directory === 'string' ? frontmatter.directory : '';
    const expanded = asNonEmptyString(expandLeadingTilde(rawDirectory.trim()));
    if (!expanded) {
      console.warn(`[loops] skipped ${filePath}: frontmatter "directory" must be a non-empty path`);
      return null;
    }
    directory = expanded;
  }

  return {
    name,
    enabled: typeof frontmatter.enabled === 'boolean' ? frontmatter.enabled : false,
    schedule: {
      kind: 'cron',
      cron,
      ...(timezone ? { timezone } : {}),
    },
    execution: {
      prompt,
      providerID: providerModel.providerId,
      modelID: providerModel.modelId,
      ...(agent ? { agent } : {}),
      ...(directory ? { directory } : {}),
    },
  };
};

export const setLoopFileEnabled = (filePath, enabled) => {
  if (!parseLoopDefinition(filePath)) {
    return false;
  }
  const { frontmatter, body } = parseMdFile(filePath);
  writeMdFile(filePath, { ...frontmatter, enabled: Boolean(enabled) }, body);
  return true;
};

/**
 * Write a new loop file. Creates the location dir when needed, refuses to
 * overwrite an existing file (the caller maps the error to a 409), and never
 * writes a `name` key — the file name is the name.
 */
export const writeLoopFile = ({ location, name, frontmatter, body }) => {
  const dirs = resolveLoopDirs();
  const target = dirs.find((entry) => entry.location === location && entry.dir);
  if (!target) {
    throw new Error(`unknown loop location: ${location}`);
  }
  const stem = normalizeLoopFileStem(name);
  const filePath = path.join(target.dir, `${stem}.md`);
  if (fs.existsSync(filePath)) {
    const error = new Error(`loop file already exists: ${stem}.md`);
    error.code = 'EEXIST';
    throw error;
  }
  const { name: _ignored, ...rest } = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  fs.mkdirSync(target.dir, { recursive: true });
  writeMdFile(filePath, rest, body);
  return { filePath, name: stem };
};

const walkLoopMdFiles = (rootDir) => {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(rootDir, entry.name))
      .sort();
  } catch {
    return [];
  }
};

/**
 * Discover loop files in the two fixed dirs. Local is walked first so that
 * local files win name collisions with shared files.
 */
export const discoverLoopFiles = () => {
  const files = [];
  for (const { dir, location } of resolveLoopDirs()) {
    for (const filePath of walkLoopMdFiles(dir)) {
      files.push({ filePath, location });
    }
  }
  return files;
};

/**
 * Discover and parse all loops. Local loops shadow shared loops with the
 * same name; within one dir the first sorted file wins and the loser is
 * reported via warn (it produces no task).
 *
 * Unparseable files are reported as `{ location, filePath, definition: null }`
 * entries instead of being dropped: the scheduler must distinguish "file is
 * gone" (unschedule its task) from "file exists but is currently malformed"
 * (keep its task with the last good definition until the file is fixed).
 * Malformed files never block valid ones in the same or other locations.
 */
export const discoverLoops = () => {
  const byName = new Map();
  const loops = [];
  for (const { filePath, location } of discoverLoopFiles()) {
    const definition = parseLoopDefinition(filePath);
    if (!definition) {
      loops.push({ location, filePath, definition: null });
      continue;
    }
    const existing = byName.get(definition.name);
    if (existing) {
      console.warn(
        `[loops] skipped ${filePath}: name "${definition.name}" is already defined by ${existing.filePath} (${existing.location} wins)`,
      );
      continue;
    }
    byName.set(definition.name, { location, filePath, definition });
  }
  for (const entry of byName.values()) {
    loops.push(entry);
  }
  return loops;
};
