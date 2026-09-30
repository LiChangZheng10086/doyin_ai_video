import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from './command.js';
import type { GalleryImage, GallerySource } from './gallery-types.js';

export class GalleryError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'gallery_invalid') {
    super(message);
    this.name = 'GalleryError';
  }
}

export function validateGalleryImage(value: GalleryImage, duration = Infinity): void {
  const time = (t: number) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t < duration;
  if (!value || !time(value.mainTime) || !Array.isArray(value.times) || !value.times.every(time)) {
    throw new GalleryError(422, '画面时间必须在原视频时长范围内');
  }
  if (value.times.length < 1 || value.times.length > 6) throw new GalleryError(422, '每张拼图需 1～6 条字幕');
  if (!Number.isFinite(value.bandTop) || !Number.isFinite(value.bandBottom)
    || value.bandTop < 0 || value.bandBottom > 1 || value.bandBottom - value.bandTop < 0.01) {
    throw new GalleryError(422, '字幕区域须在画面内，且下边界大于上边界');
  }
  if (!Number.isFinite(value.mainFraction) || value.mainFraction < 0.4 || value.mainFraction > 0.85) {
    throw new GalleryError(422, '主画面比例须在 40%～85% 之间');
  }
  const c = value.mainCrop;
  if (c && (![c.left, c.right, c.top, c.bottom].every(n => Number.isFinite(n) && n >= 0 && n <= 1)
    || c.right - c.left < 0.01 || c.bottom - c.top < 0.01)) throw new GalleryError(422, '主画面取景区域必须在画面内且有有效宽高');
}

export class GalleryMedia {
  constructor(private readonly config: { ffmpegBinary?: string; ffprobeBinary?: string } = {}) {}

  async probe(video: string): Promise<GallerySource> {
    const { stdout } = await runCommand(this.config.ffprobeBinary ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { captureStdout: true, captureStderr: true, timeoutMs: 20_000 });
    const data = JSON.parse(stdout);
    const stream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
    const rotation = Number(stream?.side_data_list?.find((s: { rotation?: number }) => s.rotation !== undefined)?.rotation ?? stream?.tags?.rotate ?? 0);
    const rotated = Math.abs(rotation) % 180 === 90;
    const info = { width: Number(rotated ? stream?.height : stream?.width), height: Number(rotated ? stream?.width : stream?.height), duration: Number(data.format?.duration ?? stream?.duration) };
    if (![info.width, info.height, info.duration].every(n => Number.isFinite(n) && n > 0)) {
      throw new GalleryError(422, '无法读取原视频尺寸或时长，请重新下载原视频');
    }
    return info;
  }

  private async execute(args: string[]): Promise<void> {
    try {
      await runCommand(this.config.ffmpegBinary ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { captureStderr: true, timeoutMs: 120_000 });
    } catch (error) {
      throw new GalleryError(422, `图片生成失败，请检查 FFmpeg 与原视频：${error instanceof Error ? error.message : String(error)}`, 'gallery_media_failed');
    }
  }

  async frame(video: string, time: number): Promise<Buffer> {
    const info = await this.probe(video);
    if (!Number.isFinite(time) || time < 0 || time >= info.duration) throw new GalleryError(422, '候选画面时间超出原视频时长');
    const dir = await mkdtemp(path.join(tmpdir(), 'gallery-frame-'));
    try {
      const file = path.join(dir, 'frame.png');
      await this.execute(['-ss', String(time), '-i', video, '-vf', 'scale=720:720:force_original_aspect_ratio=decrease', '-frames:v', '1', '-threads', '1', file]);
      return await this.png(file);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async render(video: string, image: GalleryImage, output: string): Promise<void> {
    const info = await this.probe(video);
    validateGalleryImage(image, info.duration);
    await mkdir(path.dirname(output), { recursive: true });
    const dir = await mkdtemp(path.join(path.dirname(output), 'frames-'));
    try {
      const times = [image.mainTime, ...image.times];
      for (const [index, time] of times.entries()) {
        await this.execute(['-ss', String(time), '-i', video, '-frames:v', '1', '-threads', '1', path.join(dir, `${index}.png`)]);
      }
      const mainHeight = Math.round(1440 * image.mainFraction / 2) * 2;
      const bandHeight = Math.floor((1440 - mainHeight) / image.times.length / 2) * 2;
      const c = image.mainCrop;
      const mainCrop = c ? `crop=iw*${c.right - c.left}:ih*${c.bottom - c.top}:iw*${c.left}:ih*${c.top},` : '';
      const filters = [`[0:v]${mainCrop}scale=1080:${mainHeight}:force_original_aspect_ratio=decrease,pad=1080:${mainHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0]`];
      image.times.forEach((_, i) => {
        const height = i === image.times.length - 1 ? 1440 - mainHeight - i * bandHeight : bandHeight;
        filters.push(`[${i + 1}:v]crop=iw:ih*${image.bandBottom - image.bandTop}:0:ih*${image.bandTop},scale=1080:${height}:force_original_aspect_ratio=decrease,pad=1080:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i + 1}]`);
      });
      filters.push(`${times.map((_, i) => `[v${i}]`).join('')}vstack=inputs=${times.length}[out]`);
      await this.execute(['-filter_complex_threads', '1', ...times.flatMap((_, i) => ['-i', path.join(dir, `${i}.png`)]), '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-threads', '1', output]);
      const png = await this.png(output);
      if (png.readUInt32BE(16) !== 1080 || png.readUInt32BE(20) !== 1440) throw new GalleryError(422, '拼图尺寸不正确');
    } catch (error) {
      await rm(output, { force: true });
      throw error;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  private async png(file: string): Promise<Buffer> {
    const data = await readFile(file);
    if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.length > 20 * 1024 * 1024) {
      throw new GalleryError(422, '图片产物为空、损坏或超过 20MB');
    }
    return data;
  }
}
