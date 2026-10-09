import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalVideoAudio, captionsSrt, parseVideoAudioOptions, snapshotBackgroundAudio, splitSpokenCaptions } from './video-audio.js';
import { LocalStorage } from './storage.js';
import { AssetStore } from './assets-store.js';
import { runCommand } from './command.js';

async function tone(file: string, frequency: number, duration: number): Promise<void> {
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`, '-ac', '2', '-c:a', 'pcm_s16le', file], { captureStderr: true });
}
async function samples(file: string, raw: string): Promise<Buffer> {
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-ac', '1', '-f', 'f32le', raw], { captureStderr: true });
  return readFile(raw);
}
function amplitude(data: Buffer, start: number, frequency: number): number {
  const count = 12000; const offset = Math.round(start * 48000);
  let real = 0; let imaginary = 0;
  for (let i = 0; i < count; i++) { const sample = data.readFloatLE((offset + i) * 4); const angle = 2 * Math.PI * frequency * i / 48000; real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle); }
  return 2 * Math.hypot(real, imaginary) / count;
}

test('video audio accepts only local bounded options and preserves complete spoken caption text', () => {
  assert.deepEqual(parseVideoAudioOptions(undefined), { voiceover: false });
  for (const value of [null, [], { voiceover: 'yes' }, { provider: 'paid-cloud' }, { rate: 400 }, { backgroundAssetId: '../../private' }, { backgroundVolume: NaN }, { backgroundVolume: .8 }]) assert.throws(() => parseVideoAudioOptions(value));
  const text = '这是一段中文口播，标点和全部内容必须保留。接下来字幕与配音同步，不能丢掉后半句。' + '长句完整保留'.repeat(12);
  const chunks = splitSpokenCaptions(text);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(chunk => Array.from(chunk).length <= 28));
  const boundary = '中'.repeat(28) + '。下一句。';
  assert.equal(splitSpokenCaptions(boundary).join(''), boundary);
  assert.equal(splitSpokenCaptions('中'.repeat(28) + '.').length, 1);
  assert.ok(splitSpokenCaptions(boundary).every(chunk => /[\p{L}\p{N}]/u.test(chunk)));
  assert.match(captionsSrt([{ sceneIndex: 1, text: '中文。', start: .3, end: 1.625, file: 'test.wav' }]), /00:00:00,300 --> 00:00:01,625/);
});

test('real ffmpeg aligns cues, loops music, ducks during voice, and supports music-only and silent modes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-audio-mix-'));
  try {
    const storage = new LocalStorage(root); await storage.ensureBaseDirs(); const assets = new AssetStore(storage);
    const source = path.join(root, 'tone.wav'); await tone(source, 880, 1);
    const background = await assets.add('audio', { originalName: 'local-test-music.wav', data: await readFile(source) });
    const engine = new LocalVideoAudio({
      synthesize: async (_text, output) => tone(output, 220, .8),
      resolveBackground: (id, destination) => snapshotBackgroundAudio(assets, root, id, destination),
    });
    const project = path.join(root, 'mixed');
    const scenes = [{ index: 1, narration: '中文配音。', duration: 3 }, { index: 2, narration: '字幕同步，音乐压低。', duration: 3 }];
    const result = await engine.prepare(scenes, 6, project, { voiceover: true, backgroundAssetId: background.id, backgroundVolume: .3 });
    assert.ok(result); assert.equal(result.cues.length, 3); assert.equal(result.cues[0]!.start, .3);
    assert.equal(result.cues[1]!.start, 3.3); assert.ok(result.cues.every(cue => cue.start < cue.end && cue.end < 6));
    const data = await samples(path.join(project, result.mixFile), path.join(root, 'mix.f32'));
    assert.ok(amplitude(data, .5, 220) > .09, 'voice remains audible');
    const spokenBed = amplitude(data, .5, 880); const gapBed = amplitude(data, 2, 880);
    assert.ok(gapBed > .015 && spokenBed < gapBed * .8, `music duck measured: spoken=${spokenBed} gap=${gapBed}`);
    assert.match(await readFile(path.join(project, result.subtitleFile!), 'utf8'), /中文配音/);
    const music = await engine.prepare(scenes, 6, path.join(root, 'music'), { voiceover: false, backgroundAssetId: background.id });
    assert.ok(music); assert.deepEqual(music.cues, []); assert.equal(music.subtitleFile, undefined);
    const musicData = await samples(path.join(root, 'music', music.mixFile), path.join(root, 'music.f32'));
    assert.ok(amplitude(musicData, 4.5, 880) > .01, 'one-second music loops through the full composition');
    assert.equal(await engine.prepare(scenes, 6, path.join(root, 'silent'), { voiceover: false }), undefined);
    const tooLong = new LocalVideoAudio({ synthesize: async (_text, output) => tone(output, 220, 5) });
    await assert.rejects(tooLong.prepare([{ index: 1, narration: '完整长口播。', duration: 2 }], 2, path.join(root, 'long'), { voiceover: true }), /不会截断配音/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('music snapshots reject deleted assets, image-kind assets and symlinks outside the audio library', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-audio-source-'));
  try {
    const storage = new LocalStorage(root); await storage.ensureBaseDirs(); const assets = new AssetStore(storage);
    const record = await assets.add('audio', { originalName: 'music.wav', data: Buffer.from('fake audio bytes') });
    const file = (await assets.resolveFile(record.id))!.path;
    const privateFile = path.join(root, 'private.wav'); await writeFile(privateFile, 'fake audio bytes');
    await rm(file); await symlink(privateFile, file);
    await assert.rejects(snapshotBackgroundAudio(assets, root, record.id, path.join(root, 'copy.wav')), /安全素材目录/);
    await assert.rejects(snapshotBackgroundAudio(assets, root, 'missing', path.join(root, 'missing.wav')), /已删除/);
    const image = await assets.add('image', { originalName: 'image.png', data: Buffer.from('fake png') });
    await assert.rejects(snapshotBackgroundAudio(assets, root, image.id, path.join(root, 'image.wav')), /不是音频/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
