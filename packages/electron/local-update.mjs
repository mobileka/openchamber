import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_FILE_NAME = 'state.json';
const BUILD_FILE_NAME = 'build.json';
const APP_BUNDLE_NAME = 'OpenChamber.app';
const FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

const parseTime = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readText = (readFile, filePath) => {
  try {
    return readFile(filePath, 'utf8');
  } catch {
    return null;
  }
};

export const resolveBuildsDir = ({
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) => {
  const configured = typeof environment.OPENCHAMBER_DATA_DIR === 'string'
    ? environment.OPENCHAMBER_DATA_DIR.trim()
    : '';
  const dataDir = configured
    ? path.resolve(configured)
    : path.join(homeDirectory, '.config', 'openchamber');
  return path.join(dataDir, 'builds');
};

const parseEntry = (entry, buildsDir, exists) => {
  if (!entry || typeof entry !== 'object') return null;
  const folder = typeof entry.folder === 'string' ? entry.folder.trim() : '';
  const commit = typeof entry.commit === 'string' ? entry.commit.trim() : '';
  if (!folder || folder === '.' || folder === '..' || !FOLDER_PATTERN.test(folder)) return null;
  if (!COMMIT_PATTERN.test(commit)) return null;
  const appPath = path.join(buildsDir, folder, APP_BUNDLE_NAME);
  if (!exists(appPath)) return null;
  return {
    folder,
    commit: commit.toLowerCase(),
    version: typeof entry.version === 'string' ? entry.version.trim() : '',
    builtAt: typeof entry.builtAt === 'string' ? entry.builtAt.trim() : '',
    appPath,
  };
};

export const readLocalUpdateState = ({
  buildsDir,
  readFile = fs.readFileSync,
  exists = fs.existsSync,
} = {}) => {
  const raw = readText(readFile, path.join(buildsDir, STATE_FILE_NAME));
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const latest = parseEntry(parsed?.latest, buildsDir, exists);
  if (!latest) return null;
  return {
    latest,
    previous: parseEntry(parsed?.previous, buildsDir, exists),
    updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
  };
};

export const evaluateLocalUpdate = ({
  state,
  runningCommit = null,
  runningBuiltAt = null,
} = {}) => {
  const latest = state?.latest;
  if (!latest) return null;
  if (typeof runningCommit === 'string' && runningCommit.trim().toLowerCase() === latest.commit) {
    return null;
  }
  const runningTime = parseTime(runningBuiltAt);
  const candidateTime = parseTime(latest.builtAt);
  if (runningTime !== null && candidateTime !== null && candidateTime <= runningTime) {
    return null;
  }
  return {
    folder: latest.folder,
    commit: latest.commit,
    version: latest.version,
    builtAt: latest.builtAt,
    appPath: latest.appPath,
  };
};

export const readLocalUpdateNotes = ({
  folderPath,
  readFile = fs.readFileSync,
} = {}) => {
  const raw = readText(readFile, path.join(folderPath, BUILD_FILE_NAME));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.notes === 'string' && parsed.notes.trim() ? parsed.notes.trim() : null;
  } catch {
    return null;
  }
};

export const repointApplicationsLink = ({
  target,
  linkPath = '/Applications/OpenChamber.app',
  fsModule = fs,
} = {}) => {
  let stats;
  try {
    stats = fsModule.lstatSync(linkPath);
  } catch {
    throw new Error(`OpenChamber is not installed at ${linkPath}`);
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(`${linkPath} is not a symlink. Run the one-time migration that moves the app into builds/ and links it back.`);
  }
  const currentTarget = fsModule.readlinkSync(linkPath);
  if (currentTarget === target) return false;
  fsModule.unlinkSync(linkPath);
  try {
    fsModule.symlinkSync(target, linkPath);
  } catch (error) {
    try {
      fsModule.symlinkSync(currentTarget, linkPath);
    } catch {
    }
    throw error;
  }
  return true;
};

export { STATE_FILE_NAME };
