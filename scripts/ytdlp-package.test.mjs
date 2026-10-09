import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensurePackagedYtDlp, YTDLP_VERSION } from './ytdlp-package.mjs';

test('yt-dlp cached binaries refresh when stamp is absent or a pinned version changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ytdlp-package-'));
  const output = path.join(root, 'yt-dlp');
  const urls = [];
  const options = { output, asset: 'yt-dlp_macos', version: YTDLP_VERSION,
    async download(url, destination) { urls.push(url); await writeFile(destination, 'new binary'); },
    async makeExecutable() {}
  };
  try {
    await writeFile(output, 'legacy binary');
    await ensurePackagedYtDlp(options);
    assert.equal(await readFile(output, 'utf8'), 'new binary');
    assert.equal((await readFile(output + '.version', 'utf8')).trim(), YTDLP_VERSION);
    assert.equal(urls[0], `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos`);
    await ensurePackagedYtDlp(options);
    assert.equal(urls.length, 1, 'matching stamp reuses cache');
    await ensurePackagedYtDlp({ ...options, version: '2026.09.01' });
    assert.equal(urls.length, 2);
    assert.equal((await readFile(output + '.version', 'utf8')).trim(), '2026.09.01');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed yt-dlp refresh preserves prior binary and version stamp', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ytdlp-package-failed-'));
  const output = path.join(root, 'yt-dlp.exe');
  try {
    await writeFile(output, 'prior binary');
    await writeFile(output + '.version', '2026.07.04\n');
    await assert.rejects(ensurePackagedYtDlp({ output, asset: 'yt-dlp.exe', version: YTDLP_VERSION,
      async download(_url, destination) { await writeFile(destination, 'partial'); throw new Error('offline'); },
      async makeExecutable() {}
    }), /offline/);
    assert.equal(await readFile(output, 'utf8'), 'prior binary');
    assert.equal(await readFile(output + '.version', 'utf8'), '2026.07.04\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
