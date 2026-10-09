/** Read-only history scan. --self-test uses only temporary fixtures. */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { inspectTranscriptQuality } from '../src/lib/transcript-quality.js';
import type { TranscriptAsset } from '../src/types.js';

async function scan(root: string): Promise<{ jobId: string; issues: string[] }[]> {
  const results = [];
  for (const file of (await readdir(path.join(root, 'raw/transcripts'))).filter(file => file.endsWith('.json') && !file.includes('.before-retranscribe-'))) {
    const jobId = file.slice(0, -5);
    try {
      const asset = JSON.parse(await readFile(path.join(root, 'raw/transcripts', file), 'utf8')) as TranscriptAsset;
      let duration = asset.duration;
      try {
        const manifest = JSON.parse(await readFile(path.join(root, 'raw/audio', file), 'utf8'));
        if (typeof manifest.audio?.duration === 'number' && Number.isFinite(manifest.audio.duration)) duration = manifest.audio.duration;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const issues = inspectTranscriptQuality({ segments: asset.segments ?? [], text: asset.transcript ?? asset.text, duration });
      if (issues.length) results.push({ jobId, issues });
    } catch { results.push({ jobId, issues: ['转录或音频元信息无法解析，请在作品页面核对后重新转录'] }); }
  }
  return results.sort((a, b) => a.jobId.localeCompare(b.jobId));
}

if (process.argv.includes('--self-test')) {
  const root = await mkdtemp(path.join(tmpdir(), 'transcript-scan-'));
  try {
    await mkdir(path.join(root, 'raw/transcripts'), { recursive: true });
    await mkdir(path.join(root, 'raw/audio'), { recursive: true });
    const valid = { transcript: '你好', segments: [{ start: 0, end: 1, text: '你好' }], duration: 1 };
    await writeFile(path.join(root, 'raw/transcripts/valid.json'), JSON.stringify(valid));
    await writeFile(path.join(root, 'raw/transcripts/invalid.json'), JSON.stringify({ ...valid, segments: [{ start: 800, end: 3.7, text: '你好' }] }));
    await writeFile(path.join(root, 'raw/transcripts/corrupt.json'), '{BROKEN');
    await writeFile(path.join(root, 'raw/transcripts/inflated.json'), JSON.stringify({ ...valid, duration: 600, segments: [{ start: 0, end: 600, text: '你好' }] }));
    await writeFile(path.join(root, 'raw/audio/inflated.json'), JSON.stringify({ audio: { duration: 2 } }));
    const before = await readFile(path.join(root, 'raw/transcripts/corrupt.json'));
    assert.deepEqual((await scan(root)).map(row => row.jobId), ['corrupt', 'inflated', 'invalid']);
    assert.deepEqual(await readFile(path.join(root, 'raw/transcripts/corrupt.json')), before);
    console.log('PASS: read-only history scan flags corrupt JSON, reversed times and inflated duration; valid transcript stays clear and original bytes unchanged.');
  } finally { await rm(root, { recursive: true, force: true }); }
} else {
  const storageArg = process.argv.find(arg => arg.startsWith('--storage='));
  let root = path.join(homedir(), 'Library/Application Support/douyin-ai-video/storage');
  if (storageArg) root = path.resolve(storageArg.slice('--storage='.length));
  else {
    try {
      const config = JSON.parse(await readFile(path.join(homedir(), 'Library/Application Support/douyin-ai-video/config.json'), 'utf8'));
      if (typeof config.storagePath === 'string' && config.storagePath.trim()) root = path.resolve(config.storagePath);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  console.log(JSON.stringify({ storage: root, anomalies: await scan(root) }, null, 2));
}
