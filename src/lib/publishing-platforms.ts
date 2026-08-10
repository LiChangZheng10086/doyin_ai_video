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
  const policy = PUBLISH_PLATFORMS[platform];
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
