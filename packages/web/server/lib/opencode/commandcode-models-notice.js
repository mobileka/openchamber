/**
 * The model list update notice.
 *
 * The scheduled `/commandcode_update_models` command posts what it changed
 * after it commits a new model list. The notice is stored on disk so every
 * connected client can show it, including clients that connect after the run,
 * and it lives until the user restarts OpenChamber or dismisses it.
 */

const NOTICE_FILE_NAME = 'commandcode-models-update.json';
const NOTICE_VERSION = 1;

const SUMMARY_MAX_LENGTH = 300;
const DETAILS_MAX_LENGTH = 20_000;
const COMMIT_MAX_LENGTH = 64;

const asTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeIncomingNotice = (payload) => {
  const summary = asTrimmedString(payload?.summary);
  const details = asTrimmedString(payload?.details);
  if (!summary || summary.length > SUMMARY_MAX_LENGTH) {
    return null;
  }
  if (!details || details.length > DETAILS_MAX_LENGTH) {
    return null;
  }
  const commit = asTrimmedString(payload?.commit);
  if (commit.length > COMMIT_MAX_LENGTH) {
    return null;
  }
  return {
    version: NOTICE_VERSION,
    summary,
    details,
    ...(commit ? { commit } : {}),
    changedAt: Date.now(),
  };
};

/**
 * A stored notice is validated as strictly as an incoming one. Anything that
 * does not match is a failure, not an empty notice: the caller must not clear
 * what a client already shows because a file was corrupted.
 */
const normalizeStoredNotice = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  if (value.version !== NOTICE_VERSION) {
    return null;
  }
  const summary = asTrimmedString(value.summary);
  const details = asTrimmedString(value.details);
  if (!summary || summary.length > SUMMARY_MAX_LENGTH) {
    return null;
  }
  if (!details || details.length > DETAILS_MAX_LENGTH) {
    return null;
  }
  const commit = asTrimmedString(value.commit);
  if (commit.length > COMMIT_MAX_LENGTH) {
    return null;
  }
  if (typeof value.changedAt !== 'number' || !Number.isFinite(value.changedAt)) {
    return null;
  }
  return {
    version: NOTICE_VERSION,
    summary,
    details,
    ...(commit ? { commit } : {}),
    changedAt: value.changedAt,
  };
};

const invalidNoticeError = () => {
  const error = new Error('summary and details are required and must not exceed their size limits');
  error.statusCode = 400;
  return error;
};

export const createCommandcodeModelsNoticeRuntime = ({ fs, path, openchamberDataDir, logger = console }) => {
  const noticePath = path.join(openchamberDataDir, NOTICE_FILE_NAME);

  const read = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(noticePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`The stored model list update at ${noticePath} is not valid JSON`);
    }

    const notice = normalizeStoredNotice(parsed);
    if (!notice) {
      throw new Error(`The stored model list update at ${noticePath} is malformed`);
    }
    return notice;
  };

  const save = async (payload) => {
    const notice = normalizeIncomingNotice(payload);
    if (!notice) {
      throw invalidNoticeError();
    }

    const temporaryPath = `${noticePath}.tmp`;
    await fs.promises.mkdir(openchamberDataDir, { recursive: true });
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(notice, null, 2)}\n`, 'utf8');
    await fs.promises.rename(temporaryPath, noticePath);
    return notice;
  };

  const clear = async () => {
    try {
      await fs.promises.unlink(noticePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.('[commandcode-models-notice] failed to remove the notice:', error?.message ?? error);
        throw error;
      }
    }
  };

  return { read, save, clear };
};
