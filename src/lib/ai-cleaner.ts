import OpenAI from "openai";
import { toSimplifiedChinese } from "./chinese.js";
import { diagnoseAiError } from "./ai-errors.js";
import { extractAiMessageText } from "./ai-response.js";
import { buildScriptDraft, buildTranscriptDraft } from "./script-builder.js";
import type { DouyinShareParseResult } from "./douyin.js";
import type { DouyinPageInfo } from "./douyin-page.js";
import type {
  AiProvider,
  ScriptAsset,
  ShortVideoPlan,
  ShortVideoShot,
  ShortVideoVisualItem,
  ShotLayout,
  ShotPacing,
  ShotTransition,
  ShotType
} from "../types.js";

export interface ScriptCleanerInput {
  parsed?: DouyinShareParseResult | null;
  transcriptText?: string | null;
  topic: string;
  draft: ScriptAsset;
  pageInfo?: DouyinPageInfo | null;
}

export interface AiStreamUpdate {
  delta: string;
  text: string;
  model: string;
}

export type AiStreamListener = (update: AiStreamUpdate) => void;

export interface ScriptCleaner {
  clean(input: ScriptCleanerInput, signal?: AbortSignal, onStream?: AiStreamListener): Promise<ScriptAsset>;
  planShortVideo?(script: ScriptAsset, signal?: AbortSignal, onStream?: AiStreamListener): Promise<ShortVideoPlan>;
}

export interface OpenAiScriptCleanerOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  thinkingMode?: "enabled" | "disabled";
  provider?: AiProvider;
}

export class RuntimeScriptCleaner implements ScriptCleaner {
  constructor(
    private readonly resolveOptions: () => Promise<OpenAiScriptCleanerOptions | null>,
    private readonly createCleaner: (options: OpenAiScriptCleanerOptions) => ScriptCleaner = (options) => new OpenAiScriptCleaner(options)
  ) {}

  async clean(input: ScriptCleanerInput, signal?: AbortSignal, onStream?: AiStreamListener) {
    return (await this.current()).clean(input, signal, onStream);
  }

  async planShortVideo(script: ScriptAsset, signal?: AbortSignal, onStream?: AiStreamListener) {
    const cleaner = await this.current();
    if (!cleaner.planShortVideo) throw new Error("AI 分镜服务不可用");
    return cleaner.planShortVideo(script, signal, onStream);
  }

  private async current() {
    return this.createCleaner((await this.resolveOptions()) ?? {});
  }
}

type CleanScriptPayload = {
  title: string;
  summary: string;
  hook: string;
  key_points: string[];
  clean_script: string;
  short_video_script: string;
  cover_title: string;
  tags: string[];
  quality_notes: string[];
};

const SHOT_TYPES = new Set<ShotType>(["hook", "problem", "explain", "proof", "contrast", "process", "summary", "cta"]);
const SHOT_LAYOUTS = new Set<ShotLayout>(["kinetic-title", "concept-map", "process-flow", "comparison", "metric", "summary-stack"]);
const SHOT_TRANSITIONS = new Set<ShotTransition>(["cut", "wipe", "push", "zoom", "match-cut", "flash"]);
const SHOT_PACING = new Set<ShotPacing>(["fast", "medium", "slow"]);
const PRODUCTION_TEXT = /\bSHOT\b|camera\s*motion|panel\s*reveal|highlight\s*sweep|slow\s*push|match[- ]cut|9\s*:\s*16|动态图形|无真人|视觉层|镜头运动/i;

export class OpenAiScriptCleaner implements ScriptCleaner {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly baseURL?: string;
  private readonly thinkingMode: "enabled" | "disabled";
  private readonly provider: AiProvider;

  constructor(options: OpenAiScriptCleanerOptions = {}) {
    this.model = options.model ?? process.env.AI_MODEL ?? "deepseek-v4-pro";
    this.baseURL = options.baseURL;
    this.provider = options.provider ?? (options.baseURL ? "deepseek" : "openai");
    this.thinkingMode = options.thinkingMode ?? (process.env.AI_THINKING_MODE as "enabled" | "disabled") ?? "disabled";
    if (this.provider === "custom" && !this.baseURL?.trim()) {
      throw new Error("自定义 AI 配置缺少 Base URL");
    }
    if (options.apiKey) {
      this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
    }
  }

