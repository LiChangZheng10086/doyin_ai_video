import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as galleryUtils from './gallery.js';

test('splitting and merging keep every subtitle in order without mutating the original', () => {
  const image = { mainTime: 1, times: [1, 2, 3, 4, 5, 6, 7, 8], bandTop: 0.8, bandBottom: 0.9, mainFraction: 0.5 };
  const split = (galleryUtils as any).splitGalleryImage([image], 0);
  assert.deepEqual(split.map((i: any) => i.times), [[1, 2, 3, 4], [5, 6, 7, 8]]);
  split[0].times[0] = 0;
  assert.equal(image.times[0], 1);
  const merged = (galleryUtils as any).mergeGalleryImage(split, 0);
  assert.deepEqual(merged[0].times, [0, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(merged.length, 1);
});

test('merging cannot silently drop subtitles or exceed nine lines', () => {
  const image = { mainTime: 1, times: [1, 2, 3, 4, 5], bandTop: 0.8, bandBottom: 0.9, mainFraction: 0.5 };
  assert.throws(() => (galleryUtils as any).mergeGalleryImage([image, image], 0), /9/);
});

test('gallery image moves preserve order and editing never changes the original image', async () => {
  const { moveGalleryImage, duplicateGalleryImage } = await import('./gallery.js');
  const a = { mainTime: 1, times: [1, 2], bandTop: 0.78, bandBottom: 0.96, mainFraction: 0.7 };
  const b = { ...a, mainTime: 3 };
  const images = moveGalleryImage([a, b], 1, -1);
  assert.equal(images[0]!.mainTime, 3);
  assert.equal(images[1]!.mainTime, 1);
  assert.deepEqual(moveGalleryImage([a, b], 0, -1), [a, b]);
  const copy = duplicateGalleryImage([a], 0);
  copy[1]!.times[0] = 4;
  assert.equal(a.times[0], 1);
  assert.equal(copy.length, 2);
});
