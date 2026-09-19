import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandcodeModelsNoticeRuntime } from './commandcode-models-notice.js';

const readNoticeFile = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'commandcode-models-update.json'), 'utf8'));

describe('commandcode models notice runtime', () => {
  let dataDir;
  let runtime;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commandcode-notice-'));
    runtime = createCommandcodeModelsNoticeRuntime({
      fs,
      path,
      openchamberDataDir: dataDir,
      logger: { warn: vi.fn() },
    });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads a missing notice as empty', async () => {
    await expect(runtime.read()).resolves.toBeNull();
  });

  it('stores a notice and reads it back', async () => {
    const saved = await runtime.save({
      summary: '3 models added, 1 rate refreshed',
      details: '- Added **GLM-5.3 FlashX**',
      commit: 'abc1234',
    });

    expect(saved.summary).toBe('3 models added, 1 rate refreshed');
    expect(saved.commit).toBe('abc1234');
    expect(Number.isFinite(saved.changedAt)).toBe(true);

    const readBack = await runtime.read();
    expect(readBack).toEqual(saved);
  });

  it('omits an empty commit instead of storing it', async () => {
    const saved = await runtime.save({ summary: 'One model added', details: '- Added a model', commit: '   ' });
    expect(saved).not.toHaveProperty('commit');
    expect(readNoticeFile(dataDir)).not.toHaveProperty('commit');
  });

  it('replaces the previous notice so the latest update wins', async () => {
    await runtime.save({ summary: 'First', details: '- first' });
    await runtime.save({ summary: 'Second', details: '- second' });

    const notice = await runtime.read();
    expect(notice?.summary).toBe('Second');
  });

  it('treats a corrupted stored notice as failure, not empty', async () => {
    fs.writeFileSync(path.join(dataDir, 'commandcode-models-update.json'), '{not json', 'utf8');
    await expect(runtime.read()).rejects.toThrow(/not valid JSON/);
  });

  it('treats a structurally invalid stored notice as failure', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'commandcode-models-update.json'),
      JSON.stringify({ version: 1, summary: 'Only a summary' }),
      'utf8',
    );
    await expect(runtime.read()).rejects.toThrow(/malformed/);
  });

  it('rejects incoming payloads that miss required fields or exceed limits', async () => {
    const invalidPayloads = [
      {},
      { summary: 'ok' },
      { summary: '', details: 'detail' },
      { summary: 's'.repeat(301), details: 'detail' },
      { summary: 'summary', details: 'd'.repeat(20_001) },
      { summary: 'summary', details: 'detail', commit: 'c'.repeat(65) },
    ];

    for (const payload of invalidPayloads) {
      await expect(runtime.save(payload)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('clears the stored notice and ignores a missing file', async () => {
    await runtime.save({ summary: 'Something', details: '- something' });
    await runtime.clear();
    await expect(runtime.read()).resolves.toBeNull();
    await expect(runtime.clear()).resolves.toBeUndefined();
  });
});
