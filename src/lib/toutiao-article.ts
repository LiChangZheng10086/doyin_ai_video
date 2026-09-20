/**
 * 今日头条文章：档案（限额/提示词/文案）、成文与渲染。
 *
 * 与公众号共用 `article-draft.ts` 的骨架，这里只写**本平台**的差异，以及本平台独有的约束：
 *
 * - 标题 **2~30 字**（下限是本平台独有，参考项目实测 `TITLE_MIN_LEN = 2` / `TITLE_MAX_LEN = 30`）；
 * - **没有摘要与作者字段** → 不校验、也不让它们进提示词；
 * - 正文由**结构化草稿**渲染，**不接收任意 HTML**，所以不做 wechat 那套标签白名单，
 *   而是**把全部文本转义**（比事后清洗更强：正文里的 `<script>` 只能当文本显示）；
 * - **封面必填**（平台要求），封面尺寸与限额在本模块给出唯一真源。
 */

import {
  buildFallbackPlan,
  codePointLength,
  commonArticleRules,
  planArticle,
  validateArticleDraftAgainstProfile,
  type ArticleAiConfig,
  type ArticleChatClient,
  type ArticleDraft,
  type ArticleFallbackWarning,
  type ArticlePlan,
  type ArticlePlanDeps,
  type ArticleProfile,
  type ArticleSourceContext,
  type ArticleValidationError,
} from "./article-draft.js";

/**
 * 平台硬限额 + 我们自己的守卫。**唯一真源** —— 服务端、预览接口、渲染层都从这里取。
 *
 * `bodyChars` 是**我们自己的**守卫（平台未公布文章字数上限）：防止一次把异常长的内容粘进编辑器。
 */
export const TOUTIAO_ARTICLE_LIMITS = {
  /** 平台硬限制：标题至少 2 字（参考实现 `TITLE_MIN_LEN`）。 */
  titleMin: 2,
  /** 平台硬限制：标题最多 30 字（超出由平台截断，我们主动压缩并在界面标注）。 */
  titleMax: 30,
  /** 我们自己的正文长度守卫（字符数）。 */
  bodyChars: 20_000,
  /** 封面：16:9、JPEG（平台建议不小于 400×200）。 */
  coverWidth: 1280,
  coverHeight: 720,
  /** 封面文件大小上限（与 wechat 封面同口径）。 */
  coverBytes: 10 * 1024 * 1024,
} as const;

export type ToutiaoArticleErrorCode = "toutiao_article_too_long";

export class ToutiaoArticleError extends Error {
  readonly status = 422;

  constructor(
    readonly code: ToutiaoArticleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToutiaoArticleError";
  }
}

export type ToutiaoArticleDraft = ArticleDraft;
export type ToutiaoArticlePlan = ArticlePlan;
export type ToutiaoArticleValidationError = ArticleValidationError;

/**
 * AI 成文失败时的提示。**绝不静默**：产出一份看起来正常、其实是原始口播稿的东西，
 * 比明确报错更糟（本项目在抖音通路上吃过「失败原因被吞掉」的亏）。
 */
export const TOUTIAO_ARTICLE_FALLBACK_WARNING: ArticleFallbackWarning = {
  code: "toutiao_article_ai_fallback",
  message: "AI 成文暂不可用，已按洗稿要点生成可编辑的兜底结构；请检查标题与正文后再提交，也可以重试。",
};

const EMPTY_SOURCE_NOTE =
  "（这一篇还没有可用的正文素材：请先在作品详情页完成「AI 洗稿」，或在这里手动补写正文。）";

/** 头条口径档案：限额数字**只**来自 `TOUTIAO_ARTICLE_LIMITS`。 */
const TOUTIAO_ARTICLE_PROFILE: ArticleProfile = {
  label: "今日头条",
  limits: {
    titleMin: TOUTIAO_ARTICLE_LIMITS.titleMin,
    titleMax: TOUTIAO_ARTICLE_LIMITS.titleMax,
    bodyChars: TOUTIAO_ARTICLE_LIMITS.bodyChars,
  },
  fieldLabels: { title: "今日头条文章标题", digest: "文章摘要", author: "文章作者" },
  jsonKeys: ["title", "sections", "tags"],
  promptRules: (limits) => [
    "你是中文头条号文章编辑：把短视频的转录与洗稿结果改写成一篇可以直接发出去的今日头条文章。",
    `标题必须不少于 ${limits.titleMin} 字、不超过 ${limits.titleMax} 字，要具体、有信息量，不要用夸张的标题党写法。`,
    `正文总长度必须少于 ${limits.bodyChars} 字符（含标点），建议 800–2000 字，用二级标题分段。`,
    ...commonArticleRules(["title", "sections", "tags"]),
  ],
  userPromptPrefix: "参考数据（来自一条短视频的转录与 AI 洗稿结果）：",
  requestLine: "请据此写一篇今日头条文章。",
  emptySourceNote: EMPTY_SOURCE_NOTE,
  emptyTitleFallback: "未命名文章",
  fallbackWarning: TOUTIAO_ARTICLE_FALLBACK_WARNING,
};

