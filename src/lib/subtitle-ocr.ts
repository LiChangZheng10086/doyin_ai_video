import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './command.js';
import { toSimplifiedChinese } from './chinese.js';

export interface NativeTextLine {
  text: string;
  confidence: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type SubtitleRecognizer = (image: string) => Promise<NativeTextLine[]>;

export function nativeSubtitleOcrBinary(): string {
  const runtime = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean };
  const resources = !runtime.defaultApp && runtime.resourcesPath;
  const binary = resources ? path.join(resources, 'bin/subtitle-ocr')
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/runtime/subtitle-ocr');
  return binary;
}

export function nativeSubtitleOcrAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(nativeSubtitleOcrBinary());
}

export async function recognizeNativeText(image: string): Promise<NativeTextLine[]> {
  const binary = nativeSubtitleOcrBinary();
  if (!nativeSubtitleOcrAvailable()) {
    throw new Error('原生字幕 OCR 未就绪：macOS 开发环境请运行 npm run prepare:subtitle-ocr；其它系统请使用手动高级调整。');
  }
  const { stdout } = await runCommand(binary, [image], { captureStdout: true, captureStderr: true, timeoutMs: 30_000 });
  const lines: unknown = JSON.parse(stdout);
  if (!Array.isArray(lines) || lines.length > 200) throw new Error('原生字幕 OCR 返回格式异常');
  return lines.filter((line): line is NativeTextLine => Boolean(line) && typeof line.text === 'string'
    && [line.confidence, line.left, line.top, line.right, line.bottom].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
    && line.left < line.right && line.top < line.bottom);
}

function normalize(text: string): string {
  return toSimplifiedChinese(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function commonCharacters(a: string, b: string): number {
  const previous = Array(b.length + 1).fill(0) as number[];
  for (const char of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const old = previous[j]!;
      previous[j] = char === b[j - 1] ? diagonal + 1 : Math.max(previous[j]!, previous[j - 1]!);
      diagonal = old;
    }
  }
  return previous[b.length]!;
}

// OCR is corroborating evidence, never a replacement for the original subtitle pixels.
export function selectNativeSubtitle(lines: NativeTextLine[], quote: string, region: { bandTop?: number; bandBottom?: number } = {}):
  { bandTop: number; bandBottom: number; recognizedText: string; score: number } | null {
  const expected = normalize(quote);
  if (expected.length < 2) return null;
  const newsLabels = lines.filter(line => /相关搜索|新闻直播|直播间/u.test(line.text));
  const matching = lines.filter(line => {
    const text = normalize(line.text);
    if (line.confidence < .5 || text.length < 2 || text.length > 60) return false;
    if (line.top < (region.bandTop ?? .5) || line.bottom > (region.bandBottom ?? .98)) return false;
    if (line.bottom - line.top > .12 || Math.abs((line.left + line.right) / 2 - .5) > .12) return false;
    if (/相关搜索|新闻直播|直播间|关注|点赞|\d+月\d+日/u.test(line.text)) return false;
    if (newsLabels.some(label => line.top <= label.bottom + .03 && line.bottom >= label.top - .03)) return false;
    const common = commonCharacters(text, expected);
    const bigram = Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)).some(pair => expected.includes(pair));
    if (text.length <= 4) return expected.includes(text);
    // Clear native glyphs can corroborate ASR word errors; short or weak matches still require the stricter ratio.
    return bigram && common >= 3 && (common / text.length >= .75
      || (common >= 7 && common / text.length >= .6)
      || (line.confidence >= .9 && common >= 6 && common / text.length >= .5));
  }).sort((a, b) => a.top - b.top);
  let best: ReturnType<typeof selectNativeSubtitle> = null;
  for (let i = 0; i < matching.length; i++) {
    const group = [matching[i]!];
    for (let j = i + 1; j < matching.length; j++) {
      const next = matching[j]!;
      if (next.top - group.at(-1)!.bottom > .05 || next.bottom - group[0]!.top > .16) break;
      group.push(next);
    }
    const recognizedText = group.map(line => line.text).join('');
    const text = normalize(recognizedText);
    const score = commonCharacters(text, expected) / Math.max(text.length, expected.length) + Math.min(...group.map(line => line.confidence)) * .05;
    if (!best || score > best.score) best = {
      bandTop: region.bandTop ?? Math.max(0, group[0]!.top - .012),
      bandBottom: region.bandBottom ?? Math.min(1, group.at(-1)!.bottom + .012),
      recognizedText, score,
    };
  }
  return best;
}
