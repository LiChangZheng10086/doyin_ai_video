/**
 * 微信公众号文章：结构校验 + 微信兼容 HTML 渲染。
 *
 * **纯函数模块**（零 IO、零网络、无时间戳、无随机），因此可以断言「同一输入两次渲染逐字节相同」。
 * AI 成文见 `wechat-article` 的后续任务；本模块只负责「把结构化草稿变成能塞进 `draft/add` 的 content」。
 *
 * ## 为什么要自己清洗 HTML
 *
 * 公众号 `content` 的官方约束（已逐条核对文档，见 spec §1.3/§4）：
 *
 * - **只认内联样式**：`<style>` 块、`class`、`id` 会失效 → 我们的排版必须全部写成 `style="…"`；
 * - **外链图片会被过滤**：原文是「涉及图片 url 必须来源『上传图文消息内的图片获取 URL』接口获取。
 *   外部图片 url 将被过滤。」→ 所以**渲染完必须先自己拦掉非微信托管的图**：等微信去过滤，
 *   用户看到的只是一篇满是裂图的草稿，而且接口不会报错；
 * - `content` **必须少于 2 万字符** → 渲染后自己断言并**指出是第几段超的**，否则用户拿到一句
 *   「内容过长」而不知道从哪删；
 * - `title ≤32` / `author ≤16` / `digest ≤120`（不填则微信自动抓正文前 54 字）。
 *
 * ## 清洗顺序（顺序会影响结果，不要随便调）
 *
 * ```
 * 去注释与禁用块 → 归一锚点/图片的合法来源 → 去属性 → 归一标题层级 → 改写列表 → 解开白名单外标签 → 注入内联样式
 * ```
 *
 * 关键点：**去属性必须发生在「注入内联样式」之前**，否则 AI 塞进来的 `style="color:red"` 会与我们的
 * 排版打架；而**列表改写必须发生在去属性之后**，因为它要给自己产出的 `<p>` 带上我们自己的样式
 * （`ensureStyle` 只给「还没有 style 的标签」补样式，所以先注入的不会被覆盖）。
 */

import OpenAI from "openai";
import { extractAiMessageText } from "./ai-response.js";
import { toSimplifiedChinese } from "./chinese.js";
import {
  codePointLength,
  commonArticleRules,
  compressToLimit,
  planArticle,
  validateArticleDraftAgainstProfile,
  type ArticleAiConfig,
  type ArticleChatClient,
  type ArticleDraft,
  type ArticleFallbackWarning,
  type ArticlePlan,
  type ArticlePlanDeps,
  type ArticleProfile,
  type ArticleSection,
  type ArticleSourceContext,
  type ArticleValidationError,
  type ArticleValidationField,
} from "./article-draft.js";

/** 平台中立的骨架在 `article-draft.ts`（草稿、限额、AI 成文、兜底共用一份实现）；这里只保留「公众号口径」。 */
export { compressToLimit };

/** 官方硬限额。**唯一真源** —— 服务端、预览接口、渲染层都从这里取，避免多处漂移。 */
export const WECHAT_ARTICLE_LIMITS = {
  /** `draft/add` 的 `title`：总长度不超过 32 个字。 */
  title: 32,
  /** `draft/add` 的 `author`：总长度不超过 16 个字。 */
  author: 16,
  /** `draft/add` 的 `digest`：总长度不超过 120 个字（不填则微信抓正文前 54 字）。 */
  digest: 120,
  /** `draft/add` 的 `content`：必须少于 2 万字符、小于 1M。 */
  contentChars: 20_000,
  /** `material/add_material` 图片上限 10MB。 */
  coverBytes: 10 * 1024 * 1024,
  /** `media/uploadimg` 正文图：仅 jpg/png 且必须 <1MB。 */
  contentImageBytes: 1024 * 1024,
} as const;

const ROOT_STYLE =
  "margin:0 auto;max-width:100%;padding:22px 18px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#222222;background:#ffffff;line-height:1.9;";
