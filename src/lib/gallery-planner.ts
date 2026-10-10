import type { TranscriptAsset } from '../types.js';
import type { GalleryImage, GalleryPlan, GalleryPlanInput, GalleryQuote, GallerySource } from './gallery-types.js';
import { GalleryError, galleryFilmstripHeight } from './gallery-media.js';
import { inspectTranscriptQuality } from './transcript-quality.js';

export type SubtitleCandidate = { time: number; bandTop: number; bandBottom: number; recognizedText?: string; verification?: 'ocr' | 'pixels' };

function balancedGroupSize(remaining: number, target: number): number {
  let groups = Math.ceil(remaining / target);
  while (target >= 6 && target <= 9 && groups > 1 && remaining / groups < 6 && Math.ceil(remaining / (groups - 1)) <= 9) groups--;
  return Math.ceil(remaining / groups);
}

export function galleryPlanBlockReason(plan: Pick<GalleryPlan, 'images' | 'excluded'>): string | undefined {
  const matched = new Set(plan.images.flatMap(image => image.quotes.map(quote => `${quote.segmentIndex}:${quote.start}:${quote.end}`))).size;
  if (plan.excluded.length) return `内容不完整（${matched} 个定位片段可用，${plan.excluded.length} 个未匹配），覆盖不足，不能生成完整图集；请重新转录或校准后重新规划。`;
  return undefined;
}

