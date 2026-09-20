/**
 * 文章内核（平台中立）：取材上下文、结构化草稿、AI 成文与兜底、字数校验与压缩。
 *
 * 为什么要抽这一层：公众号特性（Task 3）已经写好了一份完整的「AI 成文 + 兜底」，但它把
 * **限额与提示词**硬编码成了公众号口径。头条号要用同一套链路、不同的口径，
 * 若复制一份必然慢慢漂移（两份 prompt、两套兜底、两种压缩行为），所以把中立的骨架抽到这里，
 * 平台差异收敛成 `ArticleProfile`：
 *
 * - `limits`：标题上下限、摘要/作者上限、正文守卫；
 * - `promptRules()`：提示词规则行（**限额数字必须由 `limits` 生成**，不许在提示词里另写一份）；
 * - `fieldLabels` / `emptySourceNote` / `fallbackWarning`：错误与兜底文案。
 *
 * **不变量（公众号与头条共用，都有用例守住）**：无论 AI 返回什么（合法 / 超限 / 缺字段 / 空段落 /
 * 坏 JSON / 抛异常 / 无配置 / `null` / 数字），产出的草稿**必定能通过
 * `validateArticleDraftAgainstProfile` 并被渲染**，且失败一定带 `copySource: "fallback"` + 可读
 * `warning` —— 绝不静默产出一份看起来正常、其实是原始口播稿的东西。
 */

import OpenAI from "openai";
import { extractAiMessageText } from "./ai-response.js";
import { toSimplifiedChinese } from "./chinese.js";

export interface ArticleSection {
  heading?: string;
  paragraphs: string[];
}

export interface ArticleDraft {
  title: string;
  /** 摘要；可缺省（各平台语义不同：公众号缺省时官方抓正文前 54 字，头条没有摘要字段）。 */
  digest?: string;
  author?: string;
  sections: ArticleSection[];
  tags?: string[];
}

export interface ArticleLimits {
  /** 标题下限（头条是 2 字；公众号只要求非空）。 */
  titleMin: number;
  titleMax: number;
  /** 正文长度守卫（字符数）。正文真实长度由渲染决定，这条用于提示词预算与上层守卫。 */
  bodyChars: number;
  digestMax?: number;
  authorMax?: number;
}

export interface ArticleFallbackWarning {
  code: string;
  message: string;
}

export interface ArticleProfile {
  /** 平台名，出现在错误文案与提示词里。 */
  label: string;
  limits: ArticleLimits;
  /** 各字段在错误文案里的名字，如「微信公众号文章标题」。 */
  fieldLabels: { title: string; digest: string; author: string };
  /** 提示词规则行；第一条应为角色行。限额数字**由传进来的 limits 生成**。 */
  promptRules: (limits: ArticleLimits) => string[];
  /** 用户消息里的数据来源说明（末尾接参考数据的 JSON）。 */
  userPromptPrefix: string;
  /** 用户消息结尾的祈使句，如「请据此写一篇公众号文章。」 */
  requestLine: string;
  /** JSON 顶层允许的键，与 `promptRules` 里的同一份约定。 */
  jsonKeys: string[];
  /** 兜底时「一条素材都没有」的说明（绝不产出空文章）。 */
  emptySourceNote: string;
  /** 兜底标题（任务标题与要点都拿不到时使用）。 */
  emptyTitleFallback: string;
  fallbackWarning: ArticleFallbackWarning;
}

export interface ArticleSourceContext {
  title: string;
  summary?: string;
  keyPoints?: string[];
  cleanScript?: string;
  voiceoverScript?: string;
  videoOutline?: Array<{ title?: string; bullets?: string[] }>;
  qualityNotes?: string[];
  tags?: string[];
}

export interface ArticleAiConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
}

/**
 * 只要形状够用即可：真实的 `OpenAI` 客户端与测试的假客户端都能满足它。
 * 参数用 `any` 是有意的 —— 真实 SDK 的 `create` 是重载签名，收紧类型只会逼出无意义的断言。
 */
export interface ArticleChatClient {
  chat: { completions: { create: (args: any) => Promise<any> } };
}

export interface ArticlePlanDeps {
  resolveAiConfig: () => Promise<ArticleAiConfig | null>;
  createClient?: (config: ArticleAiConfig) => ArticleChatClient;
}

export interface ArticlePlan {
  draft: ArticleDraft;
  /** `ai` = 用了模型产出；`fallback` = 用了本地兜底结构。 */
  copySource: "ai" | "fallback";
  warning?: ArticleFallbackWarning;
}

export type ArticleValidationField = "title" | "digest" | "author";

export interface ArticleValidationError {
  field: ArticleValidationField;
  actual: number;
  limit: number;
  message: string;
}

export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * 压到上限：超出时保留前 `limit - 1` 个码点再补一个省略号。
 *
 * 让用户**看得出被截断过**（界面同时会标「已压缩，可编辑」），而不是拿到一句莫名其妙的半截话。
 * 按码点计数，所以 emoji 不会被算成两个字符。
 */
