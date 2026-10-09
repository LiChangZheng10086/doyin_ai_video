import type { TranscriptSegment } from "../types.js";
export function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(url.hostname);
  } catch { return false; }
}

export function selectYouTubeCaption(metadata: Record<string, unknown>): { language: string; automatic: boolean } | null {
  for (const [field, automatic] of [["subtitles", false], ["automatic_captions", true]] as const) {
    const tracks = metadata[field];
    if (!tracks || typeof tracks !== "object") continue;
    const languages = Object.entries(tracks).filter(([language, formats]) =>
      /^[a-zA-Z0-9-]+$/.test(language) && Array.isArray(formats) && formats.some((format) => {
        if (format?.ext !== "json3" || typeof format.url !== "string") return false;
        try { return !new URL(format.url).searchParams.has("tlang"); } catch { return false; }
      })
    ).map(([language]) => language);
    const preferred = [typeof metadata.language === "string" ? `${metadata.language}-orig` : "", String(metadata.language ?? ""), ...languages.filter((language) => language.endsWith("-orig")), "en"];
    languages.sort((a, b) => {
      const rank = (language: string) => preferred.indexOf(language) < 0 ? preferred.length : preferred.indexOf(language);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    if (languages.length) return { language: languages[0], automatic };
  }
  return null;
}

type Json3Event = { tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> };

export function parseYouTubeJson3(payload: unknown, duration?: number): TranscriptSegment[] {
  const events = (payload as { events?: Json3Event[] })?.events;
  if (!Array.isArray(events)) throw new Error("YouTube 字幕 JSON3 缺少 events");
  const cues: Array<{ start: number; end: number; text: string }> = [];
  for (const event of events) {
    if (!event || (event.segs !== undefined && (!Array.isArray(event.segs) || event.segs.some((segment) => !segment || (segment.utf8 !== undefined && typeof segment.utf8 !== "string"))))) {
      throw new Error("YouTube 字幕文字结构无效");
    }
    let text = event.segs?.map((segment) => segment.utf8 ?? "").join("").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    if (typeof event.tStartMs !== "number" || typeof event.dDurationMs !== "number") throw new Error("YouTube 字幕时间缺失或无效");
    const start = Number(event.tStartMs) / 1000;
    let end = start + Number(event.dDurationMs) / 1000;
    const previous = cues.at(-1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || (previous && start < previous.start) || (duration !== undefined && (start >= duration || end > duration + 0.5))) {
      throw new Error("YouTube 字幕时间缺失、倒序或超出视频时长");
    }
    if (duration !== undefined) end = Math.min(end, duration);
    if (previous && start < previous.end) {
      if (previous.text === text) { previous.end = Math.max(previous.end, end); continue; }
      // Only overlapping windows share rolling text; later spoken repetitions remain intact.
      for (let length = Math.min(previous.text.length, text.length); length > 0; length -= 1) {
        if (previous.text.slice(-length) === text.slice(0, length) && (length === previous.text.length || previous.text[previous.text.length - length - 1] === " ") && (length === text.length || text[length] === " ")) {
          text = text.slice(length).trim();
          break;
        }
      }
      if (!text) { previous.end = Math.max(previous.end, end); continue; }
      if (start === previous.start) { previous.text += ` ${text}`; previous.end = Math.max(previous.end, end); continue; }
      previous.end = start;
    }
    cues.push({ start, end, text });
  }
  if (!cues.length) throw new Error("YouTube 字幕没有有效文字");
  return cues;
}
