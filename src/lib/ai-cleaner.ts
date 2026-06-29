import OpenAI from "openai";
import { buildScriptDraft, buildTranscriptDraft } from "./script-builder.js";
import type { DouyinShareParseResult } from "./douyin.js";
import type { ScriptAsset } from "../types.js";
import type { DouyinPageInfo } from "./douyin-page.js";

export interface ScriptCleanerInput {
  parsed?: DouyinShareParseResult | null;
  transcriptText?: string | null;
  topic: string;
  draft: ScriptAsset;
  pageInfo?: DouyinPageInfo | null;
}

export interface ScriptCleaner {
  clean(input: ScriptCleanerInput): Promise<ScriptAsset>;
}

type CleanScriptPayload = {
  title: string;
  hook: string;
  key_points: string[];
  clean_script: string;
  voiceover_script: string;
  cover_title: string;
  tags: string[];
  scene_list: Array<{
    scene: number;
    duration: number;
    caption: string;
    visual: string;
  }>;
  quality_notes: string[];
};

const CLEAN_SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    hook: { type: "string" },
    key_points: {
      type: "array",
      items: { type: "string" }
    },
    clean_script: { type: "string" },
    voiceover_script: { type: "string" },
    cover_title: { type: "string" },
    tags: {
      type: "array",
      items: { type: "string" }
    },
    scene_list: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          scene: { type: "number" },
          duration: { type: "number" },
          caption: { type: "string" },
          visual: { type: "string" }
        },
        required: ["scene", "duration", "caption", "visual"]
      }
    },
    quality_notes: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: [
    "title",
    "hook",
    "key_points",
    "clean_script",
    "voiceover_script",
    "cover_title",
    "tags",
    "scene_list",
    "quality_notes"
  ]
} as const;

export class OpenAiScriptCleaner implements ScriptCleaner {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly baseURL?: string;
  private readonly thinkingMode: "enabled" | "disabled";
  private readonly provider: "deepseek" | "openai";

  constructor(
    options: {
      apiKey?: string;
      model?: string;
      baseURL?: string;
      thinkingMode?: "enabled" | "disabled";
      provider?: "deepseek" | "openai";
    } = {}
  ) {
    this.model = options.model ?? process.env.AI_MODEL ?? "deepseek-v4-pro";
    this.baseURL = options.baseURL;
    this.provider = options.provider ?? (options.baseURL ? "deepseek" : "openai");
    this.thinkingMode =
      options.thinkingMode ?? (process.env.AI_THINKING_MODE as "enabled" | "disabled") ?? "disabled";
    if (options.apiKey) {
      this.client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL
      });
    }
  }

  async clean(input: ScriptCleanerInput): Promise<ScriptAsset> {
    const draft = input.draft ?? this.buildDraft(input);
    if (!this.client) {
      return this.toAssetFromDraft(draft, "fallback");
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "你是一个中文 AI 视频文案清洗和短视频结构规划专家。你的任务是清洗语音转写或分享文案，去掉口语废词、重复表达和无效寒暄，保留所有技术细节，并改写成科技博主口播风格。输出必须严格符合给定 JSON 格式，不要输出 Markdown。"
          },
          {
            role: "user",
            content: [
              "请根据下面的信息生成一版更适合短视频口播的 JSON 成稿：",
              "",
              `主题：${input.topic}`,
              input.parsed
                ? [
                    `内容类型：${input.parsed.contentType}`,
                    `标题候选：${input.parsed.titleCandidate}`,
                    `简介：${input.parsed.introText}`,
                    `标签：${input.parsed.hashtags.join("、") || "无"}`
                  ].join("\n")
                : "内容类型：video_transcript",
              input.pageInfo
                ? [
                    "",
                    `页面标题：${input.pageInfo.pageTitle ?? "无"}`,
                    `页面描述：${input.pageInfo.pageDescription ?? "无"}`,
                    `作者：${input.pageInfo.authorName ?? "无"}`,
                    `发布时间：${input.pageInfo.publishTime ?? "无"}`,
                    `视频 ID：${input.pageInfo.videoId ?? "无"}`
                  ].join("\n")
                : "",
              "",
              "原始分享文本：",
              input.parsed?.shareText ?? "无",
              input.transcriptText
                ? [
                    "",
                    "视频转写原文：",
                    input.transcriptText
                  ].join("\n")
                : "",
              "",
              "要求：",
              "1. 视频转写原文优先级最高；没有转写时，才使用分享文案。",
              "2. 开场要有钩子，可以用问句、反常识观点或痛点切入，但不要夸张。",
              "3. 用“你”拉近距离，复杂概念要翻译成普通人能听懂的话。",
              "4. 重点是技术分享，不要扩写不存在的能力、数据、模型或产品功能。",
              "5. 口播稿要自然、短句化，适合直接配音，去掉“嗯、啊、这个、那个、就是说”等废词。",
              "6. 分镜控制在 3 到 5 段，每段给出字幕和画面建议。",
              "7. 封面标题要适合抖音短视频，tags 尽量保留原始标签，并补充少量技术相关标签。",
              "8. quality_notes 里写 2 到 4 条本次脚本的注意点。",
              "9. 你必须只输出合法 JSON。"
            ].join("\n")
          }
        ],
        max_tokens: 2048,
        response_format: {
          type: "json_object"
        },
        ...(this.baseURL
          ? {
              extra_body: {
                thinking: {
                  type: this.thinkingMode
                }
              }
            }
          : {})
      } as any);

      const payload = this.parsePayload(extractChatCompletionText(response));
      if (!payload) {
        return this.toAssetFromDraft(draft, "fallback", this.model);
      }

      return this.toAssetFromPayload(payload, draft, this.model);
    } catch {
      return this.toAssetFromDraft(draft, "fallback", this.model);
    }
  }

  private toAssetFromPayload(payload: CleanScriptPayload, draft: ScriptAsset, model: string): ScriptAsset {
    return {
      ...draft,
      title: payload.title || draft.title,
      cleanScript: payload.clean_script || draft.cleanScript,
      voiceoverScript: payload.voiceover_script || draft.voiceoverScript,
      coverTitle: payload.cover_title || draft.coverTitle,
      tags: dedupeTags([...(payload.tags ?? []), ...(draft.tags ?? [])]),
      keyPoints: payload.key_points ?? draft.keyPoints,
      qualityNotes: payload.quality_notes,
      sceneList: normalizeScenes(payload.scene_list, draft.sceneList),
      aiModel: model,
      cleaningMode: this.provider,
      cleanedAt: new Date().toISOString(),
      status: "ready"
    };
  }

  private toAssetFromDraft(draft: ScriptAsset, cleaningMode: "fallback", model?: string): ScriptAsset {
    return {
      ...draft,
      aiModel: model,
      cleaningMode,
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

  private parsePayload(text: string): CleanScriptPayload | null {
    if (!text) {
      return null;
    }

    try {
      const parsed = JSON.parse(text) as CleanScriptPayload;
      return parsed;
    } catch {
      return null;
    }
  }
}

function extractChatCompletionText(response: any) {
  return response?.choices?.[0]?.message?.content?.trim?.() ?? "";
}

function normalizeScenes(
  scenes: CleanScriptPayload["scene_list"],
  fallback: ScriptAsset["sceneList"]
) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return fallback;
  }

  return scenes.map((scene, index) => ({
    scene: Number.isFinite(scene.scene) ? scene.scene : index + 1,
    duration: Number.isFinite(scene.duration) ? scene.duration : 5,
    caption: scene.caption.trim(),
    visual: scene.visual.trim()
  }));
}

function dedupeTags(tags: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) {
      continue;
    }
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}