  async clean(input: ScriptCleanerInput, signal?: AbortSignal, onStream?: AiStreamListener): Promise<ScriptAsset> {
    if (!this.client) {
      throw new Error("未配置 AI API Key，无法执行 AI 洗稿");
    }
    const draft = input.draft ?? this.buildDraft(input);
    let correction = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let text: string;
      try {
        text = await this.completeJson([
          {
            role: "system",
            content: "你是中文短视频文案编辑。所有观众可见文字必须使用中国大陆规范简体中文，禁止使用繁体字。只负责清洗、压缩和重写内容，不生成 PPT 大纲、分镜或视觉提示词。只输出合法 JSON。"
          },
          {
            role: "user",
            content: [
              "请将视频转录重写成一份 50 到 60 秒无声动效短视频可用的精编文案。",
              `主题：${input.topic}`,
              `页面标题：${input.pageInfo?.pageTitle ?? "无"}`,
              `分享文本：${input.parsed?.shareText ?? "无"}`,
              "视频转录（最高优先级）：",
              input.transcriptText ?? draft.rawText,
              "要求：不得编造原文没有的能力、数据或结论；修正明显口语废词和重复；技术名词优先参考页面标题与分享文本。",
              "short_video_script 必须为 180 到 260 个中文字符，形成完整的钩子、核心内容和结论。",
              "key_points 为 3 到 6 条；summary 不超过 80 字；不要输出 video_outline、bullets、scene_list 或视觉提示词。",
              "JSON 字段：title, summary, hook, key_points, clean_script, short_video_script, cover_title, tags, quality_notes。",
              correction
            ].filter(Boolean).join("\n")
          }
        ], 2400, signal, onStream);
      } catch (error) {
        const diagnosis = await diagnoseAiError(error, { baseURL: this.baseURL, model: this.model });
        throw new Error(`AI 洗稿失败：${diagnosis.message}`);
      }

      try {
        return this.toAssetFromPayload(parseCleanPayload(text), draft);
      } catch (error) {
        if (attempt === 0) {
          correction = `上一次输出未通过校验：${errorMessage(error)}。请保持原文事实不变，只修正 JSON 字段和长度后重新输出完整 JSON。`;
          continue;
        }
        const diagnosis = await diagnoseAiError(error, { baseURL: this.baseURL, model: this.model });
        throw new Error(`AI 洗稿失败：${diagnosis.message}`);
      }
    }
    throw new Error("AI 洗稿失败");
  }

  async planShortVideo(script: ScriptAsset, signal?: AbortSignal, onStream?: AiStreamListener): Promise<ShortVideoPlan> {
    if (!this.client) {
      throw new Error("未配置 AI API Key，无法生成分镜");
    }
    const keyPoints = script.keyPoints ?? [];
    let correction = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const text = await this.completeJson([
          {
            role: "system",
            content: "你是无真人短视频分镜导演。所有观众可见文字必须使用中国大陆规范简体中文，禁止使用繁体字。把精编文案转成结构化镜头，不写 HTML，不输出制作说明文字，只输出合法 JSON。"
          },
          {
            role: "user",
            content: [
              "为下面的 9:16 无声本地图形短视频生成 8 到 10 个连续镜头，总时长 50 到 60 秒。",
              `标题：${script.coverTitle || script.title || script.topic}`,
              `精编文案：${script.shortVideoScript || script.cleanScript}`,
              `核心要点：${keyPoints.map((point, index) => `${index}:${point}`).join("；")}`,
              "首镜必须是 hook，末段必须有 summary 或 cta，至少四个内容镜头。",
              "layout 只能是 kinetic-title、concept-map、process-flow、comparison、metric、summary-stack。",
              "headline 最多 18 字，supporting_text 最多 40 字，caption_lines 为 1 到 2 行且每行最多 16 字。",
              "visual_items 为 2 到 5 项，每项包含最多 12 字的 label、可选的最多 12 字 value 和 tone(primary/success/danger/muted)。",
              "source_key_points 必须引用核心要点索引，并覆盖每一条核心要点。没有原文数字时禁止使用 metric。",
              "shot_type、layout、transition 必须使用规定枚举；可使用的 shot_type 为 hook/problem/explain/proof/contrast/process/summary/cta，layout 必须与 shot_type 对应。explain 只能使用 concept-map；没有原文数字时不要使用 proof/metric。",
              "不要把 SHOT、镜头运动、节奏、转场名、9:16、动态图形、视觉层等制作术语写进观众文字。",
              "JSON 字段：target_duration, shots。每个 shot 字段：index, duration, shot_type, layout, headline, supporting_text, caption_lines, visual_items, source_key_points, transition, pacing。",
              correction
            ].filter(Boolean).join("\n")
          }
        ], undefined, signal, onStream);
        const parsed = parseAiJson(text);
        const sourceText = [
          script.shortVideoScript,
          script.cleanScript,
          script.summary,
          ...(script.keyPoints ?? [])
        ].filter(Boolean).join("\n");
        const validated = validateShortVideoPlan(parsed, keyPoints.length, sourceText);
        return {
          planVersion: 2,
          targetDuration: 60,
          shortVideoScript: script.shortVideoScript || script.cleanScript,
          shots: validated.shots
        };
      } catch (error) {
        correction = `上一次输出未通过校验：${errorMessage(error)}。请完整修正后重新输出 JSON。`;
        if (attempt === 1) {
          const diagnosis = await diagnoseAiError(error, { baseURL: this.baseURL, model: this.model });
          throw new Error(`AI 分镜生成失败：${diagnosis.message}`);
        }
      }
    }
    throw new Error("AI 分镜生成失败");
  }

  private async completeJson(
    messages: Array<{ role: "system" | "user"; content: string }>,
    maxTokens?: number,
    signal?: AbortSignal,
    onStream?: AiStreamListener
  ) {
    const request = {
      model: this.model,
      messages,
      response_format: { type: "json_object" },
      ...(onStream ? { stream: true } : {}),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(this.provider === "deepseek" ? { extra_body: { thinking: { type: this.thinkingMode } } } : {})
    } as any;
    const requestOptions = signal ? { signal } : undefined;
    let response: any;
    try {
      response = await this.client!.chat.completions.create(request, requestOptions);
    } catch (error) {
      if (!onStream || !isStreamingUnsupportedError(error)) throw error;
      const { stream: _stream, ...fallbackRequest } = request;
      response = await this.client!.chat.completions.create(fallbackRequest, requestOptions);
    }
    if (onStream && isAsyncIterable(response)) {
      let text = "";
      for await (const chunk of response) {
        const choice = (chunk as { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }> }).choices?.[0];
        if (choice?.finish_reason === "length") {
          throw new Error("AI 输出被截断（达到输出长度上限）");
        }
        const delta = extractDeltaText(choice?.delta?.content);
        if (!delta) continue;
        text += delta;
        onStream({ delta, text, model: this.model });
      }
      if (!text.trim()) throw new Error("AI 返回了空内容");
      return text;
    }
    if (response?.choices?.[0]?.finish_reason === "length") {
      throw new Error("AI 输出被截断（达到输出长度上限）");
    }
    const text = extractAiMessageText(response?.choices?.[0]?.message);
    if (!text) {
      throw new Error("AI 返回了空内容");
    }
    onStream?.({ delta: text, text, model: this.model });
    return text;
  }

  private toAssetFromPayload(payload: CleanScriptPayload, draft: ScriptAsset): ScriptAsset {
    return {
      ...draft,
      title: payload.title,
      summary: payload.summary,
      hook: payload.hook,
      cleanScript: payload.clean_script,
      shortVideoScript: payload.short_video_script,
      voiceoverScript: payload.short_video_script,
      coverTitle: payload.cover_title,
      tags: dedupeTags([...(payload.tags ?? []), ...(draft.tags ?? [])]),
      keyPoints: payload.key_points,
      qualityNotes: payload.quality_notes,
      videoOutline: undefined,
      sceneList: [],
      aiModel: this.model,
      cleaningMode: this.provider,
      cleanedAt: new Date().toISOString(),
      status: "ready"
    };
  }

  private buildDraft(input: ScriptCleanerInput) {
    if (input.parsed) {
      return buildScriptDraft(input.parsed, input.topic, input.pageInfo);
    }
    if (input.transcriptText?.trim()) {
      return buildTranscriptDraft({
        sourceUrl: input.draft.sourceUrl,
        transcriptText: input.transcriptText,
        topic: input.topic,
        pageInfo: input.pageInfo
      });
    }
    return input.draft;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

function extractDeltaText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown; content?: unknown }).text
      ?? (part as { content?: unknown }).content;
    return typeof text === "string" ? text : "";
  }).join("");
}

