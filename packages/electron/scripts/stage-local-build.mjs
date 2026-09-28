#!/usr/bin/env node
/**
 * Stages a locally built OpenChamber.app into the desktop app's `builds/`
 * channel, so the running app offers it as a local update.
 *
 * This is the local-build sibling of `stage-release.mjs` (which downloads a
 * published release). Nothing is published or uploaded here.
 *
 * The running app ignores a staged build whose commit equals its own
 * `buildSha` (`evaluateLocalUpdate`), and a local update only wins while no
 * newer personal release exists. This script therefore refuses to stage a
 * build the app would silently skip, instead of leaving a state.json entry
 * that can never be applied.
 *
 * Usage:
 *   node scripts/stage-local-build.mjs [--app <path>] [--notes <text>]
 *     [--local-changes <text>] [--builds-dir <path>]
 *   node scripts/stage-local-build.mjs --show-running
 *
 * `--show-running` prints the installed app's identity and builds directory as
 * JSON and exits, so the caller can compare its commit with the worktree's
 * HEAD before spending a build.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pruneLocalUpdateBuilds,
  pruneStaleStagingDirs,
  readLocalUpdateState,
  STAGING_PREFIX,
  writeLocalUpdateState,
} from '../local-update.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APPLICATIONS_LINK = '/Applications/OpenChamber.app';
const APP_BUNDLE_NAME = 'OpenChamber.app';
const DEFAULT_APP_PATH = path.join(__dirname, '..', 'dist', 'mac-arm64', APP_BUNDLE_NAME);
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;
// Mirrors FOLDER_PATTERN in local-update.mjs: the folder encodes the version.
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const fail = (message) => {
  throw new Error(message);
};

/**
 * The packaged app's own identity. `main.mjs` reads these fields from
 * `package.json` inside `app.asar`; read the same file so the staged entry and
 * the app can never disagree.
 */
export const readBundleMetadata = (appPath) => {
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    fail(`${appPath} is not a packaged OpenChamber.app (missing Contents/Resources/app.asar)`);
  }
  // The asar stores file data verbatim, so the packaged package.json sits in
  // the archive as plain JSON. Anchor on the package name: only our package
  // carries buildSha/builtAt, and the version beside them is ours too.
  const raw = fs.readFileSync(asarPath).toString('latin1');
  const anchor = raw.search(/"name"\s*:\s*"@openchamber\/electron"/);
  const slice = anchor >= 0 ? raw.slice(anchor, anchor + 4096) : '';
  return {
    version: /"version"\s*:\s*"([^"]+)"/.exec(slice)?.[1] ?? null,
    buildSha: /"buildSha"\s*:\s*"([0-9a-f]{7,40})"/i.exec(slice)?.[1] ?? null,
    builtAt: /"builtAt"\s*:\s*"([^"]+)"/.exec(slice)?.[1] ?? null,
  };
};

/** The app `/Applications/OpenChamber.app` points at, and its builds folder. */
export const resolveInstalledApp = () => {
  let target;
  try {
    const stats = fs.lstatSync(APPLICATIONS_LINK);
    if (!stats.isSymbolicLink()) {
      fail(`${APPLICATIONS_LINK} is not a symlink; the local update channel needs the builds/ layout (see packages/electron/README.md)`);
    }
    target = fs.readlinkSync(APPLICATIONS_LINK);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail(`OpenChamber is not installed at ${APPLICATIONS_LINK}`);
    }
    throw error;
  }
  const appPath = path.resolve(path.dirname(APPLICATIONS_LINK), target);
  const folder = path.basename(path.dirname(appPath));
  return { appPath, folder, buildsDir: path.dirname(path.dirname(appPath)) };
};

/** Why `evaluateLocalUpdate` would skip this build, or null when it applies. */
export const describeStageBlocker = ({ running, staged }) => {
  if (!running.buildSha || !COMMIT_PATTERN.test(running.buildSha)) {
    return `The installed app (${running.version ?? 'unknown version'}) has no buildSha, so it cannot take local updates. Install a personal-channel build first.`;
  }
  if (staged.buildSha && running.buildSha.toLowerCase() === staged.buildSha.toLowerCase()) {
    return `The installed app is already built from commit ${running.buildSha.slice(0, 7)}; the updater ignores a staged build with the same commit. Commit the work (or build from a different commit), then stage again.`;
  }
  const runningTime = Date.parse(running.builtAt ?? '');
  const stagedTime = Date.parse(staged.builtAt ?? '');
  if (!Number.isFinite(stagedTime)) {
    return 'The built app carries no valid builtAt timestamp; stamp packages/electron/package.json before packaging.';
  }
  if (Number.isFinite(runningTime) && stagedTime <= runningTime) {
    return `The built app's builtAt (${staged.builtAt}) is not newer than the installed app's (${running.builtAt}); rebuild before staging.`;
  }
  return null;
};

/**
 * Copies the built app into `buildsDir/<version>_<commit>/`, writes its
 * `build.json`, and moves `state.json` to it. The previous latest build and the
 * running build are kept.
 */
