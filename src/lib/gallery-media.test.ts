import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from './command.js';

test('native gallery rejects invalid timestamps and crops before starting ffmpeg', async () => {
  const { validateGalleryImage } = await import('./gallery-media.js');
  const image = { mainTime: 1, times: [1, 2], bandTop: 0.78, bandBottom: 0.96, mainFraction: 0.7 };
  assert.doesNotThrow(() => validateGalleryImage(image, 3));
  for (const bad of [{ ...image, mainTime: -1 }, { ...image, times: [3] }, { ...image, times: [NaN] },
    { ...image, bandTop: 0.96 }, { ...image, bandBottom: 1.1 }, { ...image, times: [] },
    { ...image, times: Array(7).fill(1) }, { ...image, mainFraction: 1 }]) {
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