function isStreamingUnsupportedError(error: unknown) {
  const status = Number((error as { status?: unknown })?.status);
  const message = error instanceof Error ? error.message : String(error);
  return [400, 405, 415, 422].includes(status) && /stream|streaming|流式/i.test(message);
}

export function validateShortVideoPlan(raw: unknown, keyPointCount: number, sourceText = "") {
  const plan = objectValue(raw, "分镜必须是 JSON 对象");
  const shotValues = arrayValue(plan.shots, "shots 必须是数组");
  const errors: string[] = [];
  if (plan.target_duration !== undefined && numberValue(plan.target_duration, 0) !== 60) {
    errors.push("target_duration 必须为 60");
  }
  if (shotValues.length < 8 || shotValues.length > 10) {
    errors.push("镜头数量必须为 8 到 10 个");
  }

  const shots = shotValues.map((value, index) => normalizeShot(value, index, errors, sourceText));
  const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (total < 50 || total > 60) {
    errors.push(`总时长 ${total} 秒，必须在 50 到 60 秒之间`);
  }
  if (shots[0]?.shotType !== "hook") {
    errors.push("首镜必须是 hook");
  }
  if (!shots.slice(-2).some((shot) => shot.shotType === "summary" || shot.shotType === "cta")) {
    errors.push("末段缺少 summary 或 cta");
  }
  if (shots.filter((shot) => !["hook", "summary", "cta"].includes(shot.shotType)).length < 4) {
    errors.push("至少需要四个内容镜头");
  }
  const covered = new Set(shots.flatMap((shot) => shot.sourceKeyPoints ?? []));
  if ([...covered].some((index) => index < 0 || index >= keyPointCount)) {
    errors.push("source_key_points 包含无效的核心要点索引");
  }
  for (let index = 0; index < keyPointCount; index += 1) {
    if (!covered.has(index)) {
      errors.push(`核心要点 ${index} 未被镜头覆盖`);
    }
  }
  if (errors.length) {
    throw new Error(errors.join("；"));
  }
  return { targetDuration: 60 as const, shots };
}

