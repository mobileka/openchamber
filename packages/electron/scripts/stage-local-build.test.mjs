import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  describeStageBlocker,
  readBundleMetadata,
  stageLocalBuild,
} from './stage-local-build.mjs';

const RUNNING_SHA = 'b'.repeat(40);
const STAGED_SHA = 'a'.repeat(40);
const RUNNING_BUILT_AT = '2026-09-27T11:48:38.736Z';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-stage-local-'));

const writeBundleMetadata = (appPath, { version, buildSha, builtAt }) => {
  fs.mkdirSync(path.join(appPath, 'Contents', 'Resources'), { recursive: true });
  const packageJson = JSON.stringify({
    name: '@openchamber/electron',
    version,
    buildSha,
    builtAt,
    build: { appId: 'dev.openchamber.desktop' },
  }, null, 2);
  // A real asar holds file data verbatim; surrounding bytes prove the reader
  // anchors on our package instead of the first matching field in the archive.
  fs.writeFileSync(
    path.join(appPath, 'Contents', 'Resources', 'app.asar'),
    Buffer.from(`PK\u0003\u0004${packageJson}${{ name: 'unrelated', version: '9.9.9' }}`, 'binary'),
  );
};

const createApp = (dir, metadata) => {
  const appPath = path.join(dir, 'OpenChamber.app');
  writeBundleMetadata(appPath, metadata);
  return appPath;
};

const runningIdentity = (overrides = {}) => ({
  version: '2.0.1-personal.4',
  buildSha: RUNNING_SHA,
  builtAt: RUNNING_BUILT_AT,
  folder: `2.0.1-personal.4_${RUNNING_SHA.slice(0, 7)}`,
  ...overrides,
});

test('readBundleMetadata reads the packaged identity', () => {
  const dir = makeTempDir();
  const appPath = createApp(dir, {
    version: '2.0.1-local.1',
    buildSha: STAGED_SHA,
    builtAt: '2026-09-28T09:35:11.722Z',
  });
  assert.deepEqual(readBundleMetadata(appPath), {
    version: '2.0.1-local.1',
    buildSha: STAGED_SHA,
    builtAt: '2026-09-28T09:35:11.722Z',
  });
});

test('readBundleMetadata rejects a directory that is not a packaged app', () => {
  const dir = makeTempDir();
  assert.throws(() => readBundleMetadata(path.join(dir, 'OpenChamber.app')), /not a packaged OpenChamber\.app/);
});

test('describeStageBlocker names why the updater would skip a build', () => {
  const staged = {
    version: '2.0.1-local.1',
    buildSha: STAGED_SHA,
    builtAt: '2026-09-28T09:35:11.722Z',
  };
  assert.equal(describeStageBlocker({ running: runningIdentity(), staged }), null);
  assert.match(
    describeStageBlocker({ running: runningIdentity({ buildSha: STAGED_SHA }), staged }),
    /same commit/,
  );
  assert.match(
    describeStageBlocker({ running: runningIdentity({ builtAt: '2026-09-29T00:00:00.000Z' }), staged }),
    /not newer/,
  );
  assert.match(
    describeStageBlocker({ running: runningIdentity({ buildSha: null }), staged }),
    /cannot take local updates/,
  );
  assert.match(
    describeStageBlocker({ running: runningIdentity(), staged: { ...staged, builtAt: null } }),
    /no valid builtAt/,
  );
});

test('stageLocalBuild copies the app and moves state.json to it', { skip: process.platform !== 'darwin' }, () => {
  const dir = makeTempDir();
  const buildsDir = path.join(dir, 'builds');
  fs.mkdirSync(buildsDir);
  const appPath = createApp(dir, {
    version: '2.0.1-local.1',
    buildSha: STAGED_SHA,
    builtAt: '2026-09-28T09:35:11.722Z',
  });

  const staged = stageLocalBuild({
    appPath,
    buildsDir,
    running: runningIdentity(),
    localChanges: '- in-chat find (uncommitted)',
  });

  const folder = `2.0.1-local.1_${STAGED_SHA.slice(0, 7)}`;
  assert.equal(staged.folder, folder);
  assert.ok(fs.existsSync(path.join(buildsDir, folder, 'OpenChamber.app', 'Contents', 'Resources', 'app.asar')));

  const state = JSON.parse(fs.readFileSync(path.join(buildsDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.latest, {
    folder,
    commit: STAGED_SHA,
    version: '2.0.1-local.1',
    builtAt: '2026-09-28T09:35:11.722Z',
  });
  assert.equal(state.previous, undefined);

  const build = JSON.parse(fs.readFileSync(path.join(buildsDir, folder, 'build.json'), 'utf8'));
  assert.deepEqual(build, { notes: null, localChanges: '- in-chat find (uncommitted)' });
});

test('stageLocalBuild keeps the previous build and prunes strays', { skip: process.platform !== 'darwin' }, () => {
  const dir = makeTempDir();
  const buildsDir = path.join(dir, 'builds');
  const previousFolder = `2.0.1-personal.4_${RUNNING_SHA.slice(0, 7)}`;
  const previousApp = path.join(buildsDir, previousFolder, 'OpenChamber.app');
  writeBundleMetadata(previousApp, { version: '2.0.1-personal.4', buildSha: RUNNING_SHA, builtAt: RUNNING_BUILT_AT });
  fs.writeFileSync(path.join(buildsDir, 'state.json'), `${JSON.stringify({
    latest: { folder: previousFolder, commit: RUNNING_SHA, version: '2.0.1-personal.4', builtAt: RUNNING_BUILT_AT },
    updatedAt: RUNNING_BUILT_AT,
  }, null, 2)}\n`);
  const strayDir = path.join(buildsDir, '1.0.0_deadbee');
  fs.mkdirSync(strayDir, { recursive: true });

  const appPath = createApp(dir, {
    version: '2.0.1-personal.5',
    buildSha: STAGED_SHA,
    builtAt: '2026-09-28T09:35:11.722Z',
  });
  const staged = stageLocalBuild({
    appPath,
    buildsDir,
    running: runningIdentity({ folder: previousFolder }),
  });

  const state = JSON.parse(fs.readFileSync(path.join(buildsDir, 'state.json'), 'utf8'));
  assert.equal(state.latest.folder, staged.folder);
  assert.equal(state.previous.folder, previousFolder);
  assert.ok(fs.existsSync(previousApp));
  assert.equal(fs.existsSync(strayDir), false);
});

test('stageLocalBuild refuses a build the running app would ignore', { skip: process.platform !== 'darwin' }, () => {
  const dir = makeTempDir();
  const buildsDir = path.join(dir, 'builds');
  const appPath = createApp(dir, {
    version: '2.0.1-personal.4',
    buildSha: RUNNING_SHA,
    builtAt: '2026-09-28T09:35:11.722Z',
  });
  assert.throws(
    () => stageLocalBuild({ appPath, buildsDir, running: runningIdentity({ buildSha: RUNNING_SHA }) }),
    /same commit/,
  );
  assert.equal(fs.existsSync(path.join(buildsDir, 'state.json')), false);
});
