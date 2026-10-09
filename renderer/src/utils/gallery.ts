import type { GalleryImage } from '../../../src/lib/gallery-types';

export function moveGalleryImage(images: GalleryImage[], index: number, delta: number): GalleryImage[] {
  const next = [...images];
  const target = index + delta;
  if (index < 0 || index >= images.length || target < 0 || target >= images.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function duplicateGalleryImage(images: GalleryImage[], index: number): GalleryImage[] {
  return [...images.slice(0, index + 1), structuredClone(images[index]!), ...images.slice(index + 1)];
}

export function splitGalleryImage(images: GalleryImage[], index: number): GalleryImage[] {
  const image = images[index];
  if (!image || image.times.length < 2) throw new Error('至少两条字幕才能拆图');
  const middle = Math.ceil(image.times.length / 2);
  const parts = [image.times.slice(0, middle), image.times.slice(middle)].map(times => ({ ...structuredClone(image), times }));
  return [...images.slice(0, index), ...parts, ...images.slice(index + 1)];
}

export function mergeGalleryImage(images: GalleryImage[], index: number): GalleryImage[] {
  const first = images[index]; const second = images[index + 1];
  if (!first || !second) throw new Error('请选择相邻的两张图片');
  if (first.times.length + second.times.length > 9) throw new Error('合图最多 9 条字幕，请先拆分或删除不需要的字幕');
  return [...images.slice(0, index), { ...structuredClone(first), times: [...first.times, ...second.times] }, ...images.slice(index + 2)];
}