function normalizeShot(value: unknown, arrayIndex: number, errors: string[], sourceText: string): ShortVideoShot {
  const shot = objectValue(value, `镜头 ${arrayIndex + 1} 必须是对象`);
  const index = numberValue(shot.index, arrayIndex + 1);
  const duration = numberValue(shot.duration, 0);
  let shotType = normalizeEnumAlias(
    shot.shot_type ?? shot.shotType,
    SHOT_TYPES,
    SHOT_TYPE_ALIASES,
    "explain",
    `镜头 ${index} shotType 无效`,
    errors
  );
  normalizeEnumAlias(
    shot.layout,
    SHOT_LAYOUTS,
    SHOT_LAYOUT_ALIASES,
    layoutForShotType(shotType),
    `镜头 ${index} layout 无效`,
    errors
  );
  const headline = textValue(shot.headline);
  const supportingText = textValue(shot.supporting_text ?? shot.supportingText);
  const captionLines = arrayValue(shot.caption_lines ?? shot.captionLines, "caption_lines 必须是数组").map(textValue).filter(Boolean);
  let visualItems = arrayValue(shot.visual_items ?? shot.visualItems, "visual_items 必须是数组")
    .map((item, itemIndex) => normalizeVisualItem(item, index, itemIndex, errors));
  const sourceKeyPoints = arrayValue(shot.source_key_points ?? shot.sourceKeyPoints, "source_key_points 必须是数组").map((item) => numberValue(item, -1));
  const transition = normalizeEnumAlias(
    shot.transition,
    SHOT_TRANSITIONS,
    SHOT_TRANSITION_ALIASES,
    "cut",
    `镜头 ${index} transition 无效`,
    errors
  );
  const pacing = checkedEnum(shot.pacing, SHOT_PACING, "medium", `镜头 ${index} pacing 无效`, errors);

  if (index !== arrayIndex + 1) errors.push(`镜头索引必须连续，期望 ${arrayIndex + 1}`);
  if (duration < 3 || duration > 8) errors.push(`镜头 ${index} 时长必须为 3 到 8 秒`);
  if (headline.length < 2 || headline.length > 18) errors.push(`镜头 ${index} headline 必须为 2 到 18 字`);
  if (supportingText.length > 40) errors.push(`镜头 ${index} supportingText 超过 40 字`);
  if (captionLines.length < 1 || captionLines.length > 2) errors.push(`镜头 ${index} 字幕必须为 1 到 2 行`);
  if (captionLines.some((line) => line.length > 16)) errors.push(`镜头 ${index} 字幕单行超过 16 字`);
  if (visualItems.length < 2 || visualItems.length > 5) errors.push(`镜头 ${index} visualItems 必须为 2 到 5 项`);
  if (visualItems.some((item) => !item.label || item.label.length > 12 || (item.value?.length ?? 0) > 12)) {
    errors.push(`镜头 ${index} visualItems 文本为空或超过 12 字`);
  }
  const expectedLayout = layoutForShotType(shotType);
  let layout = expectedLayout;
  visualItems = removeUngroundedNumericValues(visualItems, sourceText);
  if (layout === "metric" && !hasGroundedNumericValue(visualItems, sourceText)) {
    shotType = "explain";
    layout = "concept-map";
  }
  if ([headline, supportingText, ...captionLines, ...visualItems.flatMap((item) => [item.label, item.value ?? ""])].some((text) => PRODUCTION_TEXT.test(text))) {
    errors.push(`镜头 ${index} 观众文字包含制作术语`);
  }

  return {
    index,
    duration,
    shotType,
    layout,
    headline,
    supportingText: supportingText || undefined,
    captionLines,
    visualItems,
    sourceKeyPoints,
    subject: headline,
    action: "",
    cameraMotion: "",
    visualLayers: [],
    caption: captionLines.join(" "),
    emphasisWords: visualItems.map((item) => item.label).slice(0, 3),
    transition,
    pacing,
    narration: captionLines.join(" ")
  };
}

