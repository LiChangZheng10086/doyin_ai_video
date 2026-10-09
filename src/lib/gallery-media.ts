import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from './command.js';
import type { GalleryImage, GallerySource } from './gallery-types.js';
import type { SubtitleCandidate } from './gallery-planner.js';

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
  if (value.times.length < 1 || value.times.length > 9) throw new GalleryError(422, '每张拼图需 1～9 条字幕');
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

  async suggestSubtitle(video: string, quote: { start: number; end: number }, region: { bandTop?: number; bandBottom?: number } = {}): Promise<SubtitleCandidate | null> {
    const info = await this.probe(video);
    if (!Number.isFinite(quote.start) || !Number.isFinite(quote.end) || quote.start < 0 || quote.end <= quote.start || quote.start >= info.duration) {
      throw new GalleryError(422, '转录时间无法用于字幕候选');
    }
    const width = 720;
    const height = Math.round(info.height * width / info.width / 2) * 2;
    if (height > 4096 || height < 16) throw new GalleryError(422, '原视频比例无法用于字幕候选');
    const dir = await mkdtemp(path.join(tmpdir(), 'gallery-candidates-'));
    try {
      const candidates: { time: number; edges: Set<number>; top: number; bottom: number; strength: number }[] = [];
      for (const fraction of [.25, .5, .75]) {
        const time = Math.min(info.duration - .001, quote.start + (quote.end - quote.start) * fraction);
        const file = path.join(dir, `${fraction}.gray`);
        await this.execute(['-ss', String(time), '-i', video, '-vf', `scale=${width}:${height}`, '-frames:v', '1', '-pix_fmt', 'gray', '-threads', '1', '-f', 'rawvideo', file]);
        const pixels = await readFile(file);
        if (pixels.length !== width * height) throw new GalleryError(422, '候选像素读取不完整');
        const rows: number[] = [];
        const rowEdges = new Map<number, number[]>();
        let strength = 0;
        for (let y = Math.floor((region.bandTop ?? .5) * height); y < Math.ceil((region.bandBottom ?? .98) * height); y++) {
          const edges: number[] = [];
          for (let x = 16; x < width - 16; x++) {
            const a = pixels[y * width + x - 1]!; const b = pixels[y * width + x]!;
            if (Math.abs(a - b) > 60 && Math.max(a, b) > 180 && Math.min(a, b) < 130) edges.push(y * width + x);
          }
          if (edges.length >= 12 && edges.length <= 150) { rows.push(y); rowEdges.set(y, edges); strength += edges.length; }
        }
        // ponytail: text-like edges cannot prove words; upgrade to OCR only with a separately verified accuracy contract.
        if (rows.length < 5) continue;
        const groups: number[][] = [];
        for (const y of rows) {
          if (!groups.length || y - groups.at(-1)!.at(-1)! > Math.max(8, height * .018)) groups.push([]);
          groups.at(-1)!.push(y);
        }
        const textGroups = groups.filter(g => g.length >= 5 && g.at(-1)! - g[0]! < height * .14);
        const lowest = textGroups.at(-1);
        if (!lowest) continue;
        // Prefer the bottom caption over larger scene textures and keep neighboring subtitle lines together.
        const glyphs = textGroups.filter(g => g[0]! <= lowest.at(-1)! + height * .075
          && g.at(-1)! >= lowest[0]! - height * .075).flat().sort((a, b) => a - b);
        if (glyphs.at(-1)! - glyphs[0]! > height * .22) continue;
        const pad = 4;
        const top = region.bandTop ?? Math.max(0, (glyphs[0]! - pad) / height);
        const bottom = region.bandBottom ?? Math.min(1, (glyphs.at(-1)! + pad + 1) / height);
        candidates.push({ time, edges: new Set(glyphs.flatMap(y => rowEdges.get(y) ?? [])), top, bottom, strength });
      }
      if (candidates.length < 2) return null;
      let best: typeof candidates[number] | undefined;
      let bestScore = Infinity;
      for (const a of candidates) {
        let difference = Infinity;
        for (const b of candidates) {
          if (a === b || Math.abs(a.top - b.top) > .04 || Math.abs(a.bottom - b.bottom) > .04) continue;
          // Compare detected glyph edges, so camera motion outside the text does not dominate stability.
          const matches = (from: Set<number>, to: Set<number>) => {
            let count = 0;
            for (const pixel of from) {
              if ([-width, 0, width].some(dy => [-1, 0, 1].some(dx => to.has(pixel + dy + dx)))) count++;
            }
            return count;
          };
          const overlap = (matches(a.edges, b.edges) + matches(b.edges, a.edges)) / (a.edges.size + b.edges.size);
          difference = Math.min(difference, 1 - overlap);
        }
        const score = difference - Math.min(.01, a.strength / 1_000_000);
        if (score < bestScore) { best = a; bestScore = score; }
      }
      if (!best || bestScore > .4) return null;
      return { time: best.time, bandTop: best.top, bandBottom: best.bottom };
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
      const desiredMain = Math.round(1440 * image.mainFraction / 2) * 2;
      const nativeStrip = (image.bandBottom - image.bandTop) * info.height * 1080 / info.width;
      const mainHeight = image.times.length >= 6
        ? Math.max(576, Math.min(desiredMain, Math.floor((1440 - image.times.length * Math.max(64, nativeStrip)) / 2) * 2))
        : desiredMain;
      if (image.times.length > 6 && nativeStrip > (1440 - mainHeight) / image.times.length + 2) throw new GalleryError(422, '字幕区域过高，请缩小区域或拆分图片以保证可读性');
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