export async function planGallery(
  transcript: TranscriptAsset,
  source: GallerySource,
  candidate: (quote: GalleryQuote) => Promise<SubtitleCandidate | SubtitleCandidate[] | null>,
  options: Omit<GalleryPlanInput, 'version'> = {},
): Promise<Pick<GalleryPlan, 'images' | 'warnings' | 'excluded' | 'blockedReason'>> {
  const target = options.targetLines ?? 8;
  if (!Number.isSafeInteger(target) || target < 1) throw new GalleryError(422, '每张目标条数须为正整数');
  if ((options.bandTop === undefined) !== (options.bandBottom === undefined)
    || (options.bandTop !== undefined && (!Number.isFinite(options.bandTop) || !Number.isFinite(options.bandBottom)
      || options.bandTop < 0 || options.bandBottom! > 1 || options.bandBottom! - options.bandTop < .01))) {
    throw new GalleryError(422, '请提供完整且有效的字幕区域');
  }
  if (!Array.isArray(transcript?.segments) || !transcript.segments.length) throw new GalleryError(422, '请先完成有效视频转录');
  if (transcript.segments.some(s => !s || typeof s.text !== 'string')) throw new GalleryError(422, '转录分段格式异常，请重新转录');
  const issues = inspectTranscriptQuality({ segments: transcript.segments, text: transcript.transcript ?? transcript.text, duration: source.duration });
  if (issues.length) throw new GalleryError(422, `转录存在异常，请重新转录：${issues.join('；')}`);
  const warnings = ['系统自动选取的画面可能误选。请核对字幕完整、清楚且与原视频一致；转录文字仅供定位。'];
  const excluded: GalleryPlan['excluded'] = [];
  const quotes: GalleryQuote[] = [];
  let pending: GalleryQuote | undefined;
  const flush = () => { if (pending) quotes.push(pending); pending = undefined; };
  for (const [segmentIndex, segment] of transcript.segments.entries()) {
    const { start, end } = segment;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || start >= source.duration || end > source.duration + .5) {
      throw new GalleryError(422, '转录时间不完整或超出原视频，请重新转录');
    }
    if (!segment.text.trim()) continue;
    const readableEnd = Math.min(end, source.duration - .001);
    if (readableEnd <= start) {
      flush(); excluded.push({ segmentIndex, reason: '尾段没有可读取的有效时间范围，请核对原视频' }); continue;
    }
    const text = segment.text;
    const parts = text.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/gu) ?? [text];
    let offset = 0;
    for (const part of parts) {
      // ponytail: character interpolation is a fallback; use valid word timestamps when the recognizer supplies them.
      const matchingWords = transcript.words?.filter(w => typeof w.start === 'number' && typeof w.end === 'number'
        && w.start >= start && w.end <= readableEnd && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
      for (let at = 0; at < part.length; at += 36) {
        const chunk = part.slice(at, at + 36);
        const from = offset + at; const to = from + chunk.length;
        let chunkStart = start + (readableEnd - start) * from / text.length;
        let chunkEnd = start + (readableEnd - start) * to / text.length;
        if (matchingWords?.map(w => w.word).join('') === text) {
          let pos = 0;
          const words = matchingWords.filter(w => { const old = pos; pos += w.word.length; return pos > from && old < to; });
          if (words.length) { chunkStart = words[0]!.start!; chunkEnd = Math.min(source.duration - .001, words.at(-1)!.end!); }
        }
        const q = { segmentIndex, text: chunk, start: chunkStart, end: chunkEnd };
        if (pending && q.start - pending.end < 1.5 && pending.text.length + chunk.length <= 36 && chunkEnd - pending.start <= 4 && !/[。！？!?\n]$/u.test(pending.text)) {
          pending.text += chunk; pending.end = chunkEnd;
        } else { flush(); pending = q; }
        if (/[。！？!?\n]$/u.test(chunk) || chunk.length === 36) flush();
      }
      offset += part.length;
    }
  }
  flush();
  const selected: { quote: GalleryQuote; candidate: SubtitleCandidate }[] = [];
  for (const quote of quotes) {
    const result = await candidate(quote);
    const found = (Array.isArray(result) ? result : result ? [result] : []).sort((a, b) => a.time - b.time);
    if (!found.length) {
      excluded.push({ segmentIndex: quote.segmentIndex, reason: `「${quote.text}」附近未找到与定位文字匹配的可读原生字幕，可能是横幅、转录偏差或字幕切换；请校准字幕区域或使用高级调整` });
      continue;
    }
    for (const item of found) {
      const text = item.verification === 'ocr' && item.recognizedText ? item.recognizedText : quote.text;
      const previous = selected.at(-1);
      if (item.verification === 'ocr' && previous?.candidate.verification === 'ocr'
        && text.replace(/[^\p{L}\p{N}]/gu, '') === previous.quote.text.replace(/[^\p{L}\p{N}]/gu, '')) continue;
      selected.push({ quote: { ...quote, text, verification: item.verification }, candidate: item });
      if (item.verification === 'pixels' && !warnings.some(w => w.includes('仅为像素候选'))) {
        warnings.push('本地 OCR 未就绪，当前仅为像素候选，稳定横幅也可能入选。请逐条核对原画面或统一校准区域；macOS 可运行 npm run prepare:subtitle-ocr 启用本地文字核对。');
      }
    }
  }
  const images: GalleryPlan['images'] = [];
  let group: { quote: GalleryQuote; candidate: SubtitleCandidate }[] = [];
  let limit: number = target;
  const finish = () => {
    if (!group.length) return;
    const top = Math.min(...group.map(g => g.candidate.bandTop));
    const bottom = Math.max(...group.map(g => g.candidate.bandBottom));
    const image: GalleryImage = { mainTime: group[0]!.candidate.time, times: group.map(g => g.candidate.time), bandTop: top, bandBottom: bottom, filmstrip: true,
      mainFraction: .48 };
    images.push({ title: group[0]!.quote.text.slice(0, 36), quotes: group.map(g => g.quote), image });
    group = [];
  };
  for (const [index, item] of selected.entries()) {
    if (!group.length) limit = balancedGroupSize(selected.length - index, target);
    const proposed = [...group, item];
    const top = Math.min(...proposed.map(g => g.candidate.bandTop));
    const bottom = Math.max(...proposed.map(g => g.candidate.bandBottom));
    const strip = galleryFilmstripHeight(source, top, bottom);
    if (group.length && (group.length >= limit || strip * proposed.length > 1008)) {
      finish();
      limit = balancedGroupSize(selected.length - index, target);
    }
    group.push(item);
  }
  finish();
  if (images.some(i => i.quotes.length < target)) warnings.push('内容边界、长句或字幕区域高度使部分图片少于建议条数；保留完整文字并优先保证可读性。');
  if (!images.length) warnings.push('没有可用原生字幕候选，当前方案不能生成。');
  return { images, warnings, excluded, blockedReason: galleryPlanBlockReason({ images, excluded }) };
}