export type ToutiaoArticleSourceContext = ArticleSourceContext;
export type ToutiaoArticleAiConfig = ArticleAiConfig;
export type ToutiaoArticleChatClient = ArticleChatClient;
export type ToutiaoArticlePlanDeps = ArticlePlanDeps;

const ROOT_STYLE =
  "margin:0 auto;max-width:100%;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#222222;line-height:1.9;";
const SECTION_STYLE = "margin:0;padding:0;";
const H2_STYLE = "font-size:19px;font-weight:600;margin:26px 0 12px;line-height:1.5;color:#111111;";
const P_STYLE = "margin:0 0 16px;font-size:16px;line-height:1.9;color:#333333;";

/**
 * 把任务产物写成一篇头条文章（失败一律走兜底而不抛出）。
 *
 * 与公众号共用 `planArticle`，差异只在上面的档案。
 */
export async function planToutiaoArticle(
  context: ToutiaoArticleSourceContext,
  deps: ToutiaoArticlePlanDeps,
): Promise<ToutiaoArticlePlan> {
  return planArticle(context, deps, TOUTIAO_ARTICLE_PROFILE);
}

/**
 * 本地兜底（无 AI 配置或 AI 不可用时）：与 `planToutiaoArticle` 内部失败时**同一条代码路径**，
 * 所以「兜底必能通过校验并渲染」这条不变式只有一份实现。
 */
export function fallbackToutiaoArticle(context: ToutiaoArticleSourceContext): ToutiaoArticlePlan {
  return buildFallbackPlan(context, TOUTIAO_ARTICLE_PROFILE);
}

export function validateToutiaoArticle(draft: ToutiaoArticleDraft): ToutiaoArticleValidationError[] {
  return validateArticleDraftAgainstProfile(draft, TOUTIAO_ARTICLE_PROFILE);
}

/** HTML 文本转义：正文与标题里的任何标记都只能当文本显示。 */
function escapeHtml(value: string): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 渲染成可粘进头条编辑器的富文本 HTML。
 *
 * 输入是**结构化草稿**（小标题 + 纯文本段落），所以这里没有清洗步骤 ——
 * 只要保证「所有文本都被转义」，就不可能把外部标记带进编辑器。
 *
 * 正文长度在渲染后断言（正文真实长度只有渲染完才知道），超限时指出**从第几段开始超限**：
 * 只说「太长了」用户不知道删哪里。
 */
export function renderToutiaoArticleHtml(draft: ToutiaoArticleDraft): string {
  const parts: string[] = [];
  let length = 0;
  let index = 0;

  for (const section of draft.sections ?? []) {
    index += 1;
    const blocks: string[] = [];
    const heading = (section.heading ?? "").trim();
    if (heading.length > 0) blocks.push(`<h2 style="${H2_STYLE}">${escapeHtml(heading)}</h2>`);
    for (const paragraph of section.paragraphs ?? []) {
      const text = (paragraph ?? "").trim();
      if (text.length > 0) blocks.push(`<p style="${P_STYLE}">${escapeHtml(text)}</p>`);
    }

    // 计的是**文本**长度：提示词、预览下发的 articleLimits、渲染层的即时校验说的都是
    // 「正文 N 字符」，而渲染出的 HTML 每段还带 70+ 字符的内联样式 —— 按 HTML 计会把
    // 一份合法文章判成超限（实测：100 段 × 180 字 → 正文 18000 字却计成 25875）。
    const chunk = blocks.join("\n");
    length += codePointLength(heading);
    for (const paragraph of section.paragraphs ?? []) {
      length += codePointLength((paragraph ?? "").trim());
    }
    if (length > TOUTIAO_ARTICLE_LIMITS.bodyChars) {
      throw new ToutiaoArticleError(
        "toutiao_article_too_long",
        `文章正文有 ${length} 字符，超过 ${TOUTIAO_ARTICLE_LIMITS.bodyChars} 字符上限：从第 ${index} 段开始超限，请精简这一节的内容后重试。`,
      );
    }
    if (chunk.length > 0) parts.push(chunk);
  }

  return `<section style="${ROOT_STYLE}">${parts.join("\n")}</section>`;
}

/**
 * 小标题在正文纯文本里的行首标记。
 *
 * 正文在「服务端结构化草稿 ↔ 用户编辑的纯文本」之间来回走一趟，必须**无损**：
 * 否则用户一编辑，AI 写的小标题就退化成普通段落（再渲染就没有 `<h2>` 了）。
 * 所以约定一个显式标记，而不是靠「短行就是标题」这类猜测。
 */
export const TOUTIAO_HEADING_MARKER = "## ";

/**
 * 正文纯文本（预览弹窗、创建请求体与「纯文本粘贴」兜底通路共用）。
 *
 * 小标题带 `## ` 前缀 → 可用 `articleBodyToDraft` 无损还原。
 */
