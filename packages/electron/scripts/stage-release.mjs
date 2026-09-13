#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { resolveReleaseUpdate, stageReleaseUpdate } from '../github-release-update.mjs';
import { resolveBuildsDir } from '../local-update.mjs';

const APPLICATIONS_LINK = '/Applications/OpenChamber.app';

// The installed symlink is the authoritative builds directory: it encodes the
// same OPENCHAMBER_DATA_DIR the running app uses, which this shell may not have.
const resolveInstalledBuildsDir = () => {
  try {
    const stats = fs.lstatSync(APPLICATIONS_LINK);
    if (!stats.isSymbolicLink()) throw new Error('installed app is not a symlinked build');
    const bundlePath = fs.realpathSync(APPLICATIONS_LINK);
    const folderPath = path.dirname(bundlePath);
    return {
      buildsDir: path.dirname(folderPath),
      runningFolder: path.basename(folderPath),
    };
  } catch {
    return {
      buildsDir: resolveBuildsDir({ environment: process.env }),
      runningFolder: null,
    };
  }
};

const main = async () => {
  const { buildsDir, runningFolder } = resolveInstalledBuildsDir();
  console.log(`[stage-release] builds directory: ${buildsDir}`);

  const update = await resolveReleaseUpdate({ currentVersion: '0.0.0' });
  if (!update) throw new Error('No personal release is available to stage');

  console.log(`[stage-release] staging ${update.version} (${update.commit.slice(0, 7)})`);
  const staged = await stageReleaseUpdate({
    buildsDir,
    update,
    runningFolder,
    onProgress: ({ downloaded, total }) => {
      const percent = total > 0 ? Math.floor((downloaded / total) * 100) : 0;
      process.stdout.write(`\r[stage-release] downloaded ${percent}%`);
    },
  });
  process.stdout.write('\n');

  console.log(`[stage-release] staged ${staged.folder}`);
  console.log('[stage-release] OpenChamber will offer the update within 5 seconds if it is running.');
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