export function compressToLimit(value: string, limit: number): string {
  const text = (value ?? "").trim();
  const chars = [...text];
  if (chars.length <= limit) return text;
  return `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/**
 * 各平台共用的写作纪律（语言/事实性/JSON 形状）。
 *
 * 抽出来是为了让公众号与头条的提示词**只在角色行与体裁要求上不同**，
 * 而不是各写一份「不要编造数据」这类底线要求（迟早会漂移）。
 */
export function commonArticleRules(jsonKeys: string[]): string[] {
  return [
    "只使用简体中文；只使用参考数据里的事实，不编造数据，不添加参考数据中没有的结论。",
    `返回一个 JSON 对象，顶层键只允许 ${jsonKeys.join("、")}。`,
    'sections 是数组，每项形如 {"heading":"可选的小标题","paragraphs":["段落一","段落二"]}；段落只写纯文本，不要写 HTML 标签。',
  ];
}

/**
 * 校验标题/摘要/作者的字数。
 *
 * **正文长度不在这里**：正文是由渲染产生的（含我们注入的样式），只有渲染完才知道真实长度，
 * 因此那条断言在各自的渲染函数里（见 `wechat-article.ts` / `toutiao-article.ts`）。
 */
export function validateArticleDraftAgainstProfile(
  draft: ArticleDraft,
  profile: ArticleProfile,
): ArticleValidationError[] {
  const errors: ArticleValidationError[] = [];
  const { limits, fieldLabels } = profile;

  const titleLength = codePointLength((draft.title ?? "").trim());
  if (titleLength === 0) {
    errors.push({ field: "title", actual: 0, limit: 1, message: `${fieldLabels.title}不能为空` });
  } else if (titleLength < limits.titleMin) {
    errors.push({
      field: "title",
      actual: titleLength,
      limit: limits.titleMin,
      message: `${fieldLabels.title}至少 ${limits.titleMin} 字，当前 ${titleLength} 字`,
    });
  } else if (titleLength > limits.titleMax) {
    errors.push({
      field: "title",
      actual: titleLength,
      limit: limits.titleMax,
      message: `${fieldLabels.title}当前 ${titleLength} 字，最多 ${limits.titleMax} 字`,
    });
  }

  if (limits.digestMax !== undefined) {
    const digestLength = codePointLength((draft.digest ?? "").trim());
    if (digestLength > limits.digestMax) {
      errors.push({
        field: "digest",
        actual: digestLength,
        limit: limits.digestMax,
        message: `${fieldLabels.digest}当前 ${digestLength} 字，最多 ${limits.digestMax} 字`,
      });
    }
  }

  if (limits.authorMax !== undefined) {
    const authorLength = codePointLength((draft.author ?? "").trim());
    if (authorLength > limits.authorMax) {
      errors.push({
        field: "author",
        actual: authorLength,
        limit: limits.authorMax,
        message: `${fieldLabels.author}当前 ${authorLength} 字，最多 ${limits.authorMax} 字`,
      });
    }
  }

  return errors;
}

/**
 * 把任务产物写成一篇平台文章。
 *
 * **失败一律走兜底而不抛出**（与 `PublishingCopyService.previewAll` 同一口径）：
 * 调用方总能拿到一份能提交的草稿，且拿得到 `warning` 与 `copySource` 去提示用户。
 */
export async function planArticle(
  context: ArticleSourceContext,
  deps: ArticlePlanDeps,
  profile: ArticleProfile,
): Promise<ArticlePlan> {
  try {
    const config = await deps.resolveAiConfig();
    if (!isUsableAiConfig(config)) throw new Error("AI 配置不可用");
    const client = (deps.createClient ?? defaultCreateClient)(config);
    const completion = await client.chat.completions.create({
      model: config.model,
      messages: buildArticleMessages(context, profile),
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: 5200,
    });
    const content = extractAiMessageText(completion?.choices?.[0]?.message);
    if (!content) throw new Error("AI 返回内容为空");
    return { draft: normalizeAiDraft(content, profile), copySource: "ai" };
  } catch {
    return buildFallbackPlan(context, profile);
  }
}

export function buildArticleMessages(
  context: ArticleSourceContext,
  profile: ArticleProfile,
): Array<{ role: "system" | "user"; content: string }> {
  const source: Record<string, unknown> = { title: context.title };
  for (const [key, value] of Object.entries({
    summary: context.summary,
    keyPoints: context.keyPoints,
    cleanScript: context.cleanScript,
    voiceoverScript: context.voiceoverScript,
    videoOutline: context.videoOutline,
    qualityNotes: context.qualityNotes,
    tags: context.tags,
  })) {
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) source[key] = value;
  }

  return [
    {
      role: "system",
      content: ["只输出合法 JSON，不输出解释或代码块。", ...profile.promptRules(profile.limits)].join("\n"),
    },
    {
      role: "user",
      content: `${profile.userPromptPrefix}\n${JSON.stringify(source, null, 2)}\n\n${profile.requestLine}`,
    },
  ];
}

function defaultCreateClient(config: ArticleAiConfig): ArticleChatClient {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }) as unknown as ArticleChatClient;
}

function isUsableAiConfig(config: ArticleAiConfig | null): config is ArticleAiConfig {
  return Boolean(config && typeof config.apiKey === "string" && config.apiKey.length > 0 && config.model);
}

function normalizeAiDraft(content: string, profile: ArticleProfile): ArticleDraft {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) throw new Error("AI 返回的不是 JSON 对象");

  const { limits } = profile;
  const title = readString(parsed.title);
  const sections = normalizeSections(parsed.sections);
  // 标题与正文是各平台接口的必填项：缺任何一个都当作「这次 AI 产出不可用」，交给兜底。
  if (title.length === 0 || sections.length === 0) throw new Error("AI 返回的文章结构不完整");

  const draft: ArticleDraft = {
    title: toSimplifiedChinese(compressToLimit(title, limits.titleMax)),
    sections,
  };

  const digest = readString(parsed.digest);
  if (digest.length > 0 && limits.digestMax !== undefined) {
    draft.digest = toSimplifiedChinese(compressToLimit(digest, limits.digestMax));
  }
  const author = readString(parsed.author);
  if (author.length > 0 && limits.authorMax !== undefined) {
    draft.author = toSimplifiedChinese(compressToLimit(author, limits.authorMax));
  }
  const tags = readStringArray(parsed.tags);
  if (tags.length > 0) draft.tags = tags.map((tag) => toSimplifiedChinese(tag));

  return draft;
}

/** 归一 AI 给的 sections：丢掉空段落，丢掉一整节都没内容的 section。 */
function normalizeSections(value: unknown): ArticleSection[] {
  if (!Array.isArray(value)) return [];
  const sections: ArticleSection[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const paragraphs = Array.isArray(item.paragraphs)
      ? item.paragraphs
          .filter((paragraph): paragraph is string => typeof paragraph === "string")
          .map((paragraph) => toSimplifiedChinese(paragraph).trim())
          .filter((paragraph) => paragraph.length > 0)
      : [];
    const heading = readString(item.heading);
    if (paragraphs.length === 0) continue;
    sections.push(heading.length > 0 ? { heading: toSimplifiedChinese(heading), paragraphs } : { paragraphs });
  }
  return sections;
}

/**
 * 本地兜底：**不调用 AI**，用任务已有的洗稿要点拼出一篇结构完整的文章。
 *
 * 标题优先取任务标题，其次第一个要点；正文优先用 `keyPoints` 逐条成段，
 * 没有要点时退回 `cleanScript`/`summary` 按句切分。**一条素材都没有时给一句可执行的占位说明**，
 * 而不是产出一篇空文章让用户以为成功了。
 *
 * 标题还会被兜到 `limits.titleMin` 之上（头条要求至少 2 字）：否则兜底结果自己过不了校验，
 * 「兜底必能提交」这条不变式就断了。
 */
export function buildFallbackPlan(context: ArticleSourceContext, profile: ArticleProfile): ArticlePlan {
  const { limits } = profile;
  const keyPoints = readStringArray(context.keyPoints).map((point) => toSimplifiedChinese(point));
  const outline = (context.videoOutline ?? [])
    .map((item) => readString(item?.title))
    .filter((title) => title.length > 0);

  let title = compressToLimit(
    firstNonBlank(context.title) ?? keyPoints[0] ?? outline[0] ?? profile.emptyTitleFallback,
    limits.titleMax,
  );
  if (codePointLength(title) < limits.titleMin) title = profile.emptyTitleFallback;

  let paragraphs = keyPoints;
  if (paragraphs.length === 0) {
    paragraphs = splitIntoParagraphs(context.cleanScript ?? context.summary ?? "");
  }
  if (paragraphs.length === 0 && outline.length > 0) {
    paragraphs = outline;
  }
  if (paragraphs.length === 0) {
    paragraphs = [profile.emptySourceNote];
  }

  const digest = firstNonBlank(context.summary);
  return {
    draft: {
      title: toSimplifiedChinese(title),
      ...(digest && limits.digestMax !== undefined
        ? { digest: toSimplifiedChinese(compressToLimit(digest, limits.digestMax)) }
        : {}),
      sections: [{ paragraphs }],
    },
    copySource: "fallback",
    warning: { ...profile.fallbackWarning },
  };
}

function splitIntoParagraphs(text: string): string[] {
  return (text ?? "")
    .split(/\n{2,}|(?<=[。！？!?])/u)
    .map((part) => toSimplifiedChinese(part).trim())
    .filter((part) => part.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
