import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./personal-release-version.mjs', import.meta.url));

const run = (environment) => execFileSync(process.execPath, [script], {
  env: { ...process.env, BASE_VERSION: '', LATEST_TAG: '', ...environment },
  encoding: 'utf8',
});

const runExpectFailure = (environment) => spawnSync(process.execPath, [script], {
  env: { ...process.env, BASE_VERSION: '', LATEST_TAG: '', ...environment },
  encoding: 'utf8',
});

test('starts the personal channel at the upstream base', () => {
  assert.equal(run({ BASE_VERSION: '1.23.1', LATEST_TAG: '' }), '1.23.1-personal.1');
});

test('increments the personal sequence for the same upstream base', () => {
  assert.equal(run({ BASE_VERSION: '1.23.1', LATEST_TAG: 'v1.23.1-personal.4' }), '1.23.1-personal.5');
  assert.equal(run({ BASE_VERSION: '1.23.1', LATEST_TAG: '1.23.1-personal.9' }), '1.23.1-personal.10');
});

test('moves to a new upstream base when the fork merges a version bump', () => {
  assert.equal(run({ BASE_VERSION: '1.23.2', LATEST_TAG: 'v1.23.1-personal.9' }), '1.23.2-personal.1');
});

test('stays above the personal line when the base lags behind', () => {
  assert.equal(run({ BASE_VERSION: '1.22.0', LATEST_TAG: 'v1.23.1-personal.2' }), '1.23.1-personal.3');
});

test('rejects a base version that is not plain x.y.z', () => {
  const result = runExpectFailure({ BASE_VERSION: 'main', LATEST_TAG: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BASE_VERSION must be a plain x\.y\.z version/);
});

test('rejects a latest tag that is not a personal release', () => {
  const result = runExpectFailure({ BASE_VERSION: '1.23.1', LATEST_TAG: 'v1.23.1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LATEST_TAG is not a personal release/);
});
