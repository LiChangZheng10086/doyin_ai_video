import OpenAI from "openai";
import type {
  PlatformCopy,
  PublishCopySource,
  PublishPlatform,
  ScriptAsset,
} from "../types.js";
import type { AiRuntimeConfig as ServerAiRuntimeConfig } from "../app.js";
import { toSimplifiedChinese } from "./chinese.js";
import {
  PUBLISH_PLATFORMS,
  normalizePlatformCopy,
  validatePlatformCopy,
} from "./publishing-platforms.js";

export type AiRuntimeConfig = ServerAiRuntimeConfig;
export type CleanedScript = ScriptAsset;

export interface PublishingCopyWarning {
  code: "publish_copy_ai_fallback";
  message: string;
}

export interface PublishingCopyItem extends PlatformCopy {
  copySource: PublishCopySource;
  warning?: PublishingCopyWarning;
}

export interface PublishingCopyPreview {
  copies: Partial<Record<PublishPlatform, PublishingCopyItem>>;
  warning?: PublishingCopyWarning;
}

type PublishingCopyDependencies = {
  resolveAiConfig: () => Promise<AiRuntimeConfig | null>;
  createClient?: (config: AiRuntimeConfig) => OpenAI;
};

const FALLBACK_WARNING: PublishingCopyWarning = {
  code: "publish_copy_ai_fallback",
  message: "AI 平台文案暂不可用，已使用洗稿内容生成可编辑文案。",
};

const PRODUCTION_TERMS = /\bSHOT\b|camera\s*motion|9\s*:\s*16|动态图形/giu;
const COPY_FIELDS = ["title", "description", "hashtags"] as const;

export class PublishingCopyService {
  private readonly createClient: (config: AiRuntimeConfig) => OpenAI;

  constructor(private readonly deps: PublishingCopyDependencies) {
    this.createClient = deps.createClient ?? ((config) => new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    }));
  }

  async previewAll(
    cleaned: CleanedScript,
    platforms: PublishPlatform[],
  ): Promise<PublishingCopyPreview> {
    const requested = uniquePlatforms(platforms);
    if (requested.length === 0) return { copies: {} };

    try {
      const copies = await this.generate(cleaned, requested);
      return { copies };
    } catch {
      return this.fallbackPreview(cleaned, requested);
    }
  }

  async regenerateOne(
    cleaned: CleanedScript,
    platform: PublishPlatform,
  ): Promise<PublishingCopyItem> {
    const result = await this.previewAll(cleaned, [platform]);
    const item = result.copies[platform] ?? fallbackCopy(cleaned, platform);
    return result.warning ? { ...item, warning: result.warning } : item;
  }

  private async generate(
    cleaned: CleanedScript,
    platforms: PublishPlatform[],
  ): Promise<Partial<Record<PublishPlatform, PublishingCopyItem>>> {
    const config = await this.deps.resolveAiConfig();
    if (!isUsableConfig(config)) throw new Error("AI 配置不可用");

    const client = this.createClient(config);
    const completion = await client.chat.completions.create({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "你是中文短视频平台文案编辑。观众可见内容只使用简体中文。只输出合法 JSON，不输出解释或代码块。",
        },
        {
          role: "user",
          content: buildPrompt(cleaned, platforms),
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2400,
    } as any);
    const content = completion?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("AI 返回内容为空");
    }

    return parseGeneratedCopies(content, platforms);
  }

  private fallbackPreview(
    cleaned: CleanedScript,
    platforms: PublishPlatform[],
  ): PublishingCopyPreview {
    const copies: Partial<Record<PublishPlatform, PublishingCopyItem>> = {};
    for (const platform of platforms) copies[platform] = fallbackCopy(cleaned, platform);
    return { copies, warning: { ...FALLBACK_WARNING } };
  }
}