const SHOT_TYPE_ALIASES: Record<string, ShotType> = {
  explanation: "explain",
  detail: "explain",
  content: "explain",
  讲解: "explain",
  解释: "explain",
  介绍: "explain",
  内容: "explain",
  开场: "hook",
  开头: "hook",
  问题: "problem",
  痛点: "problem",
  证明: "proof",
  数据: "proof",
  证据: "proof",
  对比: "contrast",
  比较: "contrast",
  流程: "process",
  步骤: "process",
  总结: "summary",
  结论: "summary",
  收束: "summary",
  号召: "cta",
  行动号召: "cta",
  "call-to-action": "cta",
  "call_to_action": "cta"
};

const SHOT_LAYOUT_ALIASES: Record<string, ShotLayout> = {
  card: "concept-map",
  cards: "concept-map",
  diagram: "concept-map",
  map: "concept-map",
  关系图: "concept-map",
  节点图: "concept-map",
  process: "process-flow",
  flow: "process-flow",
  流程: "process-flow",
  comparison: "comparison",
  compare: "comparison",
  对比: "comparison",
  metric: "metric",
  metrics: "metric",
  数字: "metric",
  数据: "metric",
  summary: "summary-stack",
  stack: "summary-stack",
  总结: "summary-stack",
  kinetic: "kinetic-title",
  title: "kinetic-title",
  "kinetic typography": "kinetic-title",
  动态标题: "kinetic-title"
};

const SHOT_TRANSITION_ALIASES: Record<string, ShotTransition> = {
  dissolve: "cut",
  fade: "cut",
  crossfade: "cut",
  "cross-fade": "cut",
  溶解: "cut",
  淡入淡出: "cut",
  "hard-cut": "cut",
  hardcut: "cut",
  直接切换: "cut",
  slide: "push",
  "slide-in": "push",
  滑动: "push",
  "match_cut": "match-cut",
  "match cut": "match-cut",
  匹配剪辑: "match-cut",
  闪白: "flash",
  闪光: "flash",
  擦除: "wipe",
  "zoom-in": "zoom",
  放大: "zoom"
};

function normalizeEnumAlias<T extends string>(
  value: unknown,
  choices: Set<T>,
  aliases: Record<string, T>,
  fallback: T,
  message: string,
  errors: string[]
): T {
  const token = enumToken(value);
  if (choices.has(token as T)) return token as T;
  const alias = aliases[token];
  if (alias) return alias;
  if (!token) errors.push(message);
  else if (!alias) errors.push(message);
  return fallback;
}

function enumToken(value: unknown) {
  return typeof value === "string"
    ? toSimplifiedChinese(value).trim().toLowerCase().replace(/\s+/g, " ").replace(/_/g, "-")
    : "";
}

