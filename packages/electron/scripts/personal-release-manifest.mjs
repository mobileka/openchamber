#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION_PATTERN = /^\d+\.\d+\.\d+-personal\.\d+$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

try {
  const version = String(process.env.RELEASE_VERSION || '').trim();
  const commit = String(process.env.RELEASE_COMMIT || '').trim().toLowerCase();
  const builtAt = String(process.env.RELEASE_BUILT_AT || '').trim();
  const assetPath = String(process.env.RELEASE_ASSET_PATH || '').trim();
  const manifestPath = String(process.env.RELEASE_MANIFEST_PATH || '').trim();

  if (!VERSION_PATTERN.test(version)) throw new Error(`RELEASE_VERSION is invalid: ${version || '(missing)'}`);
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`RELEASE_COMMIT is invalid: ${commit || '(missing)'}`);
  if (!Number.isFinite(Date.parse(builtAt))) throw new Error(`RELEASE_BUILT_AT is invalid: ${builtAt || '(missing)'}`);
  if (!assetPath || !fs.statSync(assetPath).isFile()) throw new Error(`RELEASE_ASSET_PATH is not a file: ${assetPath || '(missing)'}`);
  if (!manifestPath) throw new Error('RELEASE_MANIFEST_PATH is required');

  const assetName = path.basename(assetPath);
  if (assetName !== `OpenChamber-${version}-mac-arm64.zip`) {
    throw new Error(`Release asset must be OpenChamber-${version}-mac-arm64.zip, got: ${assetName}`);
  }

  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(assetPath)).digest('base64');
  const size = fs.statSync(assetPath).size;
  const manifest = { version, commit, builtAt, assetName, sha512, size };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[personal-release] wrote ${manifestPath} for ${assetName} (${size} bytes)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
