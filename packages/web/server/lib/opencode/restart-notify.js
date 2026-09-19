export const RESTART_NOTIFY_PROMPT = 'OpenChamber restarted on this Mac. Confirm in one short line that it is back up.';

export const pickMostRecentSession = (sessions) => {
  const candidates = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => typeof session?.id === 'string' && session.id.trim().length > 0)
    .filter((session) => typeof session?.directory === 'string' && session.directory.trim().length > 0)
    .filter((session) => !session?.time?.archived)
    .map((session) => ({
      id: session.id,
      directory: session.directory,
      updated: Number(session?.time?.updated),
    }))
    .filter((session) => Number.isFinite(session.updated));
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) => (candidate.updated > latest.updated ? candidate : latest));
};

/**
 * The fresh instance calls this once after boot: wait for the OpenCode sidecar,
 * find the most recently active session, and have it confirm the restart. The
 * prompt reuses the session's own last model/agent selection, so no model needs
 * to be named here.
 */
export const createRestartNotifier = ({
  sessionService,
  listSessions,
  waitForOpenCodeReady,
  prompt = RESTART_NOTIFY_PROMPT,
  readyTimeoutMs = 30_000,
  readyIntervalMs = 250,
}) => async () => {
  if (typeof sessionService?.send !== 'function' || typeof listSessions !== 'function') {
    return { sent: false, reason: 'notifier-unavailable' };
  }
  if (typeof waitForOpenCodeReady === 'function') {
    try {
      await waitForOpenCodeReady(readyTimeoutMs, readyIntervalMs);
    } catch {
      return { sent: false, reason: 'opencode-not-ready' };
    }
  }
  const target = pickMostRecentSession(await listSessions());
  if (!target) return { sent: false, reason: 'no-session' };
  await sessionService.send(target.id, {
    directory: target.directory,
    prompt,
  });
  return { sent: true, sessionId: target.id, directory: target.directory };
};
