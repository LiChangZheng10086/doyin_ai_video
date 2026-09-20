import type { PackageContentType, PlatformCopy, PublishPlatform } from "../types.js";
import { TOUTIAO_ARTICLE_LIMITS } from "./toutiao-article.js";

export interface PlatformPolicy {
  label: string;
  titleMax: number;
  descriptionMax: number;
  hashtagMax: number;
  hashtagLengthMax: number;
  creatorUrl: string;
}

export type PlatformCopyField = keyof PlatformCopy;

export interface PlatformCopyValidationError {
  platform: PublishPlatform;
  field: PlatformCopyField;
  actual: number;
  limit: number;
  message: string;
}

export const PUBLISH_PLATFORMS: Record<PublishPlatform, PlatformPolicy> = {
  douyin: {
    label: "抖音",
    titleMax: 55,
    descriptionMax: 1000,
    hashtagMax: 10,
    hashtagLengthMax: 20,
    creatorUrl: "https://creator.douyin.com/creator-micro/content/upload",
  },
  xiaohongshu: {
    label: "小红书",
    titleMax: 20,
    descriptionMax: 1000,
    hashtagMax: 10,
    hashtagLengthMax: 20,
    creatorUrl: "https://creator.xiaohongshu.com/publish/publish",
  },
  wechat_channels: {
    label: "微信视频号",
    titleMax: 30,
    descriptionMax: 1000,
    hashtagMax: 10,
    hashtagLengthMax: 20,
    creatorUrl: "https://channels.weixin.qq.com/platform/post/create",
  },
  bilibili: {
    label: "哔哩哔哩",
    titleMax: 80,
    descriptionMax: 2000,
    hashtagMax: 10,
    hashtagLengthMax: 20,
    creatorUrl: "https://member.bilibili.com/platform/upload/video/frame",
  },
  /**
   * 微信公众号（草稿箱）。
   *
   * 这套数字是 `draft/add` 的**硬限制**（spec §1.3，已逐条核对官方文档）：
   * 标题 ≤32 字、摘要 ≤120 字。注意 `description` 在公众号语境里是**摘要（digest）**，
   * 不是正文 —— 正文走渲染出来的 HTML（见 `wechat-article.ts`），长度上限 2 万字符在那边断言。
   *
   * `hashtag*` 保留与其它平台一致的口径，但**不提交给微信**：`draft/add` 没有话题字段
   * （公众号话题标签只能在编辑器里手工加）。
   */
  wechat_mp: {
    label: "微信公众号",
    titleMax: 32,
    descriptionMax: 120,
    hashtagMax: 10,
    hashtagLengthMax: 20,
    creatorUrl: "https://mp.weixin.qq.com/",
  },
  /**
   * 今日头条（文章）。
   *
   * 标题 **2~30 字**是平台硬限制（参考项目实测 `TITLE_MIN_LEN`/`TITLE_MAX_LEN`）；
   * 下限由 `TOUTIAO_ARTICLE_LIMITS.titleMin` 在文章校验里管 —— 这张表的口径与视频/图文一致，
   * 只有上限。
   *
   * `description` 在头条文章语境里是**正文文本**（不是摘要），上限用我们自己的正文守卫；
   * `hashtag*` 保留与其它平台一致的口径，但**不提交**：文章编辑器没有话题字段。
   */
  toutiao: {
    label: "今日头条",
    titleMax: TOUTIAO_ARTICLE_LIMITS.titleMax,
    descriptionMax: TOUTIAO_ARTICLE_LIMITS.bodyChars,
    hashtagMax: 10,
    hashtagLengthMax: 20,
    creatorUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
  },
};

/**
 * 图文（note）口径。与视频口径**故意分开**：抖音图文标题上限是 20 字，而视频是 55 字
 * （见上游 `DouYinNote.validate_upload_args()`），共用一份会让现有视频标题一律不合格。
 * 未列出的平台表示「暂未接入图文」，调用 `validateNoteCopy` 会直接抛错。
 */
export const PUBLISH_NOTE_POLICIES: Partial<Record<PublishPlatform, PlatformPolicy>> = {
  douyin: {
    label: "抖音",
    titleMax: 20,
    descriptionMax: 1000,
    hashtagMax: 10,
    hashtagLengthMax: 20,
    creatorUrl: "https://creator.douyin.com/creator-micro/content/upload",
  },
};

function codePointLength(value: string): number {
  return [...value].length;
}

