import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareReleaseVersions,
  downloadReleaseAsset,
  extractReleaseArchive,
  isNewerReleaseVersion,
  PERSONAL_RELEASE_REPO,
  resolveReleaseUpdate,
  stageReleaseUpdate,
} from './github-release-update.mjs';
import { readLocalUpdateState } from './local-update.mjs';

const sha512 = (buffer) => crypto.createHash('sha512').update(buffer).digest('base64');

const jsonResponse = (payload, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => null },
  json: async () => payload,
});

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-release-update-'));

const isReleaseListUrl = (url) => url.includes('/releases?per_page=10');

const buildReleasePayload = ({ version = '1.23.1-personal.1', body = 'Release notes', tag = null } = {}) => ({
  tag_name: tag || `v${version}`,
  body,
  published_at: '2026-09-13T10:00:00Z',
  html_url: `https://github.com/mobileka/openchamber/releases/tag/v${version}`,
  assets: [
    {
      name: 'personal-release.json',
      browser_download_url: 'https://github.com/mobileka/openchamber/releases/download/v/1/personal-release.json',
    },
    {
      name: `OpenChamber-${version}-mac-arm64.zip`,
      browser_download_url: 'https://github.com/mobileka/openchamber/releases/download/v/1/update.zip',
    },
  ],
});

const buildManifestPayload = ({
  version = '1.23.1-personal.1',
  commit = 'a'.repeat(40),
  sha = 'A'.repeat(86) + '==',
  size = 1024,
} = {}) => ({
  version,
  commit,
  builtAt: '2026-09-13T10:00:00Z',
  assetName: `OpenChamber-${version}-mac-arm64.zip`,
  sha512: sha,
  size,
});

test('compares fork personal versions against the upstream baseline', () => {
  assert.equal(compareReleaseVersions('1.23.1-personal.1', '1.23.1'), 1);
  assert.equal(compareReleaseVersions('1.23.1', '1.23.1-personal.1'), -1);
  assert.equal(compareReleaseVersions('1.23.1-personal.2', '1.23.1-personal.1'), 1);
  assert.equal(compareReleaseVersions('1.23.1-personal.1', '1.23.1-personal.1'), 0);
  assert.equal(compareReleaseVersions('1.23.2-personal.1', '1.23.1-personal.9'), 1);
  assert.equal(compareReleaseVersions('1.24.0-personal.1', '1.23.9-personal.9'), 1);
  assert.equal(compareReleaseVersions('v1.23.1-personal.3', '1.23.1-personal.3'), 0);
});

test('rejects compared versions that are not release versions', () => {
  assert.throws(() => compareReleaseVersions('nightly', '1.23.1'), /Invalid release version/);
  assert.throws(() => compareReleaseVersions('1.23.1-personal.1', 'main'), /Invalid release version/);
});

test('only strictly newer release versions are offered', () => {
  assert.equal(isNewerReleaseVersion('1.23.1-personal.2', '1.23.1-personal.1'), true);
  assert.equal(isNewerReleaseVersion('1.23.1-personal.1', '1.23.1-personal.1'), false);
  assert.equal(isNewerReleaseVersion('1.23.0-personal.1', '1.23.1'), false);
});

test('resolves a newer release with a verified manifest', async () => {
  const release = buildReleasePayload();
  const manifest = buildManifestPayload();
  const fetchImpl = async (url) => {
    if (isReleaseListUrl(url)) return jsonResponse([release]);
    if (url.endsWith('personal-release.json')) return jsonResponse(manifest);
    throw new Error(`Unexpected URL: ${url}`);
  };

  const update = await resolveReleaseUpdate({ currentVersion: '1.23.1', fetchImpl });
  assert.equal(update.available, true);
  assert.equal(update.version, '1.23.1-personal.1');
  assert.equal(update.body, 'Release notes');
  assert.equal(update.commit, 'a'.repeat(40));
  assert.equal(update.sha512, manifest.sha512);
  assert.equal(update.assetUrl, release.assets[1].browser_download_url);
  assert.equal(update.releaseUrl, release.html_url);
});

test('treats a repository without releases as no update', async () => {
  const fetchImpl = async () => jsonResponse([]);
  assert.equal(await resolveReleaseUpdate({ currentVersion: '1.23.1', fetchImpl }), null);
});

test('does not offer releases that are not newer than the running version', async () => {
  const release = buildReleasePayload();
  const fetchImpl = async (url) => {
    if (isReleaseListUrl(url)) return jsonResponse([release]);
    throw new Error(`Unexpected URL: ${url}`);
  };
  assert.equal(await resolveReleaseUpdate({ currentVersion: '1.23.2', fetchImpl }), null);
  assert.equal(await resolveReleaseUpdate({ currentVersion: '1.23.1-personal.9', fetchImpl }), null);
});

test('skips releases that are not from the personal channel', async () => {
  const official = buildReleasePayload({ version: '1.24.0', tag: 'v1.24.0' });
  official.assets = [];
  const personal = buildReleasePayload();
  const manifest = buildManifestPayload();
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    if (isReleaseListUrl(url)) return jsonResponse([official, personal]);
    if (url.endsWith('personal-release.json')) return jsonResponse(manifest);
    throw new Error(`Unexpected URL: ${url}`);
  };
  const update = await resolveReleaseUpdate({ currentVersion: '1.23.1', fetchImpl });
  assert.equal(update.version, '1.23.1-personal.1');
  assert.equal(requests, 2);
});