function buildPrompt(cleaned: CleanedScript, platforms: PublishPlatform[]): string {
  const source = {
    title: conciseText(cleaned.title, 80),
    summary: conciseText(cleaned.summary, 80),
    keyPoints: (cleaned.keyPoints ?? [])
      .slice(0, 6)
      .map((value) => conciseText(value, 80))
      .filter(Boolean),
    shortVideoScript: conciseText(cleaned.shortVideoScript || cleaned.cleanScript, 260),
    tags: (cleaned.tags ?? [])
      .slice(0, 10)
      .map((value) => conciseText(value, 20))
      .filter(Boolean),
  };
  const keys = platforms.join(",");
  const limits = platforms.map((platform) => {
    const policy = PUBLISH_PLATFORMS[platform];
    return `${platform}：标题 1-${policy.titleMax} 字，正文最多 ${policy.descriptionMax} 字，标签最多 ${policy.hashtagMax} 个且每个最多 ${policy.hashtagLengthMax} 字`;
  });

  return [
    `为这些平台生成发布文案：${keys}`,
    "只使用简体中文，保持原有事实，不添加输入中没有的数据。",
    "每个平台必须包含且仅包含 title、description、hashtags；hashtags 必须是字符串数组。",
    `返回一个 JSON 对象，仅允许顶层键：${keys}`,
    ...limits,
    `洗稿内容：${JSON.stringify(source)}`,
  ].join("\n");
}

function parseGeneratedCopies(
  content: string,
  platforms: PublishPlatform[],
): Partial<Record<PublishPlatform, PublishingCopyItem>> {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) throw new Error("AI 返回必须是 JSON 对象");
  if (!hasExactKeys(parsed, platforms)) throw new Error("AI 返回的平台键不匹配");

  const copies: Partial<Record<PublishPlatform, PublishingCopyItem>> = {};
  for (const platform of platforms) {
    const raw = parsed[platform];
    if (!isRecord(raw) || !hasExactKeys(raw, COPY_FIELDS)) {
      throw new Error("AI 返回的文案字段不匹配");
    }
    if (
      typeof raw.title !== "string"
      || typeof raw.description !== "string"
      || !Array.isArray(raw.hashtags)
      || raw.hashtags.some((value) => typeof value !== "string")
    ) {
      throw new Error("AI 返回的文案类型无效");
    }

    const normalized = normalizePlatformCopy({
      title: toSimplifiedChinese(raw.title),
      description: toSimplifiedChinese(raw.description),
      hashtags: raw.hashtags.map((value) => toSimplifiedChinese(value as string)),
    });
    if (validatePlatformCopy(platform, normalized).length > 0) {
      throw new Error("AI 返回的文案未通过平台校验");
    }
    copies[platform] = { ...normalized, copySource: "ai" };
  }
  return copies;
}

function fallbackCopy(cleaned: CleanedScript, platform: PublishPlatform): PublishingCopyItem {
  const policy = PUBLISH_PLATFORMS[platform];
  const title = conciseText(cleaned.title, policy.titleMax) || "待发布视频";
  const description = conciseText(cleaned.summary, policy.descriptionMax);
  const hashtags = normalizePlatformCopy({
    title,
    description,
    hashtags: (cleaned.tags ?? []).map((tag) => conciseText(tag, policy.hashtagLengthMax)),
  }).hashtags.slice(0, policy.hashtagMax);

  return {
    title,
    description,
    hashtags,
    copySource: "cleaned_fallback",
  };
}

function conciseText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const safe = toSimplifiedChinese(value)
    .replace(PRODUCTION_TERMS, "")
    .replace(/\s+/gu, " ")
    .trim();
  return [...safe].slice(0, limit).join("");
}

function uniquePlatforms(platforms: PublishPlatform[]): PublishPlatform[] {
  const supported = new Set(Object.keys(PUBLISH_PLATFORMS) as PublishPlatform[]);
  return [...new Set(platforms)].filter((platform) => supported.has(platform));
}

function isUsableConfig(config: AiRuntimeConfig | null): config is AiRuntimeConfig {
  return Boolean(
    config
    && typeof config.apiKey === "string"
    && config.apiKey.trim()
    && typeof config.model === "string"
    && config.model.trim()
    && ["deepseek", "openai", "custom"].includes(config.provider),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expectedKeys[index]);
}