export function articleDraftToBodyText(draft: ToutiaoArticleDraft): string {
  const lines: string[] = [];
  for (const section of draft.sections ?? []) {
    const heading = (section.heading ?? "").trim();
    if (heading.length > 0) lines.push(`${TOUTIAO_HEADING_MARKER}${heading}`);
    for (const paragraph of section.paragraphs ?? []) {
      const text = (paragraph ?? "").trim();
      if (text.length > 0) lines.push(text);
    }
  }
  return lines.length > 0 ? lines.join("\n\n") : EMPTY_SOURCE_NOTE;
}

/**
 * 把用户编辑过的正文纯文本还原成结构化草稿（`## ` 开头的行为小标题，其余为段落）。
 *
 * 空行分段；连续多个空行与首尾空白都归一掉 —— 用户在 textarea 里多敲一个回车不该改变结构。
 * 约定：**只有出现新的小标题才会开新节**，因此「没有小标题的相邻两节」会被合并成一节 ——
 * 这不会改变渲染结果（那小标题本来就不存在），往返仍然保持「渲染出的 HTML 一致」。
 */
export function articleBodyToDraft(
  title: string,
  body: string,
  overrides: { digest?: string; author?: string; tags?: string[] } = {},
): ToutiaoArticleDraft {
  const sections: ToutiaoArticleDraft["sections"] = [];
  let current: { heading?: string; paragraphs: string[] } | undefined;

  for (const rawLine of (body ?? "").split(/\n{2,}/u)) {
    for (const rawPiece of rawLine.split("\n")) {
      const line = rawPiece.trim();
      if (line.length === 0) continue;
      if (line.startsWith(TOUTIAO_HEADING_MARKER)) {
        const heading = line.slice(TOUTIAO_HEADING_MARKER.length).trim();
        if (current && current.paragraphs.length > 0) sections.push(current);
        current = heading.length > 0 ? { heading, paragraphs: [] } : { paragraphs: [] };
        continue;
      }
      if (!current) current = { paragraphs: [] };
      current.paragraphs.push(line);
    }
  }
  if (current && (current.paragraphs.length > 0 || current.heading)) sections.push(current);

  const draft: ToutiaoArticleDraft = { title: (title ?? "").trim(), sections };
  const digest = (overrides.digest ?? "").trim();
  if (digest.length > 0) draft.digest = digest;
  const author = (overrides.author ?? "").trim();
  if (author.length > 0) draft.author = author;
  if (overrides.tags && overrides.tags.length > 0) draft.tags = [...overrides.tags];
  return draft;
}

/**
 * 「纯文本粘贴」兜底通路用的正文：**不带** `## ` 标记（粘到编辑器里的应该是正文，不是记号）。
 */
export function articleDraftToPlainParagraphs(draft: ToutiaoArticleDraft): string[] {
  const lines: string[] = [];
  for (const section of draft.sections ?? []) {
    const heading = (section.heading ?? "").trim();
    if (heading.length > 0) lines.push(heading);
    for (const paragraph of section.paragraphs ?? []) {
      const text = (paragraph ?? "").trim();
      if (text.length > 0) lines.push(text);
    }
  }
  return lines.length > 0 ? lines : [EMPTY_SOURCE_NOTE];
}

/** 从渲染结果里取回纯文本（包级预览要摊给操作者看「将要发出去的是什么」）。 */
export function htmlToPlainText(html: string): string {
  return (html ?? "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|h[1-6]|section|div|li|blockquote)>/giu, "\n\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&")
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * 从**包内 `article.html`** 还原出正文文本（带 `## ` 小标题标记）。
 *
 * 与 `htmlToPlainText` 的分工要说清楚，两者的用途**不能互换**：
 * - `htmlToPlainText`：给「粘进编辑器的东西」与编辑器读回校验用 —— 编辑器里小标题是**真标题**，
 *   没有 `## ` 这个记号，多带一个记号会直接对不上。
 * - 本函数：给**界面展示**用。包记录（`ArticleCopy`）只存 `title` + `htmlSha256`，**没有正文文本**，
 *   所以预览只能从 HTML 还原；而创建向导展示的是 `articleDraftToBodyText` 的产物（带 `## `），
 *   两边不一致的话操作者会以为「小标题在预览里丢了」。有用例断言
 *   `articleHtmlToBodyText(render(draft)) === articleDraftToBodyText(draft)`（逐字相同）。
 */
export function articleHtmlToBodyText(html: string): string {
  const text = (html ?? "")
    // 先把标题整段抽出来加上记号，再统一去标签 —— 顺序反了就再也分不清标题和段落。
    .replace(
      /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/giu,
      (_match, inner: string) => `\n\n${TOUTIAO_HEADING_MARKER}${stripTags(inner).trim()}\n\n`,
    )
    // **块级闭合标签必须换成空行**：直接去标签会把相邻段落粘成一坨（`<p>A</p><p>B</p>` → `AB`）。
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|h[1-6]|section|div|li|blockquote)>/giu, "\n\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&");

  const lines = text
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return lines.length > 0 ? lines.join("\n\n") : EMPTY_SOURCE_NOTE;
}

/** 去掉标签、保留文本（只在已经确定不含用户 HTML 的片段上用）。 */
function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&");
}