test('rejects releases without the personal manifest', async () => {
  const release = buildReleasePayload();
  release.assets = release.assets.filter((asset) => asset.name !== 'personal-release.json');
  const fetchImpl = async (url) => {
    if (isReleaseListUrl(url)) return jsonResponse([release]);
    throw new Error(`Unexpected URL: ${url}`);
  };
  await assert.rejects(
    resolveReleaseUpdate({ currentVersion: '1.23.1', fetchImpl }),
    /missing personal-release\.json/,
  );
});

test('rejects a manifest whose version does not match the release tag', async () => {
  const release = buildReleasePayload();
  const manifest = buildManifestPayload({ version: '1.24.0-personal.1' });
  const fetchImpl = async (url) => {
    if (isReleaseListUrl(url)) return jsonResponse([release]);
    if (url.endsWith('personal-release.json')) return jsonResponse(manifest);
    throw new Error(`Unexpected URL: ${url}`);
  };
  await assert.rejects(
    resolveReleaseUpdate({ currentVersion: '1.23.1', fetchImpl }),
    /manifest for .* is invalid/,
  );
});

test('surfaces HTTP failures instead of reporting no update', async () => {
  const fetchImpl = async () => jsonResponse({}, 500);
  await assert.rejects(resolveReleaseUpdate({ currentVersion: '1.23.1', fetchImpl }), /HTTP 500/);
});

test('downloads an asset only when size and sha512 match', async () => {
  const directory = makeTempDir();
  const destination = path.join(directory, 'update.zip');
  const payload = Buffer.from('signed release payload');
  const fetchImpl = async () => new Response(payload, {
    status: 200,
    headers: { 'content-length': String(payload.length) },
  });

  const result = await downloadReleaseAsset({
    url: 'https://example.com/update.zip',
    destination,
    expectedSha512: sha512(payload),
    expectedSize: payload.length,
    fetchImpl,
  });
  assert.equal(result.size, payload.length);
  assert.equal(fs.readFileSync(destination).toString(), payload.toString());
});

test('removes a downloaded asset that fails verification', async () => {
  const directory = makeTempDir();
  const destination = path.join(directory, 'update.zip');
  const payload = Buffer.from('tampered payload');
  const fetchImpl = async () => new Response(payload, {
    status: 200,
    headers: { 'content-length': String(payload.length) },
  });

  await assert.rejects(
    downloadReleaseAsset({
      url: 'https://example.com/update.zip',
      destination,
      expectedSha512: sha512(Buffer.from('expected payload')),
      expectedSize: payload.length,
      fetchImpl,
    }),
    /integrity verification/,
  );
  assert.equal(fs.existsSync(destination), false);
});

test('fails a stalled download instead of leaving it pending', async () => {
  const directory = makeTempDir();
  const destination = path.join(directory, 'update.zip');
  const fetchImpl = async (url, options) => new Response(new ReadableStream({
    start(controller) {
      options?.signal?.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    },
  }), {
    status: 200,
    headers: { 'content-length': '10' },
  });

  await assert.rejects(
    downloadReleaseAsset({
      url: 'https://example.com/update.zip',
      destination,
      expectedSha512: 'A'.repeat(86) + '==',
      expectedSize: 10,
      fetchImpl,
      stallTimeoutMs: 25,
    }),
    /stalled/,
  );
});

test('removes the staging directory after a stalled download', async () => {
  const buildsDir = makeTempDir();
  const fetchImpl = async (url, options) => new Response(new ReadableStream({
    start(controller) {
      options?.signal?.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    },
  }), { status: 200 });

  await assert.rejects(
    stageReleaseUpdate({
      buildsDir,
      update: {
        version: '1.23.1-personal.1',
        commit: 'b'.repeat(40),
        builtAt: '2026-09-13T10:00:00Z',
        assetUrl: 'https://example.com/update.zip',
        sha512: 'A'.repeat(86) + '==',
        size: 10,
      },
      fetchImpl,
      stallTimeoutMs: 25,
    }),
    /stalled/,
  );
  assert.deepEqual(
    fs.readdirSync(buildsDir).filter((entry) => entry.startsWith('.staging-')),
    [],
  );
});

test('extracts through ditto and requires the app bundle', async () => {
  const directory = makeTempDir();
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    fs.mkdirSync(path.join(args[3], 'OpenChamber.app'));
    callback(null, { stdout: '', stderr: '' });
  };

  const archivePath = path.join(directory, 'update.zip');
  const destinationDir = path.join(directory, 'payload');
  fs.mkdirSync(destinationDir);
  const appPath = await extractReleaseArchive({ archivePath, destinationDir, execFileImpl });
  assert.equal(appPath, path.join(destinationDir, 'OpenChamber.app'));
  assert.equal(calls[0].file, 'ditto');
  assert.deepEqual(calls[0].args, ['-x', '-k', archivePath, destinationDir]);
});

