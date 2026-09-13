import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./personal-release-manifest.mjs', import.meta.url));

const makeFixture = ({ version = '1.23.1-personal.1', assetName = null } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-personal-manifest-'));
  const assetPath = path.join(root, assetName || `OpenChamber-${version}-mac-arm64.zip`);
  fs.writeFileSync(assetPath, 'release archive bytes');
  return { root, assetPath, manifestPath: path.join(root, 'personal-release.json') };
};

const environment = ({ assetPath, manifestPath }, overrides = {}) => ({
  ...process.env,
  RELEASE_VERSION: '1.23.1-personal.1',
  RELEASE_COMMIT: 'a'.repeat(40),
  RELEASE_BUILT_AT: '2026-09-13T10:00:00.000Z',
  RELEASE_ASSET_PATH: assetPath,
  RELEASE_MANIFEST_PATH: manifestPath,
  ...overrides,
});

test('writes a manifest whose sha512 and size describe the package', (context) => {
  const fixture = makeFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  execFileSync(process.execPath, [script], { env: environment(fixture) });

  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  const bytes = fs.readFileSync(fixture.assetPath);
  assert.equal(manifest.version, '1.23.1-personal.1');
  assert.equal(manifest.commit, 'a'.repeat(40));
  assert.equal(manifest.builtAt, '2026-09-13T10:00:00.000Z');
  assert.equal(manifest.assetName, 'OpenChamber-1.23.1-personal.1-mac-arm64.zip');
  assert.equal(manifest.size, bytes.length);
  assert.equal(manifest.sha512, crypto.createHash('sha512').update(bytes).digest('base64'));
});

test('refuses to describe an asset that does not match the version', (context) => {
  const fixture = makeFixture({ assetName: 'OpenChamber-1.23.1-mac-arm64.zip' });
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [script], { env: environment(fixture), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release asset must be/);
});

test('requires a personal release version and a hex commit', (context) => {
  const fixture = makeFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const badVersion = spawnSync(process.execPath, [script], {
    env: environment(fixture, { RELEASE_VERSION: '1.23.1' }),
    encoding: 'utf8',
  });
  assert.notEqual(badVersion.status, 0);
  assert.match(badVersion.stderr, /RELEASE_VERSION is invalid/);

  const badCommit = spawnSync(process.execPath, [script], {
    env: environment(fixture, { RELEASE_COMMIT: 'not-a-commit' }),
    encoding: 'utf8',
  });
  assert.notEqual(badCommit.status, 0);
  assert.match(badCommit.stderr, /RELEASE_COMMIT is invalid/);
});