const SECTION_STYLE = "margin:0;padding:0;";
const H2_STYLE =
  "font-size:19px;font-weight:600;margin:28px 0 14px;line-height:1.5;color:#111111;letter-spacing:0.3px;";
const P_STYLE = "margin:0 0 18px;font-size:16px;line-height:1.9;color:#333333;letter-spacing:0.3px;";
const LIST_WRAPPER_STYLE = "margin:14px 0;padding:0;";
const LIST_ITEM_STYLE =
  "margin:8px 0;padding-left:12px;border-left:2px solid #111111;font-size:15px;line-height:1.85;color:#333333;";
const QUOTE_STYLE =
  "margin:18px 0;padding:12px 14px;border-left:3px solid #d0d0d0;background:#f7f7f7;color:#555555;font-size:15px;line-height:1.85;";
const IMG_STYLE = "max-width:100%;display:block;margin:22px auto;border-radius:4px;height:auto;";
const CAPTION_STYLE = "text-align:center;font-size:13px;color:#888888;margin:-8px 0 22px;";
const HR_STYLE = "border:none;border-top:1px solid #eeeeee;margin:26px 0;";

/** 与输入无关的内部标记：先给列表项打标，注入样式时据此区分「列表项」与「普通段落」。 */
const LIST_ITEM_MARKER = "data-wx-kind";
const LIST_ITEM_MARKER_VALUE = "list-item";

const FORBIDDEN_BLOCKS = [
  "style",
  "script",
  "svg",
  "iframe",
  "form",
  "object",
  "embed",
  "noscript",
  "canvas",
  "video",
  "audio",
];
/** 这些是「没有闭合标签」的标签，按单标签处理。 */
const VOID_TAGS = new Set(["link", "meta", "br", "hr", "img", "input", "source"]);

const INLINE_KEEP = new Set(["strong", "em", "br", "a", "img"]);
const BLOCK_KEEP = new Set([...INLINE_KEEP, "p", "section", "h2", "blockquote", "hr"]);
/** 标题层级归一的目标：公众号正文统一用 h2 当小标题。 */
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export type WechatArticleErrorCode =
  | "wechat_article_too_long"
  | "wechat_article_image_slot_missing"
  | "wechat_article_image_unsafe";

export class WechatArticleError extends Error {
  readonly status = 422;

  constructor(
    readonly code: WechatArticleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WechatArticleError";
  }
}

/**
 * 类型保留原名（别名指向中立内核），所以既有导入与用例无需改动。
 *
 * `digest` 缺省合法（微信会抓正文前 54 字），**不伪造**。
 */
export type WechatArticleSection = ArticleSection;
export type WechatArticleDraft = ArticleDraft;

/**
 * 配图。
 *
 * 两种形态是有必要的：微信正文图**只能是 `uploadimg` 返回的 mmbiz URL**，而那个 URL
 * **只有提交时才拿得到**。所以：
 *
 * - `{ slot: n }`：**打包阶段**用，渲染成占位符 `src="{{wechat-image-n}}"`，随包落盘；
 * - `{ url }`：**提交阶段**用（或已知道最终 URL 时），渲染成可直接发出去的 `<img>`。
 *
 * 提交前必须用 `substituteWechatImageSlots()` 把占位符全部换掉 —— 带占位符的正文发出去
 * 就是一篇全裂图的文章。
 */
export type WechatArticleImage =
  | { url: string; caption?: string }
  | { slot: number; caption?: string };

/** 正文图占位符前缀。`substituteWechatImageSlots` 与打包层共用这一份约定。 */
export const WECHAT_IMAGE_SLOT_PREFIX = "{{wechat-image-";
const IMAGE_SLOT_PATTERN = /\{\{wechat-image-(\d+)\}\}/gu;

export interface WechatArticleRenderOptions {
  images?: WechatArticleImage[];
}

export type WechatArticleField = ArticleValidationField;
export type WechatArticleValidationError = ArticleValidationError;

