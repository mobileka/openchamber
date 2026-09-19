import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';

/**
 * The published model list update, written by the scheduled
 * `/commandcode_update_models` run and read by every connected client. It
 * stays on the server until the user restarts OpenChamber or dismisses it, so
 * a client that connects later still sees it.
 */
export type CommandcodeModelsUpdateNotice = {
  summary: string;
  details: string;
  commit?: string;
  changedAt: number;
};

const noticeSchema = z.object({
  summary: z.string().min(1),
  details: z.string().min(1),
  commit: z.string().min(1).optional(),
  changedAt: z.number().finite(),
});

const noticeResponseSchema = z.object({
  notice: z.unknown().nullable().optional(),
});

const errorResponseSchema = z.object({
  error: z.string().min(1).optional(),
});

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  const payload = errorResponseSchema.safeParse(await response.json().catch(() => null));
  return payload.success ? (payload.data.error ?? fallback) : fallback;
};

export const fetchCommandcodeModelsUpdateNotice = async (): Promise<CommandcodeModelsUpdateNotice | null> => {
  const response = await runtimeFetch('/api/openchamber/commandcode-models-update', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Could not read the model list update'));
  }

  const payload = noticeResponseSchema.safeParse(await response.json().catch(() => null));
  if (!payload.success) {
    throw new Error('The model list update response is malformed');
  }
  if (payload.data.notice === null || payload.data.notice === undefined) {
    return null;
  }

  const parsed = noticeSchema.safeParse(payload.data.notice);
  if (!parsed.success) {
    // A notice that exists but does not parse is failure, not "no notice":
    // callers must keep what they already show instead of clearing it.
    throw new Error('The model list update response is malformed');
  }
  if (parsed.data.commit) {
    return {
      summary: parsed.data.summary,
      details: parsed.data.details,
      commit: parsed.data.commit,
      changedAt: parsed.data.changedAt,
    };
  }
  return {
    summary: parsed.data.summary,
    details: parsed.data.details,
    changedAt: parsed.data.changedAt,
  };
};

export const dismissCommandcodeModelsUpdateNotice = async (): Promise<void> => {
  const response = await runtimeFetch('/api/openchamber/commandcode-models-update/dismiss', {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Could not dismiss the model list update'));
  }
};

/**
 * Restarts the OpenChamber host through the same endpoint the
 * `/openchamber_restart` command uses. The server answers first and restarts
 * after the delay.
 */
export const restartOpenChamber = async (delaySeconds = 5): Promise<void> => {
  const response = await runtimeFetch(`/api/openchamber/restart?delaySeconds=${delaySeconds}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Could not restart OpenChamber'));
  }
};
