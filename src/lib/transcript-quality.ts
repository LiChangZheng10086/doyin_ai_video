import type { TranscriptSegment } from "../types.js";

export function inspectTranscriptQuality(input: {
  segments: TranscriptSegment[];
  text?: string;
  duration?: number;
}): string[] {
  const issues = new Set<string>();
  let previousStart = -1;
  for (const segment of input.segments) {
    const { start, end } = segment;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
      issues.add("转录分段时间缺失或无效，请重新转录");
      continue;
    }
    if (start < 0 || end <= start || start < previousStart) issues.add("转录分段时间倒序或范围无效，请重新转录");
    if (input.duration !== undefined && (start >= input.duration || end > input.duration + 0.5)) {
      issues.add("转录分段超出音频时长，请重新转录");
    }
    previousStart = start;
  }
  const texts = input.segments.map((segment) => normalizeText(segment.text));
  // ponytail: conservative loops only; shorter repeats and semantic hallucinations still need manual review.
  for (let width = 1; width <= 4; width += 1) {
    let runStart = 0;
    for (let index = width; index < texts.length; index += 1) {
      if (!texts[index] || texts[index] !== texts[index - width]) {
        runStart = index - width + 1;
        continue;
      }
      const count = index - runStart + 1;
      const start = input.segments[runStart]?.start;
      const end = input.segments[index]?.end;
      const span = start !== undefined && end !== undefined ? end - start : 0;
      if (count >= Math.max(12, width * 8) && (span >= 20 || count >= 24)) {
        issues.add("转录出现持续循环重复，请重新转录并核对原视频");
      }
    }
  }
  const fullTexts = [...texts, normalizeText(input.text ?? "")];
  if (fullTexts.some((text) => /(.{4,80}?)\1{7,}/u.test(text))) {
    issues.add("转录句内出现长串重复，请重新转录并核对原视频");
  }
  return [...issues];
}

function normalizeText(text: string) {
  return text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase();
}
