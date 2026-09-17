import type { PlatformCopy, PublishPlatform } from "../types.js";

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

function validateCopyAgainstPolicy(
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
