import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import {
  pruneLocalUpdateBuilds,
  readLocalUpdateState,
  writeLocalUpdateState,
} from './local-update.mjs';

export const PERSONAL_RELEASE_REPO = Object.freeze({
  owner: 'mobileka',
  repo: 'openchamber',
});

const RELEASE_MANIFEST_ASSET = 'personal-release.json';
const RELEASE_APP_BUNDLE = 'OpenChamber.app';

const GITHUB_REQUEST_HEADERS = Object.freeze({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'OpenChamber-Desktop-Updater',
});
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;
const PERSONAL_PRERELEASE_PATTERN = /^personal\.(\d+)$/;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const PROGRESS_THROTTLE_MS = 250;

const parseReleaseVersion = (value) => {
  const match = VERSION_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4] : null,
  };
};

/**
 * Personal builds are a fork channel: a personal build of X supersedes plain X,
 * and later personal builds of the same X win by build sequence.
 */
export const compareReleaseVersions = (left, right) => {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) throw new Error(`Invalid release version comparison: ${left} vs ${right}`);

  for (let index = 0; index < 3; index += 1) {
    const diff = a.core[index] - b.core[index];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  if (a.prerelease === b.prerelease) return 0;
  const aSequence = a.prerelease ? PERSONAL_PRERELEASE_PATTERN.exec(a.prerelease) : null;
  const bSequence = b.prerelease ? PERSONAL_PRERELEASE_PATTERN.exec(b.prerelease) : null;
  if (aSequence || bSequence) {
    const leftValue = aSequence ? Number(aSequence[1]) : 0;
    const rightValue = bSequence ? Number(bSequence[1]) : 0;
    if (leftValue === rightValue) return 0;
    return leftValue > rightValue ? 1 : -1;
  }
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease > b.prerelease ? 1 : -1;
};

export const isNewerReleaseVersion = (candidate, current) => (
  compareReleaseVersions(candidate, current) > 0
);

const isPersonalReleaseVersion = (value) => {
  const parsed = parseReleaseVersion(value);
  return Boolean(parsed && parsed.prerelease && PERSONAL_PRERELEASE_PATTERN.test(parsed.prerelease));
};

const parseReleaseAssets = (value) => {
  if (!Array.isArray(value)) return [];
  const assets = [];
  for (const asset of value) {
    if (!asset || typeof asset !== 'object') continue;
    const name = typeof asset.name === 'string' ? asset.name.trim() : '';
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
    if (name && url) assets.push({ name, url });
  }
  return assets;
};

const parseLatestRelease = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const tagName = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
  const version = tagName.replace(/^v/, '');
  if (!tagName || !parseReleaseVersion(version)) return null;
  return {
    tagName,
    version,
    body: typeof payload.body === 'string' && payload.body.trim() ? payload.body.trim() : null,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null,
    htmlUrl: typeof payload.html_url === 'string' ? payload.html_url : null,
    assets: parseReleaseAssets(payload.assets),
  };
};

const parseReleaseManifest = (payload, expectedVersion) => {
  if (!payload || typeof payload !== 'object') return null;
  const version = typeof payload.version === 'string' ? payload.version.trim() : '';
  const commit = typeof payload.commit === 'string' ? payload.commit.trim().toLowerCase() : '';
  const builtAt = typeof payload.builtAt === 'string' ? payload.builtAt.trim() : '';
  const assetName = typeof payload.assetName === 'string' ? payload.assetName.trim() : '';
  const sha512 = typeof payload.sha512 === 'string' ? payload.sha512.trim() : '';
  const size = Number(payload.size);
  if (version !== expectedVersion) return null;
  if (!COMMIT_PATTERN.test(commit) || !Number.isFinite(Date.parse(builtAt))) return null;
  if (assetName !== `OpenChamber-${version}-mac-arm64.zip`) return null;
  if (!SHA512_BASE64_PATTERN.test(sha512) || !Number.isSafeInteger(size) || size <= 0) return null;
  return { version, commit, builtAt, assetName, sha512, size };
};

const findReleaseAsset = (release, name) => (
  release.assets.find((asset) => asset.name === name) || null
);