export function normalizePlatformCopy(copy: PlatformCopy): PlatformCopy {
  const hashtags: string[] = [];
  const seen = new Set<string>();

  for (const value of copy.hashtags) {
    const hashtag = value.trim().replace(/^#+/u, "").trim();
    if (hashtag && !seen.has(hashtag)) {
      seen.add(hashtag);
      hashtags.push(hashtag);
    }
  }

  return {
    title: copy.title.trim(),
    description: copy.description.trim(),
    hashtags,
  };
}

export function validatePlatformCopy(
  platform: PublishPlatform,
  copy: PlatformCopy
): PlatformCopyValidationError[] {
  return validateCopyAgainstPolicy(platform, PUBLISH_PLATFORMS[platform], copy);
}

/**
 * 校验图文文案。与视频校验收敛到同一个实现，只换政策来源，
 * 避免两条链路各写一份长度规则后慢慢漂移。
 */
export function validateNoteCopy(
  platform: PublishPlatform,
  copy: PlatformCopy
): PlatformCopyValidationError[] {
  const policy = PUBLISH_NOTE_POLICIES[platform];
  if (!policy) {
    throw new Error(`平台 ${platform} 尚未接入图文发布，不能按图文口径校验`);
  }
  return validateCopyAgainstPolicy(platform, policy, copy);
}

/**
 * 按给定政策校验文案。
 *
 * **导出**是为了让新增平台能按自己的口径复用同一份实现（头条文章包走
 * `validateToutiaoArticle`，但包级文案仍需要同一套长度规则），
 * 而不是再写一份「标题不能为空 / 超限」的分支。
 */
export function validateCopyAgainstPolicy(
  platform: PublishPlatform,
  policy: PlatformPolicy,
  copy: PlatformCopy
): PlatformCopyValidationError[] {
  const normalized = normalizePlatformCopy(copy);
  const errors: PlatformCopyValidationError[] = [];
  const titleLength = codePointLength(normalized.title);
  const descriptionLength = codePointLength(normalized.description);

  if (titleLength === 0) {
    errors.push({
      platform,
      field: "title",
      actual: 0,
      limit: 1,
      message: `${policy.label}标题不能为空`,
    });
  } else if (titleLength > policy.titleMax) {
    errors.push({
      platform,
      field: "title",
      actual: titleLength,
      limit: policy.titleMax,
      message: `${policy.label}标题当前 ${titleLength} 字，最多 ${policy.titleMax} 字`,
    });
  }

  if (descriptionLength > policy.descriptionMax) {
    errors.push({
      platform,
      field: "description",
      actual: descriptionLength,
      limit: policy.descriptionMax,
      message: `${policy.label}正文当前 ${descriptionLength} 字，最多 ${policy.descriptionMax} 字`,
    });
  }

  if (normalized.hashtags.length > policy.hashtagMax) {
    errors.push({
      platform,
      field: "hashtags",
      actual: normalized.hashtags.length,
      limit: policy.hashtagMax,
      message: `${policy.label}标签当前 ${normalized.hashtags.length} 个，最多 ${policy.hashtagMax} 个`,
    });
  }

  for (const hashtag of normalized.hashtags) {
    const hashtagLength = codePointLength(hashtag);
    if (hashtagLength > policy.hashtagLengthMax) {
      errors.push({
        platform,
        field: "hashtags",
        actual: hashtagLength,
        limit: policy.hashtagLengthMax,
        message: `${policy.label}标签“${hashtag}”当前 ${hashtagLength} 字，最多 ${policy.hashtagLengthMax} 字`,
      });
    }
  }

  return errors;
}

export function buildPublishText(copy: PlatformCopy): string {
  const normalized = normalizePlatformCopy(copy);
  const hashtags = normalized.hashtags.map((hashtag) => `#${hashtag}`).join(" ");
  return [normalized.title, normalized.description, hashtags].filter(Boolean).join("\n\n");
}

/**
 * 允许自动发布的 **(内容类型 × 平台)** 组合 → 执行通路。
 *
 * 抖音通路当初把这条判断写成了散在两处的硬闸（`publishing-store.beginAutoPublish` 与
 * `publishing-service.autoPublish` 各判一次 `contentType !== "note"`）。加第二个平台时
 * 那种写法会立刻变成两个必须同步修改的静默点，所以收敛成这张表，
 * **两个调用方都只问它**（有用例断言两个平台各自走对通路、且互不触碰）。
 */
export const AUTO_PUBLISH_ROUTES: ReadonlyArray<{
  contentType: PackageContentType;
  platform: PublishPlatform;
  engine: "sau" | "toutiao";
}> = [
  { contentType: "note", platform: "douyin", engine: "sau" },
  { contentType: "article", platform: "toutiao", engine: "toutiao" },
];

export type AutoPublishEngine = (typeof AUTO_PUBLISH_ROUTES)[number]["engine"];

/** 未登记的组合返回 `null`（调用方据此给出「该组合不支持自动发布」的明确错误）。 */
export function resolveAutoPublishEngine(
  contentType: PackageContentType,
  platform: PublishPlatform,
): AutoPublishEngine | null {
  const route = AUTO_PUBLISH_ROUTES.find(
    (item) => item.contentType === contentType && item.platform === platform,
  );
  return route ? route.engine : null;
}
