import assert from 'node:assert/strict';
import { test } from 'node:test';

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