/**
 * 图片是否由微信托管。
 *
 * **不能用 `includes("mmbiz.qpic.cn")`**：`http://mmbiz.qpic.cn.evil.com/x.png` 也含这个子串，
 * 而本项目在 Cookie 域判断上正好踩过一次同类坑（`iesdouyin.com` 含 `douyin.com`）。
 * 只接受「等于该域名」或「以 `.该域名` 结尾」。
 */
export function isWechatHostedImage(url: string): boolean {
  return isHostWithin(url, "mmbiz.qpic.cn");
}

/** 正文里允许保留的链接：官方支持插入自己与其他公众号/服务号已群发文章链接。 */
export function isWechatArticleUrl(url: string): boolean {
  return isHostWithin(url, "mp.weixin.qq.com");
}

function isHostWithin(url: string, domain: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

// ── 清洗 ──────────────────────────────────────────────────────────────────────

function stripCommentsAndForbiddenBlocks(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/gu, "");
  for (const tag of FORBIDDEN_BLOCKS) {
    // 先删配对块（含内容），再删落单的开/闭标签。
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "giu"), "");
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "giu"), "");
  }
  return out;
}

function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "iu").exec(
    attributes,
  );
  if (!match) return undefined;
  return (match[2] ?? match[3] ?? match[4] ?? "").trim();
}

function escapeAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * 去属性，**同时**完成两道来源校验：
 * - `<img>` 的 `src` 不是微信托管 → **整张图丢掉**（留着只会变裂图）；
 * - `<a>` 的 `href` 不是公众号文章链接 → 退化成无 href 的 `<a>`（正文里的站外链接本来就点不动，
 *   留个假的可点样式反而误导；站外链接的正规位置是 `content_source_url`／「阅读原文」）。
 */
function stripAttributes(html: string): string {
  return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/gu, (match, rawName: string, attributes: string) => {
    const tag = rawName.toLowerCase();
    if (tag === "img") {
      const src = readAttribute(attributes, "src");
      if (!src || !isWechatHostedImage(src)) return "";
      const alt = readAttribute(attributes, "alt");
      return `<img src="${escapeAttribute(src)}"${alt ? ` alt="${escapeAttribute(alt)}"` : ""}>`;
    }
    if (tag === "a") {
      const href = readAttribute(attributes, "href");
      // 站外链接的整对标签由 normalizeAnchors 处理；这里只可能遇到落单的开标签。
      return href && isWechatArticleUrl(href) ? `<a href="${escapeAttribute(href)}">` : "";
    }
    if (VOID_TAGS.has(tag)) return `<${tag}>`;
    // 列表项标记只可能由本模块在上一步写入（输入的 data-* 已在更早一步被清掉）。
    const marker = readAttribute(attributes, LIST_ITEM_MARKER);
    return marker === LIST_ITEM_MARKER_VALUE ? `<${tag} ${LIST_ITEM_MARKER}="${marker}">` : `<${tag}>`;
  });
}

