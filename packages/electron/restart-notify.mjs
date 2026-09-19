// Marker lifecycle for the post-restart confirmation.
//
// The desktop restart endpoint (packages/web/server/lib/opencode/openchamber-routes.js)
// writes this file right before it schedules the restart. The next launch reads
// it once, posts a one-line confirmation into the most recent session, and
// removes it. Anything older than the TTL comes from a restart that never
// happened (or failed halfway) and is discarded without a notice.
import fs from 'node:fs';
import path from 'node:path';

export const RESTART_NOTIFY_MARKER_FILE = 'restart-notify.json';
export const RESTART_NOTIFY_MARKER_MAX_AGE_MS = 5 * 60 * 1000;

export const restartNotifyMarkerPath = (dataDir) => path.join(dataDir, RESTART_NOTIFY_MARKER_FILE);

export const readRestartNotifyMarker = (dataDir, {
  now = Date.now(),
  maxAgeMs = RESTART_NOTIFY_MARKER_MAX_AGE_MS,
} = {}) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(restartNotifyMarkerPath(dataDir), 'utf8'));
    const requestedAt = Number(parsed?.requestedAt);
    if (!Number.isFinite(requestedAt)) return null;
    if (now - requestedAt > maxAgeMs) return null;
    return { requestedAt };
  } catch {
    return null;
  }
};

export const clearRestartNotifyMarker = async (dataDir) => {
  await fs.promises.rm(restartNotifyMarkerPath(dataDir), { force: true }).catch(() => {});
};