test('fails extraction when the archive has no app bundle', async () => {
  const directory = makeTempDir();
  const destinationDir = path.join(directory, 'payload');
  fs.mkdirSync(destinationDir);
  const execFileImpl = (file, args, options, callback) => callback(null, { stdout: '', stderr: '' });
  await assert.rejects(
    extractReleaseArchive({
      archivePath: path.join(directory, 'update.zip'),
      destinationDir,
      execFileImpl,
    }),
    /does not contain OpenChamber\.app/,
  );
});

test('stages a release into the builds directory and updates state', async () => {
  const buildsDir = makeTempDir();
  const payload = Buffer.from('release bundle archive');
  const version = '1.23.1-personal.1';
  const commit = 'b'.repeat(40);
  const sha = sha512(payload);

  const staleFolder = path.join(buildsDir, '1.23.0_aaaaaaa');
  fs.mkdirSync(path.join(staleFolder, 'OpenChamber.app'), { recursive: true });
  const previousFolder = path.join(buildsDir, '1.23.1_ccccccc');
  fs.mkdirSync(path.join(previousFolder, 'OpenChamber.app'), { recursive: true });
  fs.writeFileSync(path.join(buildsDir, 'state.json'), `${JSON.stringify({
    latest: {
      folder: '1.23.1_ccccccc',
      commit: 'c'.repeat(40),
      version: '1.23.1',
      builtAt: '2026-09-12T00:00:00.000Z',
    },
    updatedAt: '2026-09-12T00:00:00.000Z',
  }, null, 2)}\n`);

  const fetchImpl = async () => new Response(payload, {
    status: 200,
    headers: { 'content-length': String(payload.length) },
  });
  const execFileImpl = (file, args, options, callback) => {
    fs.mkdirSync(path.join(args[3], 'OpenChamber.app'));
    callback(null, { stdout: '', stderr: '' });
  };

  const staged = await stageReleaseUpdate({
    buildsDir,
    update: {
      version,
      commit,
      builtAt: '2026-09-13T10:00:00Z',
      assetUrl: 'https://example.com/update.zip',
      sha512: sha,
      size: payload.length,
      body: 'Release notes',
    },
    runningFolder: '1.23.1_ccccccc',
    fetchImpl,
    execFileImpl,
  });

  assert.equal(staged.folder, `${version}_${commit.slice(0, 7)}`);
  assert.equal(fs.existsSync(staged.appPath), true);
  assert.equal(fs.existsSync(path.join(buildsDir, staged.folder, 'build.json')), true);
  assert.equal(fs.existsSync(staleFolder), false);
  assert.equal(fs.existsSync(previousFolder), true);

  const state = readLocalUpdateState({ buildsDir });
  assert.equal(state.latest.folder, staged.folder);
  assert.equal(state.latest.commit, commit);
  assert.equal(state.previous.folder, '1.23.1_ccccccc');
});

test('refuses to re-download the build that is currently running', async () => {
  const buildsDir = makeTempDir();
  const fetchImpl = async () => {
    throw new Error('The download must not start');
  };
  await assert.rejects(
    stageReleaseUpdate({
      buildsDir,
      update: {
        version: '1.23.1-personal.1',
        commit: 'b'.repeat(40),
        builtAt: '2026-09-13T10:00:00Z',
        assetUrl: 'https://example.com/update.zip',
        sha512: 'A'.repeat(86) + '==',
        size: 10,
      },
      runningFolder: `1.23.1-personal.1_${'b'.repeat(7)}`,
      fetchImpl,
    }),
    /already the running build/,
  );
});

test('staging fails before touching state when the download fails', async () => {
  const buildsDir = makeTempDir();
  fs.writeFileSync(path.join(buildsDir, 'state.json'), `${JSON.stringify({
    latest: {
      folder: '1.23.1_ccccccc',
      commit: 'c'.repeat(40),
      version: '1.23.1',
      builtAt: '2026-09-12T00:00:00.000Z',
    },
    updatedAt: '2026-09-12T00:00:00.000Z',
  }, null, 2)}\n`);
  const before = fs.readFileSync(path.join(buildsDir, 'state.json'), 'utf8');

  const fetchImpl = async () => jsonResponse({}, 500);
  await assert.rejects(
    stageReleaseUpdate({
      buildsDir,
      update: {
        version: '1.23.1-personal.1',
        commit: 'b'.repeat(40),
        builtAt: '2026-09-13T10:00:00Z',
        assetUrl: 'https://example.com/update.zip',
        sha512: 'A'.repeat(86) + '==',
        size: 10,
      },
      fetchImpl,
    }),
    /HTTP 500/,
  );
  assert.equal(fs.readFileSync(path.join(buildsDir, 'state.json'), 'utf8'), before);
  assert.deepEqual(
    fs.readdirSync(buildsDir).filter((entry) => entry.startsWith('.staging-')),
    [],
  );
});

test('uses the fork repository as the release source', () => {
  assert.deepEqual(PERSONAL_RELEASE_REPO, { owner: 'mobileka', repo: 'openchamber' });
});