function removeUngroundedNumericValues(items: ShortVideoVisualItem[], sourceText: string) {
  const corpus = toSimplifiedChinese(sourceText);
  return items.map((item) => {
    if (!item.value || !looksLikeNumericValue(item.value) || corpus.includes(toSimplifiedChinese(item.value))) return item;
    return { ...item, value: undefined };
  });
}

function hasGroundedNumericValue(items: ShortVideoVisualItem[], sourceText: string) {
  const corpus = toSimplifiedChinese(sourceText);
  return items.some((item) => Boolean(item.value && looksLikeNumericValue(item.value) && corpus.includes(toSimplifiedChinese(item.value))));
}

function looksLikeNumericValue(value: string) {
  return /[0-9０-９]|%|％|百分比|倍|万|千|亿|秒|分钟|小时|元|个|条|次|位|岁|年|月|天/u.test(value);
}

function normalizeVisualItem(value: unknown, shotIndex: number, itemIndex: number, errors: string[]): ShortVideoVisualItem {
  const item = objectValue(value, "visual_item 必须是对象");
  const tone = textValue(item.tone);
  if (tone && !["primary", "success", "danger", "muted"].includes(tone)) {
    errors.push(`镜头 ${shotIndex} visualItem ${itemIndex + 1} tone 无效`);
  }
  return {
    label: textValue(item.label),
    value: textValue(item.value) || undefined,
    tone: (["primary", "success", "danger", "muted"] as const).includes(tone as any) ? tone as ShortVideoVisualItem["tone"] : undefined
  };
}

function layoutForShotType(type: ShotType): ShotLayout {
  if (type === "hook" || type === "cta") return "kinetic-title";
  if (type === "problem" || type === "contrast") return "comparison";
  if (type === "process") return "process-flow";
  if (type === "proof") return "metric";
  if (type === "summary") return "summary-stack";
  return "concept-map";
}

function parseCleanPayload(text: string): CleanScriptPayload {
  let raw: unknown;
  try {
    raw = parseAiJson(text);
  } catch {
    throw new Error("AI 返回的洗稿结果不是合法 JSON");
  }
  const value = objectValue(raw, "洗稿结果必须是 JSON 对象");
  const payload: CleanScriptPayload = {
    title: textValue(value.title),
    summary: textValue(value.summary),
    hook: textValue(value.hook),
    key_points: arrayValue(value.key_points, "key_points 必须是数组").map(textValue).filter(Boolean),
    clean_script: textValue(value.clean_script),
    short_video_script: textValue(value.short_video_script),
    cover_title: textValue(value.cover_title),
    tags: arrayValue(value.tags, "tags 必须是数组").map(textValue).filter(Boolean),
    quality_notes: arrayValue(value.quality_notes, "quality_notes 必须是数组").map(textValue).filter(Boolean)
  };
  if (!payload.title || !payload.hook || !payload.clean_script || !payload.cover_title) {
    throw new Error("AI 洗稿缺少必填字段");
  }
  if (payload.summary.length > 80) {
    throw new Error("summary 必须不超过 80 字");
  }
  const scriptLength = payload.short_video_script.replace(/\s+/g, "").length;
  if (scriptLength < 180 || scriptLength > 260) {
    throw new Error(`short_video_script 长度为 ${scriptLength}，必须在 180 到 260 字之间`);
  }
  if (payload.key_points.length < 3 || payload.key_points.length > 6) {
    throw new Error("key_points 必须为 3 到 6 条");
  }
  return payload;
}

function parseAiJson(text: string): unknown {
  const normalized = text.replace(/^\uFEFF/u, "").trim();
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1]?.trim();
  const candidates = [fenced, normalized].filter((candidate): candidate is string => Boolean(candidate));
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(normalized.slice(start, end + 1));

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("AI 返回的内容不是合法 JSON");
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function textValue(value: unknown) {
  return typeof value === "string" ? toSimplifiedChinese(value).replace(/\s+/g, " ").trim() : "";
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function checkedEnum<T extends string>(value: unknown, choices: Set<T>, fallback: T, message: string, errors: string[]): T {
  if (typeof value === "string" && choices.has(value as T)) return value as T;
  errors.push(message);
  return fallback;
}

function dedupeTags(tags: string[]) {
  return [...new Map(tags.map((tag) => [tag.trim().toLowerCase(), tag.trim()])).values()].filter(Boolean);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