function stripInputDataAttributes(html: string): string {
  // 先清掉输入自带的一切 data-*，避免外部伪造我们的内部标记。
  return html.replace(/\sdata-[\w-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu, "");
}

/**
 * 段内文本里的**块级边界换成 `<br>`**。
 *
 * 段内不能保留块级标签（`<p>` 里再套 `<p>` 是非法结构），但**直接解开会把文字粘在一起**：
 * `<li>钩子要具体</li><li>别用「大家好」开场</li>` 会变成「钩子要具体别用「大家好」开场」。
 * 这个 bug 由渲染真实样例时的肉眼复核抓到，用例见 `段内文本里的块级标签不会把文字粘在一起`。
 */
function inlineBlockBoundaries(html: string): string {
  const blockTag = "p|div|section|h[1-6]|ul|ol|li|blockquote|tr|td|th|dd|dt|figure|figcaption";
  return html
    .replace(new RegExp(`<\\/(?:${blockTag})\\s*>`, "giu"), "<br>")
    .replace(new RegExp(`<(?:${blockTag})\\b[^>]*>`, "giu"), "")
    .replace(/(?:\s*<br\s*\/?>\s*){2,}/giu, "<br>")
    .replace(/^(?:\s*<br\s*\/?>\s*)+/iu, "")
    .replace(/(?:\s*<br\s*\/?>\s*)+$/iu, "");
}

function normalizeHeadings(html: string): string {
  return html.replace(/<(\/?)([hH][1-6])\b[^>]*>/gu, (_match, slash: string) => `<${slash}h2>`);
}

function convertLists(html: string): string {
  return html
    .replace(/<ul\b[^>]*>/giu, `<section style="${LIST_WRAPPER_STYLE}">`)
    .replace(/<\/ul\s*>/giu, "</section>")
    .replace(/<ol\b[^>]*>/giu, `<section style="${LIST_WRAPPER_STYLE}">`)
    .replace(/<\/ol\s*>/giu, "</section>")
    .replace(/<li\b[^>]*>/giu, `<p ${LIST_ITEM_MARKER}="${LIST_ITEM_MARKER_VALUE}">`)
    .replace(/<\/li\s*>/giu, "</p>");
}

/** 把白名单之外的标签**解开**（丢掉标签本身、保留里面的文字），而不是整段删除。 */
function unwrapDisallowedTags(html: string, keep: Set<string>): string {
  const names = new Set<string>();
  for (const match of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gu)) {
    names.add(match[1].toLowerCase());
  }
  let out = html;
  for (const name of names) {
    if (keep.has(name)) continue;
    out = out.replace(new RegExp(`<\\/?${name}\\b[^>]*>`, "giu"), "");
  }
  return out;
}

/**
 * 给「还没有 style 的标签」补内联样式：先注入的（列表项）不会被覆盖。
 *
 * **必须保留原标签上已有的属性** —— 早期实现是「没有 style 就整个重建标签」，
 * 结果把 `<img src="…">` 重建成了 `<img style="…">`：图片的 src 被静默抹掉，
 * 表现是草稿里一张图都没有而接口不报任何错。这个 bug 由用例抓到（`正文里已有的外链 <img>…`）。
 */
function ensureStyle(html: string, tag: string, style: string): string {
  return html.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, "giu"), (match, rawAttributes?: string) => {
    if (/\sstyle\s*=/iu.test(match)) return match;
    const attributes = (rawAttributes ?? "").replace(/\/\s*$/u, "").trim();
    return attributes.length > 0
      ? `<${tag} ${attributes} style="${style}">`
      : `<${tag} style="${style}">`;
  });
}

/**
 * 成对处理锚点：**站外链接整对拆掉只留文字**。
 *
 * 正文里的站外链接在公众号里本来就点不动，留一个「看起来能点」的样式是误导；
 * 站外链接的正规位置是 `content_source_url`（「阅读原文」）。
 * 公众号文章链接（`mp.weixin.qq.com`）官方明确支持插入正文，予以保留。
 */
function normalizeAnchors(html: string): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu, (_match, attributes: string, inner: string) => {
    const href = readAttribute(attributes, "href");
    return href && isWechatArticleUrl(href) ? `<a href="${escapeAttribute(href)}">${inner}</a>` : inner;
  });
}

/**
 * 清掉落单的锚点标签（只有开标签的、或只有闭标签的）。
 *
 * 走到这里时「合法的 `<a href=…>` 开标签」与「它的闭标签」已经成对存在，
 * 因此按文档顺序配一次对即可：配不上的闭标签与没有 href 的开标签都丢掉。
 */
function pruneAnchors(html: string): string {
  let open = false;
  return html.replace(/<a\b[^>]*>|<\/a\s*>/giu, (tag) => {
    if (tag.startsWith("</")) {
      if (!open) return "";
      open = false;
      return tag;
    }
    if (!/\shref\s*=/iu.test(tag)) return "";
    open = true;
    return tag;
  });
}

