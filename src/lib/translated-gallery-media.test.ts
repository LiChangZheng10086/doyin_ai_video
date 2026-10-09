import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from './command.js';
import { renderTranslatedGallery, translatedGalleryHtml } from './translated-gallery-media.js';
import { GalleryError, GalleryMedia, validateGalleryImage } from './gallery-media.js';

const image = { mainTime: .3, times: [.3, 1.3], bandTop: .75, bandBottom: .95, mainFraction: .48, translatedCaptions: ['这是一条完整的中文译文。', '所有原文保留在工作台供逐条核对。'] };

test('translated caption alignment, plaintext and length are validated at rendering boundary', () => {
  for (const translatedCaptions of [[], ['中文'], ['中文', ''], ['中文', '长'.repeat(241)], ['中文', 1 as unknown as string]]) {
    assert.throws(() => validateGalleryImage({ ...image, translatedCaptions }, 2), /译文|字幕/);
  }
  assert.doesNotThrow(() => validateGalleryImage(image, 2));
});

test('translated gallery escapes text and embeds only image data URLs', () => {
  const html = translatedGalleryHtml({ ...image, translatedCaptions: ['中文<script>window.attacked=1</script>', '中文<img src="https://evil.test/">&'] }, [Buffer.from('image'), Buffer.from('image'), Buffer.from('image')]);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&amp;'));
  assert.equal((html.match(/<img /g) ?? []).length, 3);
  assert.equal((html.match(/src="data:image\/png;base64,/g) ?? []).length, 3);
});

test('actual FFmpeg plus isolated Chromium produces deterministic readable Chinese PNGs and rejects crowded captions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-translated-'));
  try {
    const video = path.join(root, 'source.mp4');
    await runCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=red:s=640x360:d=1:r=10', '-f', 'lavfi', '-i', 'color=blue:s=640x360:d=1:r=10', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', video], { captureStderr: true });
    const media = new GalleryMedia();
    const first = path.join(root, 'first.png');
    const second = path.join(root, 'second.png');
    await media.render(video, image, first);
    await media.render(video, image, second);
    const png = await readFile(first);
    assert.equal(png.readUInt32BE(16), 1080); assert.equal(png.readUInt32BE(20), 1440);
    assert.deepEqual(png, await readFile(second), 'same local frames and text produce the same preview/final hash');
    const raw = path.join(root, 'pixels');
    await runCommand('ffmpeg', ['-y', '-i', first, '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw], { captureStderr: true });
    const pixels = await readFile(raw);
    const pixel = (x: number, y: number) => pixels.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3);
    assert.ok(pixel(10, 10)[0]! > 180, 'main frame retains original scene');
    let white = 0;
    for (let y = 1100; y < 1440; y++) for (let x = 48; x < 1032; x++) if (pixel(x, y).every(v => v > 220)) white++;
    assert.ok(white > 1000, 'Chinese captions are visibly drawn');
    assert.ok(pixel(10, 1410)[2]! > pixel(10, 1410)[0]!, 'last caption retains its own timestamp background');
    const crowded = { ...image, times: Array(9).fill(.5), translatedCaptions: Array(9).fill('中文'.repeat(120)) };
    const invalid = path.join(root, 'invalid.png');
    await assert.rejects(renderTranslatedGallery(crowded, t => media.frame(video, t), invalid), /溢出|拆分|可读/);
    await assert.rejects(readFile(invalid));
    const unexpectedWidth = { ...image, times: [.5], translatedCaptions: ['中\t\t\t'.repeat(60)] };
    await assert.rejects(renderTranslatedGallery(unexpectedWidth, t => media.frame(video, t), invalid), /实际排版溢出/);
    await assert.rejects(readFile(invalid));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing local browser is a neutral gallery error before reading frames', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-translated-missing-browser-'));
  try {
    await assert.rejects(renderTranslatedGallery(image, async () => { throw new Error('must not read frames'); }, path.join(root, 'output.png'), { browserBinary: path.join(root, 'absent-browser') }), (error: unknown) => {
      assert.ok(error instanceof GalleryError);
      assert.equal(error.status, 422);
      assert.match(error.message, /中文图集浏览器未就绪/);
      assert.doesNotMatch(error.message, /头条/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
