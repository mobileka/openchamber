import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearRestartNotifyMarker,
  readRestartNotifyMarker,
  restartNotifyMarkerPath,
} from './restart-notify.mjs';

const withTempDir = async (run) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openchamber-restart-notify-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('reads a fresh marker', () => withTempDir(async (dir) => {
  await writeFile(restartNotifyMarkerPath(dir), JSON.stringify({ requestedAt: 1_000 }), 'utf8');
  assert.deepEqual(readRestartNotifyMarker(dir, { now: 2_000, maxAgeMs: 5_000 }), { requestedAt: 1_000 });
}));

test('ignores a marker older than the TTL', () => withTempDir(async (dir) => {
  await writeFile(restartNotifyMarkerPath(dir), JSON.stringify({ requestedAt: 1_000 }), 'utf8');
  assert.equal(readRestartNotifyMarker(dir, { now: 10_000, maxAgeMs: 5_000 }), null);
}));

test('ignores malformed and missing markers', () => withTempDir(async (dir) => {
  assert.equal(readRestartNotifyMarker(dir), null);
  await writeFile(restartNotifyMarkerPath(dir), 'not json', 'utf8');
  assert.equal(readRestartNotifyMarker(dir), null);
  await writeFile(restartNotifyMarkerPath(dir), JSON.stringify({ requestedAt: 'soon' }), 'utf8');
  assert.equal(readRestartNotifyMarker(dir), null);
}));

test('clearing removes the marker and tolerates a missing file', () => withTempDir(async (dir) => {
  await writeFile(restartNotifyMarkerPath(dir), JSON.stringify({ requestedAt: 1_000 }), 'utf8');
  await clearRestartNotifyMarker(dir);
  assert.equal(readRestartNotifyMarker(dir), null);
  await clearRestartNotifyMarker(dir);
}));