/**
 * 清洗一段微信正文 HTML。
 *
 * @param allowBlocks 允许块级标签（整篇正文）还是只允许行内标签（段内文本）。
 *   段内文本必须走 `allowBlocks: false`，否则 `<p>` 会嵌套出 `<p><p>…` 这种非法结构。
 */
export function sanitizeWechatHtml(html: string, allowBlocks = true): string {
  const keep = allowBlocks ? BLOCK_KEEP : INLINE_KEEP;
  let out = stripCommentsAndForbiddenBlocks(html ?? "");
  out = stripInputDataAttributes(out);
  if (!allowBlocks) {
    out = normalizeHeadings(out);
    out = inlineBlockBoundaries(out);
  }
  out = normalizeAnchors(out);
  out = stripAttributes(out);
  out = pruneAnchors(out);
  if (allowBlocks) {
    // div 是有语义的容器：降级成 section 而不是拆掉。
    out = out.replace(/<div\b[^>]*>/giu, `<section style="${SECTION_STYLE}">`).replace(/<\/div\s*>/giu, "</section>");
    out = normalizeHeadings(out);
    out = convertLists(out);
  }
  out = unwrapDisallowedTags(out, keep);
  if (allowBlocks) {
    out = ensureStyle(out, "h2", H2_STYLE);
    out = ensureStyle(out, "section", SECTION_STYLE);
    out = ensureStyle(out, "p", P_STYLE);
    out = ensureStyle(out, "blockquote", QUOTE_STYLE);
    out = ensureStyle(out, "hr", HR_STYLE);
  }
  out = ensureStyle(out, "img", IMG_STYLE);
  // 内部标记用完即弃，绝不出现在最终产物里。
  return out.replace(new RegExp(`\\s${LIST_ITEM_MARKER}="${LIST_ITEM_MARKER_VALUE}"`, "gu"), "");
}

/** 段内文本：只保留行内语义标签，块级标签被解开。 */
export function sanitizeParagraphHtml(text: string): string {
  return sanitizeWechatHtml(text, false).trim();
}

const IMG_SRC_PATTERN = /<img\b[^>]*\bsrc\s*=\s*"([^"]*)"/giu;

/** 按出现顺序取出正文里的图片 URL（只认微信托管的，见 `isWechatHostedImage`）。 */
export function extractContentImageSources(html: string): string[] {
  const sources: string[] = [];
  for (const match of (html ?? "").matchAll(IMG_SRC_PATTERN)) {
    if (isWechatHostedImage(match[1])) sources.push(match[1]);
  }
  return sources;
}

// ── 校验 ──────────────────────────────────────────────────────────────────────

/**
 * 校验标题/摘要/作者的字数（公众号口径）。
 *
 * **正文长度不在这里**：正文是由渲染产生的（含我们注入的样式），只有渲染完才知道真实长度，
 * 因此那条断言在 `renderWechatArticleHtml` 里。
 */
