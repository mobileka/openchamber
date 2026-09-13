import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateLocalUpdate,
  pruneLocalUpdateBuilds,
  readLocalUpdateDetails,
  readLocalUpdateState,
  repointApplicationsLink,
  resolveBuildsDir,
  writeLocalUpdateState,
} from './local-update.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-local-update-'));

const createBuild = (buildsDir, folder, entry = {}) => {
  const appPath = path.join(buildsDir, folder, 'OpenChamber.app');
  fs.mkdirSync(appPath, { recursive: true });
  const build = {
    version: entry.version ?? '1.23.1',
    commit: entry.commit ?? 'a'.repeat(40),
    builtAt: entry.builtAt ?? '2026-09-12T00:00:00.000Z',
    notes: entry.notes ?? '## [1.23.1] - 2026-09-12\n\n### Local changes\n\n- something',
    localChanges: entry.localChanges ?? '',
  };
  fs.writeFileSync(path.join(buildsDir, folder, 'build.json'), JSON.stringify(build));
  return { appPath, build };
};

const writeState = (buildsDir, state) => {
  fs.writeFileSync(path.join(buildsDir, 'state.json'), JSON.stringify(state));
};

test('resolveBuildsDir follows OPENCHAMBER_DATA_DIR and falls back to the home config dir', () => {
  assert.equal(
    resolveBuildsDir({ environment: { OPENCHAMBER_DATA_DIR: '/tmp/data-dir' }, homeDirectory: '/home/user' }),
    path.join('/tmp/data-dir', 'builds'),
  );
  assert.equal(
    resolveBuildsDir({ environment: {}, homeDirectory: '/home/user' }),
    path.join('/home/user', '.config', 'openchamber', 'builds'),
  );
  assert.equal(
    resolveBuildsDir({ environment: { OPENCHAMBER_DATA_DIR: '   ' }, homeDirectory: '/home/user' }),
    path.join('/home/user', '.config', 'openchamber', 'builds'),
  );
});

test('readLocalUpdateState reads a valid state with a previous build', () => {
  const buildsDir = makeTempDir();
  createBuild(buildsDir, '1.23.1_aaaaaaa', { commit: 'a'.repeat(40) });
  createBuild(buildsDir, '1.23.0_bbbbbbb', { commit: 'b'.repeat(40), version: '1.23.0' });
  writeState(buildsDir, {
    latest: { folder: '1.23.1_aaaaaaa', commit: 'a'.repeat(40), version: '1.23.1', builtAt: '2026-09-12T00:00:00.000Z' },
    previous: { folder: '1.23.0_bbbbbbb', commit: 'b'.repeat(40), version: '1.23.0', builtAt: '2026-09-11T00:00:00.000Z' },
    updatedAt: '2026-09-12T00:00:00.000Z',
  });

  const state = readLocalUpdateState({ buildsDir });
  assert.equal(state?.latest.folder, '1.23.1_aaaaaaa');
  assert.equal(state?.previous?.folder, '1.23.0_bbbbbbb');
  assert.equal(state?.latest.appPath, path.join(buildsDir, '1.23.1_aaaaaaa', 'OpenChamber.app'));
});

test('readLocalUpdateState rejects malformed state and makes no update available', () => {
  const buildsDir = makeTempDir();
  writeState(buildsDir, { latest: { folder: '../escape', commit: 'a'.repeat(40) } });
  assert.equal(readLocalUpdateState({ buildsDir }), null);

  writeState(buildsDir, { latest: { folder: 'good_folder', commit: 'not-a-commit' } });
  assert.equal(readLocalUpdateState({ buildsDir }), null);

  writeState(buildsDir, { latest: { folder: 'missing_app', commit: 'a'.repeat(40) } });
  assert.equal(readLocalUpdateState({ buildsDir }), null);

  fs.writeFileSync(path.join(buildsDir, 'state.json'), '{not json');
  assert.equal(readLocalUpdateState({ buildsDir }), null);
});

test('evaluateLocalUpdate offers newer builds and skips the running commit', () => {
  const buildsDir = makeTempDir();
  createBuild(buildsDir, '1.23.1_aaaaaaa', { commit: 'a'.repeat(40), builtAt: '2026-09-12T10:00:00.000Z' });
  writeState(buildsDir, {
    latest: { folder: '1.23.1_aaaaaaa', commit: 'a'.repeat(40), version: '1.23.1', builtAt: '2026-09-12T10:00:00.000Z' },
  });
  const state = readLocalUpdateState({ buildsDir });

  assert.equal(evaluateLocalUpdate({ state, runningCommit: 'a'.repeat(40), runningBuiltAt: '2026-09-12T09:00:00.000Z' }), null);
  assert.equal(evaluateLocalUpdate({ state, runningCommit: 'b'.repeat(40), runningBuiltAt: '2026-09-12T11:00:00.000Z' }), null);
  assert.equal(evaluateLocalUpdate({ state, runningCommit: 'b'.repeat(40), runningBuiltAt: '2026-09-12T09:00:00.000Z' })?.version, '1.23.1');
  assert.equal(evaluateLocalUpdate({ state, runningCommit: null, runningBuiltAt: null })?.commit, 'a'.repeat(40));
  assert.equal(evaluateLocalUpdate({ state: null }), null);
});

test('readLocalUpdateDetails separates upstream notes from local changes', () => {
  const buildsDir = makeTempDir();
  const { appPath } = createBuild(buildsDir, '1.23.1_aaaaaaa', {
    notes: '## [1.23.1] - 2026-09-12',
    localChanges: '- thing (abc1234)',
  });
  assert.deepEqual(readLocalUpdateDetails({ folderPath: path.dirname(appPath) }), {
    notes: '## [1.23.1] - 2026-09-12',
    localChanges: '- thing (abc1234)',
  });
  assert.equal(readLocalUpdateDetails({ folderPath: path.join(buildsDir, 'nope') }), null);
});

