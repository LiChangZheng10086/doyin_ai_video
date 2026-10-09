import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from './command.js';

test('native gallery rejects invalid timestamps and crops before starting ffmpeg', async () => {
  const { validateGalleryImage } = await import('./gallery-media.js');
  const image = { mainTime: 1, times: [1, 2], bandTop: 0.78, bandBottom: 0.96, mainFraction: 0.7 };
  assert.doesNotThrow(() => validateGalleryImage(image, 3));
  assert.doesNotThrow(() => validateGalleryImage({ ...image, times: Array(9).fill(1) }, 3));
  for (const bad of [{ ...image, mainTime: -1 }, { ...image, times: [3] }, { ...image, times: [NaN] },
    { ...image, bandTop: 0.96 }, { ...image, bandBottom: 1.1 }, { ...image, times: [] },
    { ...image, times: Array(10).fill(1) }, { ...image, mainFraction: 1 }]) {
    assert.throws(() => validateGalleryImage(bad, 3), /时间|字幕|比例/);
  }
  assert.throws(() => validateGalleryImage({ ...image, mainCrop: { left: 0.8, right: 0.2, top: 0, bottom: 1 } }, 3), /取景/);
});

test('real ffmpeg produces native 1080x1440 strips and uses different timestamp frames', async () => {
  const { GalleryMedia } = await import('./gallery-media.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-media-'));
  try {
    const video = path.join(root, 'source.mp4');
    // Burned-in white subtitle marks and different backgrounds require no font/drawtext dependency.
    await runCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=red:s=320x480:d=1:r=10',
      '-f', 'lavfi', '-i', 'color=blue:s=320x480:d=1:r=10', '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0,drawbox=x=80:y=400:w=160:h=12:color=white:t=fill[v]',
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { captureStderr: true });
    const media = new GalleryMedia();
    const info = await media.probe(video);
    assert.equal(info.width, 320);
    assert.equal(info.height, 480);
    assert.ok(info.duration >= 2);
    const frame = await media.frame(video, 0.5);
    assert.equal(frame.subarray(1, 4).toString(), 'PNG');
    const output = path.join(root, 'gallery.png');
    await media.render(video, { mainTime: 0.5, times: [0.5, 1.5], bandTop: 0.78, bandBottom: 0.96, mainFraction: 0.7 }, output);
    const bytes = await readFile(output);
    assert.equal(bytes.readUInt32BE(16), 1080);
    assert.equal(bytes.readUInt32BE(20), 1440);
    const top = await media.frame(video, 0.5);
    const bottom = await media.frame(video, 1.5);
    assert.notDeepEqual(top, bottom);
    // Check the actual stacked strips, not only the input frames.
    for (const [y, color] of [[1020, 'red'], [1240, 'blue']] as const) {
      const pixelFile = path.join(root, `${color}.ppm`);
      await runCommand('ffmpeg', ['-y', '-i', output, '-vf', `crop=1:1:300:${y}`, '-frames:v', '1', pixelFile], { captureStderr: true });
      const pixel = (await readFile(pixelFile)).subarray(-3);
      assert.ok(color === 'red' ? pixel[0]! > pixel[2]! + 100 : pixel[2]! > pixel[0]! + 100);
    }
    for (const [x, y, white] of [[540, 1084, true], [540, 1300, true], [10, 1020, false]] as const) {
      const pixelFile = path.join(root, `${x}-${y}.ppm`);
      await runCommand('ffmpeg', ['-y', '-i', output, '-vf', `crop=1:1:${x}:${y}`, '-frames:v', '1', pixelFile], { captureStderr: true });
      const pixel = (await readFile(pixelFile)).subarray(-3);
      assert.ok([...pixel].every(n => white ? n > 220 : n < 10), 'native glyph pixels survive without stretching the crop');
    }
    const rotated = path.join(root, 'rotated.mp4');
    await runCommand('ffmpeg', ['-y', '-display_rotation', '90', '-i', video, '-c', 'copy', rotated], { captureStderr: true });
    assert.deepEqual({ ...(await media.probe(rotated)), duration: 2 }, { width: 480, height: 320, duration: 2 });
    const rotatedFrame = await media.frame(rotated, 0.5);
    assert.ok(rotatedFrame.readUInt32BE(16) > rotatedFrame.readUInt32BE(20));
    await media.render(rotated, { mainTime: 0.5, times: Array(6).fill(0.5), bandTop: 0.5, bandBottom: 0.7, mainFraction: 0.85,
      mainCrop: { left: 0.1, right: 0.9, top: 0, bottom: 1 } }, output);
    assert.equal((await readFile(output)).readUInt32BE(20), 1440);
  } finally { await rm(root, { recursive: true, force: true }); }
});

 test('pixel candidates reject blank bright video and keep readable eight/nine caption rows', async () => {
  const { GalleryMedia, validateGalleryImage } = await import('./gallery-media.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-caption-'));
  try {
    const blank = path.join(root, 'blank.mp4');
    const text = path.join(root, 'text.mp4');
    await runCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=white:s=320x480:d=2:r=10', '-c:v', 'libx264', blank], { captureStderr: true });
    const pixels = Buffer.alloc(320 * 480 * 3);
    // Raster glyph fixture works on FFmpeg builds without the optional drawtext filter.
    const glyphs = ['10001','11001','10101','10011','10001','10001','10001'];
    for (let char = 0; char < 20; char++) for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
      if (glyphs[y]![x] !== '1') continue;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const at = ((400 + y * 2 + dy) * 320 + 40 + char * 12 + x * 2 + dx) * 3;
        pixels.fill(255, at, at + 3);
      }
    }
    const singleLinePixels = Buffer.from(pixels);
    const fixture = path.join(root, 'glyphs.ppm');
    await writeFile(fixture, Buffer.concat([Buffer.from('P6\n320 480\n255\n'), pixels]));
    await runCommand('ffmpeg', ['-y', '-loop', '1', '-i', fixture, '-t', '2', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', text], { captureStderr: true });
    const media = new GalleryMedia();
    assert.equal(await media.suggestSubtitle(blank, { start: 0, end: 1.8 }), null);
    const candidate = await media.suggestSubtitle(text, { start: 0, end: 1.8 });
    assert.ok(candidate && candidate.bandTop < .84 && candidate.bandBottom > .85);
    singleLinePixels.subarray(400 * 320 * 3, 414 * 320 * 3).copy(pixels, 428 * 320 * 3);
    const multiline = path.join(root, 'multiline.mp4');
    await writeFile(fixture, Buffer.concat([Buffer.from('P6\n320 480\n255\n'), pixels]));
    await runCommand('ffmpeg', ['-y', '-loop', '1', '-i', fixture, '-t', '2', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', multiline], { captureStderr: true });
    const twoLines = await media.suggestSubtitle(multiline, { start: 0, end: 1.8 });
    assert.ok(twoLines && twoLines.bandTop < .84 && twoLines.bandBottom > .92, 'both native subtitle lines remain inside the suggested band');
    await assert.rejects(media.render(text, { mainTime: .5, times: Array(9).fill(.5), bandTop: .5, bandBottom: .99, mainFraction: .7 }, path.join(root, 'unreadable.png')), /可读|拆分/);
    for (const count of [8, 9]) {
      const image = { mainTime: .5, times: Array(count).fill(.5), bandTop: candidate!.bandTop, bandBottom: candidate!.bandBottom, mainFraction: .4 };
      validateGalleryImage(image, 2);
      const output = path.join(root, `${count}.png`);
      await media.render(text, image, output);
      const raw = path.join(root, `${count}.gray`);
      await runCommand('ffmpeg', ['-y', '-i', output, '-pix_fmt', 'gray', '-f', 'rawvideo', raw], { captureStderr: true });
      const pixels = await readFile(raw);
      for (let row = 0; row < count; row++) {
        const a = Math.floor(576 + row * 864 / count);
        const b = Math.floor(576 + (row + 1) * 864 / count);
        const glyphRows = Array.from({ length: b - a }, (_, y) => pixels.subarray((a + y) * 1080, (a + y + 1) * 1080).some(p => p > 190)).filter(Boolean).length;
        assert.ok(glyphRows >= 24, `row ${row} has at least 24 pixels of native glyph height`);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('widescreen thin native captions survive bounded candidate sampling', async () => {
  const { GalleryMedia } = await import('./gallery-media.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-thin-caption-'));
  try {
    const width = 1680; const height = 720;
    const pixels = Buffer.alloc(width * height * 3);
    const glyphs = ['10001', '11001', '10101', '10011', '10001', '10001', '10001'];
    for (let char = 0; char < 30; char++) for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
      if (glyphs[y]![x] !== '1') continue;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const at = ((610 + y * 2 + dy) * width + 660 + char * 12 + x * 2 + dx) * 3;
        pixels.fill(255, at, at + 3);
      }
    }
    const thinPixels = Buffer.from(pixels);
    const raster = path.join(root, 'thin-captions.ppm');
    const video = path.join(root, 'thin-captions.mp4');
    await writeFile(raster, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
    await runCommand('ffmpeg', ['-y', '-loop', '1', '-i', raster, '-t', '2', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { captureStderr: true });
    const candidate = await new GalleryMedia().suggestSubtitle(video, { start: 0, end: 1.8 });
    assert.ok(candidate, '14-pixel native glyphs remain detectable on a 1680x720 source');
    assert.ok(candidate.bandTop < 610 / height && candidate.bandBottom > 624 / height);
    // A larger bright texture region above the subtitle must not win merely by its row count.
    for (let y = 430; y < 490; y++) for (let x = 400; x < 1280; x++) {
      if (Math.floor(x / 10) % 2) pixels.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
    const busy = path.join(root, 'busy-thin-captions.mp4');
    await writeFile(raster, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
    await runCommand('ffmpeg', ['-y', '-loop', '1', '-i', raster, '-t', '2', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', busy], { captureStderr: true });
    const busyCandidate = await new GalleryMedia().suggestSubtitle(busy, { start: 0, end: 1.8 });
    assert.ok(busyCandidate && busyCandidate.bandTop > .8 && busyCandidate.bandBottom > 624 / height, 'bottom speech caption wins over taller background texture');
    const backgrounds: string[] = [];
    for (const shade of [0, 70, 140]) {
      const changing = Buffer.alloc(width * height * 3, shade);
      for (let y = 606; y < 630; y++) {
        const start = (y * width + 640) * 3;
        const end = (y * width + 1040) * 3;
        thinPixels.subarray(start, end).copy(changing, start);
      }
      const file = path.join(root, `background-${shade}.ppm`);
      await writeFile(file, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), changing]));
      backgrounds.push(file);
    }
    const moving = path.join(root, 'changing-background.mp4');
    await runCommand('ffmpeg', ['-y', ...backgrounds.flatMap(file => ['-loop', '1', '-t', '1', '-i', file]), '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', moving], { captureStderr: true });
    assert.ok(await new GalleryMedia().suggestSubtitle(moving, { start: 0, end: 3 }), 'stable glyphs remain usable while the surrounding scene changes brightness');
  } finally { await rm(root, { recursive: true, force: true }); }
});