const requestGithubJson = async ({ url, fetchImpl, timeoutMs }) => {
  const response = await fetchImpl(url, {
    headers: GITHUB_REQUEST_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
};

/**
 * Resolves a newer published release for the personal channel, or null when the
 * repo has no releases or the running version is current. Network and manifest
 * failures throw so they are never reported as "up to date".
 */
export const resolveReleaseUpdate = async ({
  currentVersion,
  repository = PERSONAL_RELEASE_REPO,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) => {
  const { owner, repo } = repository;
  const response = await requestGithubJson({
    url: `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    fetchImpl,
    timeoutMs,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Release check failed (HTTP ${response.status})`);
  }
  const release = parseLatestRelease(await response.json());
  if (!release) throw new Error('The latest GitHub release is not a valid update source');
  // Releases that are not from the personal channel are ignored rather than
  // treated as broken updates.
  if (!isPersonalReleaseVersion(release.version)) return null;
  if (!isNewerReleaseVersion(release.version, currentVersion)) return null;

  const manifestAsset = findReleaseAsset(release, RELEASE_MANIFEST_ASSET);
  if (!manifestAsset) {
    throw new Error(`Release ${release.tagName} is missing ${RELEASE_MANIFEST_ASSET}`);
  }
  const manifestResponse = await requestGithubJson({
    url: manifestAsset.url,
    fetchImpl,
    timeoutMs,
  });
  if (!manifestResponse.ok) {
    throw new Error(`Release manifest download failed (HTTP ${manifestResponse.status})`);
  }
  const manifest = parseReleaseManifest(await manifestResponse.json(), release.version);
  if (!manifest) throw new Error(`Release manifest for ${release.tagName} is invalid`);

  const updateAsset = findReleaseAsset(release, manifest.assetName);
  if (!updateAsset) {
    throw new Error(`Release ${release.tagName} is missing ${manifest.assetName}`);
  }

  return {
    available: true,
    version: release.version,
    body: release.body,
    date: release.publishedAt,
    releaseUrl: release.htmlUrl,
    tagName: release.tagName,
    commit: manifest.commit,
    builtAt: manifest.builtAt,
    assetName: manifest.assetName,
    assetUrl: updateAsset.url,
    sha512: manifest.sha512,
    size: manifest.size,
  };
};

export const downloadReleaseAsset = async ({
  url,
  destination,
  expectedSha512,
  expectedSize,
  fetchImpl = fetch,
  onProgress,
} = {}) => {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': GITHUB_REQUEST_HEADERS['User-Agent'] },
  });
  if (!response.ok) throw new Error(`Update download failed (HTTP ${response.status})`);
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Update download returned no body');
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  const total = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : expectedSize;
  const hash = crypto.createHash('sha512');
  let downloaded = 0;
  let lastReportedAt = 0;

  const report = (force) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastReportedAt < PROGRESS_THROTTLE_MS) return;
    lastReportedAt = now;
    onProgress({ downloaded, total });
  };

  await pipeline(
    Readable.fromWeb(response.body),
    async function* hashChunks(source) {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        downloaded += buffer.length;
        hash.update(buffer);
        report(false);
        yield buffer;
      }
    },
    fs.createWriteStream(destination),
  );
  report(true);

  const actualSha512 = hash.digest('base64');
  const actualSize = fs.statSync(destination).size;
  if (actualSize !== expectedSize || actualSha512 !== expectedSha512) {
    fs.rmSync(destination, { force: true });
    throw new Error('The downloaded update failed integrity verification');
  }
  return { size: actualSize, sha512: actualSha512 };
};

export const extractReleaseArchive = async ({
  archivePath,
  destinationDir,
  execFileImpl = execFile,
} = {}) => {
  await promisify(execFileImpl)('ditto', ['-x', '-k', archivePath, destinationDir], {
    maxBuffer: 1024 * 1024,
  });
  const appPath = path.join(destinationDir, RELEASE_APP_BUNDLE);
  if (!fs.existsSync(appPath)) {
    throw new Error(`Update archive does not contain ${RELEASE_APP_BUNDLE}`);
  }
  return appPath;
};

const parseStagedUpdate = (update) => {
  const version = typeof update?.version === 'string' ? update.version.trim() : '';
  const commit = typeof update?.commit === 'string' ? update.commit.trim().toLowerCase() : '';
  const assetUrl = typeof update?.assetUrl === 'string' ? update.assetUrl : '';
  const sha512 = typeof update?.sha512 === 'string' ? update.sha512 : '';
  const builtAt = typeof update?.builtAt === 'string' ? update.builtAt.trim() : '';
  const size = Number(update?.size);
  if (!parseReleaseVersion(version)) return null;
  if (!COMMIT_PATTERN.test(commit)) return null;
  if (!assetUrl || !SHA512_BASE64_PATTERN.test(sha512)) return null;
  if (!Number.isFinite(Date.parse(builtAt))) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  return { version, commit, assetUrl, sha512, builtAt, size };
};

export const stageReleaseUpdate = async ({
  buildsDir,
  update,
  runningFolder = null,
  fetchImpl = fetch,
  execFileImpl = execFile,
  onProgress,
} = {}) => {
  if (typeof buildsDir !== 'string' || !path.isAbsolute(buildsDir)) {
    throw new Error('buildsDir must be an absolute path');
  }
  const release = parseStagedUpdate(update);
  if (!release) throw new Error('Release update metadata is incomplete');

  const folder = `${release.version}_${release.commit.slice(0, 7)}`;
  if (runningFolder && folder === runningFolder) {
    throw new Error('The latest release is already the running build');
  }
  const stagedAppPath = path.join(buildsDir, folder, RELEASE_APP_BUNDLE);
  fs.mkdirSync(buildsDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(buildsDir, '.staging-'));

  try {
    const archivePath = path.join(stagingDir, 'update.zip');
    await downloadReleaseAsset({
      url: release.assetUrl,
      destination: archivePath,
      expectedSha512: release.sha512,
      expectedSize: release.size,
      fetchImpl,
      onProgress,
    });

    const extractDir = path.join(stagingDir, 'payload');
    fs.mkdirSync(extractDir);
    await extractReleaseArchive({ archivePath, destinationDir: extractDir, execFileImpl });
    fs.writeFileSync(
      path.join(extractDir, 'build.json'),
      `${JSON.stringify({ notes: typeof update.body === 'string' ? update.body : null, localChanges: null }, null, 2)}\n`,
      'utf8',
    );

    const previousState = readLocalUpdateState({ buildsDir });
    const finalPath = path.join(buildsDir, folder);
    fs.rmSync(finalPath, { recursive: true, force: true });
    fs.renameSync(extractDir, finalPath);
    writeLocalUpdateState({
      buildsDir,
      latest: {
        folder,
        commit: release.commit,
        version: release.version,
        builtAt: release.builtAt,
      },
      previous: previousState?.latest ?? null,
    });
    pruneLocalUpdateBuilds({
      buildsDir,
      keepFolders: [folder, previousState?.latest?.folder, runningFolder],
    });

    return {
      folder,
      appPath: stagedAppPath,
      commit: release.commit,
      version: release.version,
      builtAt: release.builtAt,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
};