export function validateArticleDraft(draft: WechatArticleDraft): WechatArticleValidationError[] {
  return validateArticleDraftAgainstProfile(draft, WECHAT_ARTICLE_PROFILE);
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────

function renderImage(image: WechatArticleImage): string[] {
  const source = "url" in image
    ? (isWechatHostedImage(image.url ?? "") ? image.url : "")
    : `${WECHAT_IMAGE_SLOT_PREFIX}${Math.max(1, Math.floor(image.slot))}}}`;
  if (source.length === 0) return [];
  const parts = [`<img src="${escapeAttribute(source)}" style="${IMG_STYLE}">`];
  const caption = (image.caption ?? "").trim();
  if (caption.length > 0) {
    parts.push(`<p style="${CAPTION_STYLE}">${sanitizeParagraphHtml(caption)}</p>`);
  }
  return parts;
}

/**
 * 把正文里的图片占位符替换成真正的微信托管 URL。
 *
 * 三条硬要求（都有用例守住）：
 * 1. **一个都不许剩下** —— 漏替换的正文发出去就是裂图，而且接口不会报错；
 * 2. **只接受微信托管的 URL**（`mmbiz.qpic.cn`）—— 外链图会被微信过滤掉；
 * 3. **替换后仍要满足 2 万字符上限** —— 图片 URL 也是 content 的一部分。
 *
 * @throws WechatArticleError `wechat_article_image_slot_missing`（有占位符没给 URL）
 *   或 `wechat_article_image_unsafe`（给了非微信托管的 URL）
 */
export function substituteWechatImageSlots(
  html: string,
  urlBySlot: ReadonlyMap<number, string>,
): string {
  const resolved = new Map<number, string>();
  for (const [slot, url] of urlBySlot) {
    if (!isWechatHostedImage(url ?? "")) {
      throw new WechatArticleError(
        "wechat_article_image_unsafe",
        `第 ${slot} 张正文图不是微信托管的图片地址（只接受 mmbiz.qpic.cn）：外链图片会被微信过滤成裂图，请重新上传。`,
      );
    }
    resolved.set(slot, url);
  }

  const missing = new Set<number>();
  const output = (html ?? "").replace(IMAGE_SLOT_PATTERN, (match, rawSlot: string) => {
    const slot = Number(rawSlot);
    const url = resolved.get(slot);
    if (!url) {
      missing.add(slot);
      return match;
    }
    return url;
  });

  if (missing.size > 0) {
    throw new WechatArticleError(
      "wechat_article_image_slot_missing",
      `正文里还有未替换的图片占位符（缺少第 ${[...missing].sort((a, b) => a - b).join("、")} 张的微信图片地址），拒绝提交：请重试上传这些图片。`,
    );
  }

  const length = codePointLength(output);
  if (length > WECHAT_ARTICLE_LIMITS.contentChars) {
    throw new WechatArticleError(
      "wechat_article_too_long",
      `替换图片地址后正文为 ${length} 字符，超过 ${WECHAT_ARTICLE_LIMITS.contentChars} 上限：请精简正文后重试。`,
    );
  }
  return output;
}

/**
 * 结构化草稿 → 微信公众号 `content`。
 *
 * 输出是**自包含的内联样式片段**（一个根 `<section style="…">`，不带 html/head/body 外壳）。
 *
 * 配图位置：第 k 张图放在第 k 个 section 之后；**图多于 section 时余下的按顺序附在文末**
 * （宁可多插一张，也不静默丢图）。
 *
 * @throws WechatArticleError `wechat_article_too_long` —— 渲染结果超过 2 万字符，
 *   消息里带上**是第几段超的**（只说「内容过长」等于让用户自己找）。
 */
export function renderWechatArticleHtml(
  draft: WechatArticleDraft,
  options: WechatArticleRenderOptions = {},
): string {
  const images = (options.images ?? []).filter((image) =>
    "url" in image
      ? isWechatHostedImage(image.url ?? "")
      : Number.isFinite(image.slot) && Math.floor(image.slot) >= 1,
  );
  const parts: string[] = [];
  const sections = draft.sections ?? [];

  sections.forEach((section, index) => {
    const heading = (section.heading ?? "").trim();
    if (heading.length > 0) {
      parts.push(`<h2 style="${H2_STYLE}">${sanitizeParagraphHtml(heading)}</h2>`);
    }
    for (const paragraph of section.paragraphs ?? []) {
      const content = sanitizeParagraphHtml(paragraph ?? "");
      if (content.length > 0) parts.push(`<p style="${P_STYLE}">${content}</p>`);
    }
    const image = images[index];
    if (image) parts.push(...renderImage(image));

    const rendered = `<section style="${ROOT_STYLE}">${parts.join("\n")}</section>`;
    if (codePointLength(rendered) > WECHAT_ARTICLE_LIMITS.contentChars) {
      throw new WechatArticleError(
        "wechat_article_too_long",
        `文章正文已超过 ${WECHAT_ARTICLE_LIMITS.contentChars} 字符上限（在第 ${
          index + 1
        } 段处超出）：请精简第 ${index + 1} 段或之后的内容后重试。`,
      );
    }
  });

  for (const image of images.slice(sections.length)) {
    parts.push(...renderImage(image));
  }

  return `<section style="${ROOT_STYLE}">${parts.join("\n")}</section>`;
}

// ── 公众号档案与 AI 成文 ─────────────────────────────────────────────────────

/**
 * 成文取材：任务已有的产物（转录 + 洗稿）。
 *
 * 与 `publishing-copy.ts` 的 `CleanedReference` 同一来源，但**字段更全** —— 文章比短视频文案
 * 需要更多上下文（大纲、质量提示、口播稿）。
 */
export type WechatArticleSourceContext = ArticleSourceContext;
export type WechatArticleAiConfig = ArticleAiConfig;
export type WechatArticleChatClient = ArticleChatClient;
export type WechatArticlePlanDeps = ArticlePlanDeps;
export type WechatArticleFallbackWarning = ArticleFallbackWarning;
export type WechatArticlePlan = ArticlePlan;

/**
 * AI 成文失败时的提示。
 *
 * **绝不静默**：产出一份看起来正常、其实是原始口播稿的东西，比明确报错更糟
 * （本项目在抖音通路上吃过「失败原因被吞掉」的亏）。
 */
export const WECHAT_ARTICLE_FALLBACK_WARNING: WechatArticleFallbackWarning = {
  code: "wechat_article_ai_fallback",
  message: "AI 成文暂不可用，已按洗稿要点生成可编辑的兜底结构；请检查标题与正文后再提交，也可以重试。",
};

const EMPTY_SOURCE_PLACEHOLDER =
  "（这一篇还没有可用的正文素材：请先在作品详情页完成「AI 洗稿」，或在这里手动补写正文。）";

/** 公众号口径档案：限额来自 `WECHAT_ARTICLE_LIMITS`（官方硬限额的唯一真源）。 */
const WECHAT_ARTICLE_PROFILE: ArticleProfile = {
  label: "微信公众号",
  limits: {
    // 公众号只要求标题非空（`title` 是 `draft/add` 的必填项），没有下限。
    titleMin: 1,
    titleMax: WECHAT_ARTICLE_LIMITS.title,
    bodyChars: WECHAT_ARTICLE_LIMITS.contentChars,
    digestMax: WECHAT_ARTICLE_LIMITS.digest,
    authorMax: WECHAT_ARTICLE_LIMITS.author,
  },
  fieldLabels: { title: "微信公众号文章标题", digest: "文章摘要", author: "文章作者" },
  jsonKeys: ["title", "digest", "author", "sections", "tags"],
  promptRules: (limits) => [
    "你是中文公众号文章编辑：把短视频的转录与洗稿结果改写成一篇可以直接发出去的公众号文章。",
    `标题不超过 ${limits.titleMax} 字，摘要不超过 ${limits.digestMax} 字，作者不超过 ${limits.authorMax} 字。`,
    `正文总长度必须少于 ${limits.bodyChars} 字符（含标点），建议 800–2000 字。`,
    ...commonArticleRules(["title", "digest", "author", "sections", "tags"]),
  ],
  userPromptPrefix: "参考数据（来自一条短视频的转录与 AI 洗稿结果）：",
  requestLine: "请据此写一篇公众号文章。",
  emptySourceNote: EMPTY_SOURCE_PLACEHOLDER,
  emptyTitleFallback: "未命名文章",
  fallbackWarning: WECHAT_ARTICLE_FALLBACK_WARNING,
};

/**
 * 把任务产物写成一篇公众号文章。
 *
 * **失败一律走兜底而不抛出**（与 `PublishingCopyService.previewAll` 同一口径）。
 * 实现与头条共用 `planArticle`，差异只在上面那份档案。
 */
export async function planWechatArticle(
  context: WechatArticleSourceContext,
  deps: WechatArticlePlanDeps,
): Promise<WechatArticlePlan> {
  return planArticle(context, deps, WECHAT_ARTICLE_PROFILE);
}
