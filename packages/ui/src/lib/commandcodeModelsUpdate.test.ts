import { afterEach, describe, expect, test } from 'bun:test';
import {
  dismissCommandcodeModelsUpdateNotice,
  fetchCommandcodeModelsUpdateNotice,
  restartOpenChamber,
} from './commandcodeModelsUpdate';

const originalFetch = globalThis.fetch;

const mockFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return handler(url, init);
  }, originalFetch);
  return calls;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('commandcode model list update client', () => {
  test('reads an empty notice as null', async () => {
    mockFetch(() => Response.json({ notice: null }));
    expect(await fetchCommandcodeModelsUpdateNotice()).toBeNull();
  });

  test('parses a stored notice', async () => {
    mockFetch(() => Response.json({
      notice: {
        version: 1,
        summary: '3 models added',
        details: '- Added **GLM-5.3 FlashX**',
        commit: 'abc1234',
        changedAt: 1700000000000,
      },
    }));

    expect(await fetchCommandcodeModelsUpdateNotice()).toEqual({
      summary: '3 models added',
      details: '- Added **GLM-5.3 FlashX**',
      commit: 'abc1234',
      changedAt: 1700000000000,
    });
  });

  test('treats a notice that exists but does not parse as failure', async () => {
    mockFetch(() => Response.json({ notice: { summary: 'only a summary' } }));
    await expect(fetchCommandcodeModelsUpdateNotice()).rejects.toThrow('malformed');
  });

  test('surfaces the server error message', async () => {
    mockFetch(() => Response.json({ error: 'Failed to read the model list update' }, { status: 500 }));
    await expect(fetchCommandcodeModelsUpdateNotice()).rejects.toThrow('Failed to read the model list update');
  });

  test('dismisses through the dismiss route', async () => {
    const calls = mockFetch(() => Response.json({ success: true }));
    await dismissCommandcodeModelsUpdateNotice();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/openchamber/commandcode-models-update/dismiss');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  test('restarts with the requested delay and reports failure', async () => {
    const calls = mockFetch(() => Response.json({ success: true }));
    await restartOpenChamber(5);
    expect(calls[0]?.url).toContain('/api/openchamber/restart?delaySeconds=5');
    expect(calls[0]?.init?.method).toBe('POST');

    mockFetch(() => Response.json({ error: 'Restarting is only available in the OpenChamber desktop app.' }, { status: 400 }));
    await expect(restartOpenChamber(5)).rejects.toThrow('Restarting is only available in the OpenChamber desktop app.');
  });
});
