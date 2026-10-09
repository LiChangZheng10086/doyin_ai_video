import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recognizeNativeText, nativeSubtitleOcrAvailable, selectNativeSubtitle, type SubtitleRecognizer } from './subtitle-ocr.js';
import { runCommand } from './command.js';
import { renderTranslatedGallery, validateTranslatedCaptions } from './translated-gallery-media.js';
import type { GalleryImage, GallerySource } from './gallery-types.js';
import type { SubtitleCandidate } from './gallery-planner.js';

export class GalleryError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'gallery_invalid') {
    super(message);
    this.name = 'GalleryError';
  }
}

export function galleryFilmstripHeight(source: Pick<GallerySource, 'width' | 'height'>, top: number, bottom: number): number {
  return Math.ceil(Math.max(96, (bottom - top) * source.height * 1080 / source.width + 40) / 2) * 2;
}

export function validateGalleryImage(value: GalleryImage, duration = Infinity): void {
  const time = (t: number) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t < duration;
  if (!value || !time(value.mainTime) || !Array.isArray(value.times) || !value.times.every(time)) {
    throw new GalleryError(422, '画面时间必须在原视频时长范围内');
  }
  if (value.times.length < 1 || value.times.length > 9) throw new GalleryError(422, '每张拼图需 1～9 条字幕');
  if (value.translatedCaptions !== undefined) validateTranslatedCaptions(value.translatedCaptions, value.times.length);
  if (value.compact !== undefined && typeof value.compact !== 'boolean') throw new GalleryError(422, '拼图排版配置无效');
  if (value.filmstrip !== undefined && typeof value.filmstrip !== 'boolean') throw new GalleryError(422, '拼图排版配置无效');
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
  constructor(private readonly config: { ffmpegBinary?: string; ffprobeBinary?: string; browserBinary?: string; recognizeSubtitles?: SubtitleRecognizer } = {}) {}

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

  async suggestSubtitle(video: string, quote: { start: number; end: number; text?: string }, region: { bandTop?: number; bandBottom?: number } = {}): Promise<SubtitleCandidate | null> {
    return (await this.detectSubtitles(video, quote, region, false))[0] ?? null;
  }

  async suggestSubtitles(video: string, quote: { start: number; end: number; text?: string }, region: { bandTop?: number; bandBottom?: number } = {}): Promise<SubtitleCandidate[]> {
    return this.detectSubtitles(video, quote, region, true);
  }

  private async detectSubtitles(video: string, quote: { start: number; end: number; text?: string }, region: { bandTop?: number; bandBottom?: number }, collect: boolean): Promise<SubtitleCandidate[]> {
    const info = await this.probe(video);
    if (!Number.isFinite(quote.start) || !Number.isFinite(quote.end) || quote.start < 0 || quote.end <= quote.start || quote.start >= info.duration) {
      throw new GalleryError(422, '转录时间无法用于字幕候选');
    }
    const width = 720;
    const height = Math.round(info.height * width / info.width / 2) * 2;
    if (height > 4096 || height < 16) throw new GalleryError(422, '原视频比例无法用于字幕候选');
    const dir = await mkdtemp(path.join(tmpdir(), 'gallery-candidates-'));
    try {
      if (quote.text && (this.config.recognizeSubtitles || nativeSubtitleOcrAvailable())) {
        let best: (SubtitleCandidate & { score: number }) | null = null;
        const found: SubtitleCandidate[] = [];
        const count = Math.max(7, Math.min(80, Math.ceil((quote.end - quote.start) / .5)));
        const fractions = collect ? Array.from({ length: count }, (_, i) => (i + .5) / count) : [.15, .25, .35, .5, .65, .75, .85];
        for (const fraction of fractions) {
          const time = Math.min(info.duration - .001, quote.start + (Math.min(quote.end, info.duration) - quote.start) * fraction);
          const file = path.join(dir, `ocr-${fraction}.png`);
          // Keep the native fine glyphs; OCR handles camera motion outside the text.
          await this.execute(['-ss', String(time), '-i', video, '-vf', 'crop=iw:ih*0.48:0:ih*0.5,scale=2560:1280:force_original_aspect_ratio=decrease', '-frames:v', '1', '-threads', '1', file]);
          let lines;
          try { lines = await (this.config.recognizeSubtitles ?? recognizeNativeText)(file); }
          catch (error) { throw new GalleryError(503, `原生字幕识别不可用：${error instanceof Error ? error.message : String(error)}`, 'gallery_ocr_unavailable'); }
          const result = selectNativeSubtitle(lines.map(line => ({ ...line, top: .5 + line.top * .48, bottom: .5 + line.bottom * .48 })), quote.text, region);
          if (result && (!best || result.score > best.score)) best = { time, ...result };
          if (result && (!found.length || result.recognizedText.replace(/[^\p{L}\p{N}]/gu, '') !== found.at(-1)!.recognizedText!.replace(/[^\p{L}\p{N}]/gu, ''))) {
            found.push({ time, bandTop: result.bandTop, bandBottom: result.bandBottom, recognizedText: result.recognizedText, verification: 'ocr' });
          }
        }
        if (collect) return found;
        if (!best) return [];
        return [{ time: best.time, bandTop: best.bandTop, bandBottom: best.bandBottom, recognizedText: best.recognizedText, verification: 'ocr' }];
      }
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
      if (candidates.length < 2) return [];
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
      if (!best || bestScore > .4) return [];
      return [{ time: best.time, bandTop: best.top, bandBottom: best.bottom, verification: 'pixels' }];
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async render(video: string, image: GalleryImage, output: string): Promise<void> {
    const info = await this.probe(video);
    validateGalleryImage(image, info.duration);
    if (image.translatedCaptions !== undefined) return renderTranslatedGallery(image, time => this.frame(video, time), output, this.config);
    await mkdir(path.dirname(output), { recursive: true });
    const dir = await mkdtemp(path.join(path.dirname(output), 'frames-'));
    try {
      const times = [image.mainTime, ...image.times];
      for (const [index, time] of times.entries()) {
        await this.execute(['-ss', String(time), '-i', video, '-frames:v', '1', '-threads', '1', path.join(dir, `${index}.png`)]);
      }
      let filters: string[];
      if (image.filmstrip) {
        const desiredMain = Math.round(1440 * image.mainFraction / 2) * 2;
        const bandHeight = Math.max(galleryFilmstripHeight(info, image.bandTop, image.bandBottom),
          Math.floor((1440 - desiredMain) / image.times.length / 2) * 2);
        const mainHeight = 1440 - bandHeight * image.times.length;
        if (mainHeight < 432) throw new GalleryError(422, '字幕区域过高，请拆分图片以保证可读性');
        const c = image.mainCrop;
        const mainCrop = c ? `crop=iw*${c.right - c.left}:ih*${c.bottom - c.top}:iw*${c.left}:ih*${c.top},` : '';
        filters = [`[0:v]${mainCrop}scale=1080:${mainHeight}:force_original_aspect_ratio=increase,crop=1080:${mainHeight},setsar=1[v0]`];
        for (const [i, time] of image.times.entries()) {
          const bg = await this.suggestMainCrop(video, { ...image, mainTime: time });
          const bgCrop = `crop=iw*${bg.right - bg.left}:ih*${bg.bottom - bg.top}:iw*${bg.left}:ih*${bg.top},`;
          filters.push(`[${i + 1}:v]split=2[bg${i}][text${i}]`);
          filters.push(`[bg${i}]${bgCrop}scale=1080:${bandHeight}:force_original_aspect_ratio=increase,crop=1080:${bandHeight},setsar=1[b${i}]`);
          filters.push(`[text${i}]crop=iw:ih*${image.bandBottom - image.bandTop}:0:ih*${image.bandTop},scale=1080:-2,setsar=1[t${i}]`);
          filters.push(`[b${i}][t${i}]overlay=0:(H-h)/2:shortest=1[v${i + 1}]`);
        }
        filters.push(`${times.map((_, i) => `[v${i}]`).join('')}vstack=inputs=${times.length}[out]`);
      } else {
        const desiredMain = Math.round(1440 * image.mainFraction / 2) * 2;
        const nativeStrip = (image.bandBottom - image.bandTop) * info.height * 1080 / info.width;
        let mainHeight = image.times.length >= 6
          ? Math.max(576, Math.min(desiredMain, Math.floor((1440 - image.times.length * Math.max(64, nativeStrip)) / 2) * 2))
          : desiredMain;
        if (image.times.length > 6 && nativeStrip > (1440 - mainHeight) / image.times.length + 2) throw new GalleryError(422, '字幕区域过高，请缩小区域或拆分图片以保证可读性');
        const c = image.mainCrop;
        let bandHeight = Math.floor((1440 - mainHeight) / image.times.length / 2) * 2;
        if (image.compact) {
          bandHeight = Math.ceil(Math.max(64, nativeStrip + 12) / 2) * 2;
          const naturalMain = 1080 * info.height * (c ? c.bottom - c.top : 1) / (info.width * (c ? c.right - c.left : 1));
          mainHeight = Math.floor(Math.min(desiredMain, naturalMain, 1440 - bandHeight * image.times.length) / 2) * 2;
          if (mainHeight < 144 || (image.times.length > 6 && mainHeight < 576)) throw new GalleryError(422, '字幕区域过高，请拆分图片以保证可读性');
        }
        const mainCrop = c ? `crop=iw*${c.right - c.left}:ih*${c.bottom - c.top}:iw*${c.left}:ih*${c.top},` : '';
        filters = [`[0:v]${mainCrop}scale=1080:${mainHeight}:force_original_aspect_ratio=decrease,pad=1080:${mainHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0]`];
        image.times.forEach((_, i) => {
          const height = !image.compact && i === image.times.length - 1 ? 1440 - mainHeight - i * bandHeight : bandHeight;
          filters.push(`[${i + 1}:v]crop=iw:ih*${image.bandBottom - image.bandTop}:0:ih*${image.bandTop},scale=1080:${height}:force_original_aspect_ratio=decrease,pad=1080:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i + 1}]`);
        });
        filters.push(`${times.map((_, i) => `[v${i}]`).join('')}vstack=inputs=${times.length}${image.compact ? ',pad=1080:1440:0:0:color=black' : ''}[out]`);
      }
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

  async suggestMainCrop(video: string, image: GalleryImage): Promise<NonNullable<GalleryImage['mainCrop']>> {
    const info = await this.probe(video);
    validateGalleryImage(image, info.duration);
    const height = Math.max(2, Math.floor(info.height * image.bandTop / 2) * 2);
    const { stderr } = await runCommand(this.config.ffmpegBinary ?? 'ffmpeg', ['-hide_banner', '-ss', String(image.mainTime), '-i', video,
      '-vf', `crop=iw:${height}:0:0,cropdetect=24:2:0`, '-frames:v', '3', '-an', '-f', 'null', '-'], { captureStderr: true, timeoutMs: 20_000 });
    const crops = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    const values = crops.at(-1)?.slice(1).map(Number);
    if (values) {
      const [width, cropHeight, x, y] = values as [number, number, number, number];
      if (width >= 16 && cropHeight >= 16 && x + width <= info.width && y + cropHeight <= height) {
        return { left: x / info.width, right: (x + width) / info.width, top: y / info.height, bottom: (y + cropHeight) / info.height };
      }
    }
    return { left: 0, right: 1, top: 0, bottom: height / info.height };
  }
}
