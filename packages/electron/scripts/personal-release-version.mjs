#!/usr/bin/env node
const CORE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const PERSONAL_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)-personal\.(\d+)$/;

const compareCores = (left, right) => (
  (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2])
);

// Personal releases track the upstream base version and add a fork channel
// suffix, so they never reuse or collide with official release numbers.
const computePersonalReleaseVersion = ({ baseVersion, latestTag }) => {
  const baseMatch = CORE_PATTERN.exec(String(baseVersion || '').trim());
  if (!baseMatch) throw new Error(`BASE_VERSION must be a plain x.y.z version, got: ${baseVersion || '(missing)'}`);
  const base = baseMatch.slice(1).map(Number);

  const rawLatest = String(latestTag || '').trim();
  if (!rawLatest) return `${base.join('.')}-personal.1`;

  const latestMatch = PERSONAL_TAG_PATTERN.exec(rawLatest);
  if (!latestMatch) {
    throw new Error(`LATEST_TAG is not a personal release: ${rawLatest}`);
  }

  const latestCore = [Number(latestMatch[1]), Number(latestMatch[2]), Number(latestMatch[3])];
  if (compareCores(base, latestCore) > 0) return `${base.join('.')}-personal.1`;
  return `${latestCore.join('.')}-personal.${Number(latestMatch[4]) + 1}`;
};

try {
  const version = computePersonalReleaseVersion({
    baseVersion: process.env.BASE_VERSION,
    latestTag: process.env.LATEST_TAG,
  });
  process.stdout.write(version);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