test('readLocalUpdateDetails tolerates build files without a localChanges field', () => {
  const buildsDir = makeTempDir();
  const folderPath = path.join(buildsDir, '1.23.1_bbbbbbb');
  fs.mkdirSync(path.join(folderPath, 'OpenChamber.app'), { recursive: true });
  fs.writeFileSync(path.join(folderPath, 'build.json'), JSON.stringify({
    notes: '## [1.23.1] - 2026-09-12\n\n### Local changes\n\n- old format (bbbbbbb)',
  }));
  assert.deepEqual(readLocalUpdateDetails({ folderPath }), {
    notes: '## [1.23.1] - 2026-09-12\n\n### Local changes\n\n- old format (bbbbbbb)',
    localChanges: null,
  });
});

test('repointApplicationsLink swaps the symlink and restores it on failure', () => {
  const root = makeTempDir();
  const applications = path.join(root, 'Applications');
  fs.mkdirSync(applications);
  const linkPath = path.join(applications, 'OpenChamber.app');
  const oldTarget = path.join(root, 'builds', 'old', 'OpenChamber.app');
  const newTarget = path.join(root, 'builds', 'new', 'OpenChamber.app');
  fs.mkdirSync(oldTarget, { recursive: true });
  fs.mkdirSync(newTarget, { recursive: true });
  fs.symlinkSync(oldTarget, linkPath);

  assert.equal(repointApplicationsLink({ target: newTarget, linkPath }), true);
  assert.equal(fs.readlinkSync(linkPath), newTarget);
  assert.equal(repointApplicationsLink({ target: newTarget, linkPath }), false);

  let symlinkCalls = 0;
  const failingFs = {
    lstatSync: fs.lstatSync,
    readlinkSync: fs.readlinkSync,
    unlinkSync: fs.unlinkSync,
    symlinkSync: (...args) => {
      symlinkCalls += 1;
      if (symlinkCalls === 1) {
        throw new Error('symlink denied');
      }
      return fs.symlinkSync(...args);
    },
  };
  assert.throws(() => repointApplicationsLink({ target: oldTarget, linkPath, fsModule: failingFs }), /symlink denied/);
  assert.equal(fs.readlinkSync(linkPath), newTarget);

  fs.rmSync(linkPath);
  fs.mkdirSync(linkPath);
  assert.throws(() => repointApplicationsLink({ target: newTarget, linkPath }), /not a symlink/);
});

test('writeLocalUpdateState round-trips a readable state with previous', () => {
  const buildsDir = makeTempDir();
  createBuild(buildsDir, '1.23.1_aaaaaaa', { commit: 'a'.repeat(40) });
  createBuild(buildsDir, '1.23.0_bbbbbbb', { commit: 'b'.repeat(40) });

  writeLocalUpdateState({
    buildsDir,
    latest: { folder: '1.23.1_aaaaaaa', commit: 'a'.repeat(40), version: '1.23.1', builtAt: '2026-09-13T10:00:00.000Z' },
    previous: { folder: '1.23.0_bbbbbbb', commit: 'b'.repeat(40), version: '1.23.0', builtAt: '2026-09-12T10:00:00.000Z' },
    updatedAt: '2026-09-13T10:00:00.000Z',
  });

  const state = readLocalUpdateState({ buildsDir });
  assert.equal(state?.latest.folder, '1.23.1_aaaaaaa');
  assert.equal(state?.latest.commit, 'a'.repeat(40));
  assert.equal(state?.previous?.folder, '1.23.0_bbbbbbb');
  assert.equal(state?.updatedAt, '2026-09-13T10:00:00.000Z');
  assert.equal(fs.existsSync(path.join(buildsDir, 'state.json.tmp')), false);
});

test('writeLocalUpdateState rejects entries that cannot be loaded again', () => {
  const buildsDir = makeTempDir();
  assert.throws(
    () => writeLocalUpdateState({ buildsDir, latest: { folder: '../escape', commit: 'a'.repeat(40) } }),
    /Invalid local update entry/,
  );
  assert.throws(
    () => writeLocalUpdateState({ buildsDir, latest: { folder: 'good_folder', commit: 'not-a-commit' } }),
    /Invalid local update entry/,
  );
  assert.equal(fs.existsSync(path.join(buildsDir, 'state.json')), false);
});

test('pruneLocalUpdateBuilds removes unreferenced folders only', () => {
  const buildsDir = makeTempDir();
  for (const folder of ['1.23.1_aaaaaaa', '1.23.0_bbbbbbb', '1.22.0_ccccccc']) {
    fs.mkdirSync(path.join(buildsDir, folder, 'OpenChamber.app'), { recursive: true });
  }
  fs.mkdirSync(path.join(buildsDir, '.staging-123'));
  fs.writeFileSync(path.join(buildsDir, 'build.log'), 'log');

  const removed = pruneLocalUpdateBuilds({
    buildsDir,
    keepFolders: ['1.23.1_aaaaaaa', null],
  });

  assert.deepEqual(removed.sort(), ['1.22.0_ccccccc', '1.23.0_bbbbbbb']);
  assert.equal(fs.existsSync(path.join(buildsDir, '1.23.1_aaaaaaa')), true);
  assert.equal(fs.existsSync(path.join(buildsDir, '.staging-123')), true);
  assert.equal(fs.existsSync(path.join(buildsDir, 'build.log')), true);
});
