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