export const stageLocalBuild = ({ appPath, buildsDir, running, notes = null, localChanges = null }) => {
  const resolvedAppPath = path.resolve(appPath);
  const metadata = readBundleMetadata(resolvedAppPath);
  if (!metadata.version || !VERSION_PATTERN.test(metadata.version)) {
    fail(`The built app carries no folder-safe version (got ${JSON.stringify(metadata.version)})`);
  }
  if (!metadata.buildSha) {
    fail('The built app carries no buildSha; stamp packages/electron/package.json before packaging.');
  }

  const blocker = describeStageBlocker({ running, staged: metadata });
  if (blocker) {
    fail(blocker);
  }

  const folder = `${metadata.version}_${metadata.buildSha.slice(0, 7).toLowerCase()}`;
  fs.mkdirSync(buildsDir, { recursive: true });
  pruneStaleStagingDirs({ buildsDir });
  const stagingDir = fs.mkdtempSync(path.join(buildsDir, STAGING_PREFIX));
  const payloadDir = path.join(stagingDir, 'payload');

  try {
    fs.mkdirSync(payloadDir);
    // ditto keeps bundle symlinks and resource forks intact, matching the
    // archive extraction path in github-release-update.mjs.
    execFileSync('ditto', [resolvedAppPath, path.join(payloadDir, APP_BUNDLE_NAME)]);
    fs.writeFileSync(
      path.join(payloadDir, 'build.json'),
      `${JSON.stringify({ notes, localChanges }, null, 2)}\n`,
      'utf8',
    );

    const previous = readLocalUpdateState({ buildsDir });
    const finalPath = path.join(buildsDir, folder);
    fs.rmSync(finalPath, { recursive: true, force: true });
    fs.renameSync(payloadDir, finalPath);
    writeLocalUpdateState({
      buildsDir,
      latest: { folder, commit: metadata.buildSha, version: metadata.version, builtAt: metadata.builtAt },
      previous: previous?.latest ?? null,
    });
    const removed = pruneLocalUpdateBuilds({
      buildsDir,
      keepFolders: [folder, previous?.latest?.folder, running.folder],
    });

    return {
      folder,
      appPath: path.join(finalPath, APP_BUNDLE_NAME),
      version: metadata.version,
      commit: metadata.buildSha,
      builtAt: metadata.builtAt,
      removed,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
};

const printUsage = () => {
  console.log(`Usage:
  node scripts/stage-local-build.mjs [--app <path>] [--notes <text>] [--local-changes <text>] [--builds-dir <path>]
  node scripts/stage-local-build.mjs --show-running

Options:
  --app <path>           Built app bundle; defaults to dist/mac-arm64/OpenChamber.app
  --notes <text>         Shown as release notes in the update dialog
  --local-changes <text> Shown under "Local changes" in the update dialog
  --builds-dir <path>    Override the builds directory (defaults to the /Applications symlink's)
  --show-running         Print the installed app's identity as JSON and exit
  -h, --help             Show this help`);
};

const readOption = (argv, index, name) => {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`${name} needs a value`);
  }
  return value;
};

const parseArgs = (argv) => {
  const args = {
    appPath: DEFAULT_APP_PATH,
    notes: null,
    localChanges: null,
    buildsDir: null,
    showRunning: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--app') {
      args.appPath = readOption(argv, index, '--app');
      index += 1;
    } else if (argument === '--notes') {
      args.notes = readOption(argv, index, '--notes');
      index += 1;
    } else if (argument === '--local-changes') {
      args.localChanges = readOption(argv, index, '--local-changes');
      index += 1;
    } else if (argument === '--builds-dir') {
      args.buildsDir = readOption(argv, index, '--builds-dir');
      index += 1;
    } else if (argument === '--show-running') {
      args.showRunning = true;
    } else if (argument === '-h' || argument === '--help') {
      args.help = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return args;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (process.platform !== 'darwin') {
    fail('The local update channel is macOS-only.');
  }

  const installed = resolveInstalledApp();
  const running = { ...readBundleMetadata(installed.appPath), folder: installed.folder };
  const buildsDir = args.buildsDir
    ? path.resolve(args.buildsDir)
    : installed.buildsDir;

  if (args.showRunning) {
    console.log(JSON.stringify({
      appPath: installed.appPath,
      buildsDir,
      version: running.version,
      buildSha: running.buildSha,
      builtAt: running.builtAt,
    }, null, 2));
    return;
  }

  console.log(`[stage-local] running ${running.version ?? '?'} (${(running.buildSha ?? 'no buildSha').slice(0, 7)}) at ${installed.appPath}`);
  console.log(`[stage-local] builds directory: ${buildsDir}`);
  const staged = stageLocalBuild({
    appPath: args.appPath,
    buildsDir,
    running,
    notes: args.notes,
    localChanges: args.localChanges,
  });
  console.log(`[stage-local] staged ${staged.version} (${staged.commit.slice(0, 7)}) -> ${staged.folder}`);
  if (staged.removed.length > 0) {
    console.log(`[stage-local] pruned: ${staged.removed.join(', ')}`);
  }
  console.log('[stage-local] the running app offers the update within about five seconds; applying it repoints /Applications/OpenChamber.app and relaunches');
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[stage-local] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
