import type {
  CreatePublishingPackageInput,
  NoteCopyLimits,
  NoteImageSource,
  PlatformCopy,
  PublishingPreview,
} from '../types';

/**
 * 图文包（抖音图文）的纯逻辑：按序多选、来源阻塞原因、请求体组装。
 *
 * 放在 utils 里而不是组件里，是因为这些是「用户可见行为」——
 * 选择顺序、上限提示、文案字数都必须能被断言守住，组件只负责渲染。
 *
 * 字数规则的真源仍然在服务端（`PUBLISH_NOTE_POLICIES`）：这里只做即时反馈，
 * 上限数字由预览接口下发，创建时服务端会重新校验。
 */

/**
 * 素材库多选：点一下追加到末尾（**顺序即入包顺序**），再点一下移除。
 *
 * 已达上限时返回原数组（不静默塞进去、也不抛错）：界面据 `imageLimit` 明确提示，
 * 由人来决定取消哪一张 —— 自动挤掉最早选的那张会让「我选了什么」变得不可预测。
 */
export function toggleLibraryImage(selected: string[], assetId: string, limit: number): string[] {
  if (selected.includes(assetId)) return selected.filter((id) => id !== assetId);
  if (selected.length >= limit) return selected;
  return [...selected, assetId];
}

/** 网格里显示的顺序徽标：1 基序号；未选中返回 0（界面据此不渲染徽标）。 */
export function selectionOrder(selected: string[], assetId: string): number {
  const index = selected.indexOf(assetId);
  return index < 0 ? 0 : index + 1;
}

export interface NoteImageBlockerInput {
  source: NoteImageSource;
  /** 该作品已生成的场景静帧数量。 */
  framesCount: number;
  /** 素材库里可选的图片总数。 */
  libraryCount: number;
  /** 当前已选中的素材张数。 */
  selectedCount: number;
  /** 平台张数上限（服务端下发）。 */
  limit: number;
}

/** 创建图文包前必须先解决的问题；`null` 表示这一步已就绪。 */
export function getNoteImageBlocker(input: NoteImageBlockerInput): string | null {
  if (input.source === 'frames') {
    if (input.framesCount === 0) {
      return '这个作品还没有场景静帧，请先生成视频，或改用素材库选图';
    }
    if (input.framesCount > input.limit) {
      return `静帧共有 ${input.framesCount} 张，超过抖音图文上限 ${input.limit} 张`;
    }
    return null;
  }

  if (input.libraryCount === 0) {
    return '素材库里还没有图片，请先到「素材」页上传';
  }
  if (input.selectedCount === 0) {
    return '请至少选择一张素材库图片';
  }
  if (input.selectedCount > input.limit) {
    return `抖音图文最多 ${input.limit} 张，请先取消 ${input.selectedCount - input.limit} 张`;
  }
  return null;
}

/** 图文口径的本地即时校验；服务端在创建时会按同一口径重新校验一遍。 */
export function noteCopyFieldErrors(copy: PlatformCopy, limits: NoteCopyLimits): string[] {
  const errors: string[] = [];
  const titleLength = [...copy.title.trim()].length;
  const descriptionLength = [...copy.description.trim()].length;

  if (titleLength === 0) errors.push('标题不能为空');
  else if (titleLength > limits.titleMax) errors.push(`标题当前 ${titleLength} 字，最多 ${limits.titleMax} 字`);

  if (descriptionLength === 0) errors.push('正文不能为空');
  else if (descriptionLength > limits.descriptionMax) {
    errors.push(`正文当前 ${descriptionLength} 字，最多 ${limits.descriptionMax} 字`);
  }

  if (copy.hashtags.length > limits.hashtagMax) {
    errors.push(`话题当前 ${copy.hashtags.length} 个，最多 ${limits.hashtagMax} 个`);
  }
  return errors;
}

/** 文案只做 trim / 去 `#` / 去重；长度与上限判定仍归服务端。 */
export function normalizeNoteCopyDraft(copy: PlatformCopy): PlatformCopy {
  const hashtags: string[] = [];
  for (const value of copy.hashtags) {
    const hashtag = value.trim().replace(/^#+/u, '').trim();
    if (hashtag.length > 0 && !hashtags.includes(hashtag)) hashtags.push(hashtag);
  }
  return {
    title: copy.title.trim(),
    description: copy.description.trim(),
    hashtags,
  };
}

export interface BuildNotePackageInputArgs {
  sourceJobId: string;
  /** 交付包标题（作品标题），与图文文案标题是两回事。 */
  title: string;
  /** 最近一次预览；它携带创建时必须回传的 `previewRevision`。 */
  preview?: PublishingPreview;
  copy: PlatformCopy;
  source: NoteImageSource;
  selectedImageIds: string[];
}

/**
 * 组装创建请求。`previewRevision` 是服务端的硬约束（缺失 400 / 不一致 409），
 * 所以这里没有预览就直接抛错，而不是发出一个注定被拒的请求。
 */
export function buildNotePackageInput(args: BuildNotePackageInputArgs): CreatePublishingPackageInput {
  const revision = args.preview?.previewRevision;
  if (!revision) throw new Error('图文预览尚未完成');

  const noteCopy = normalizeNoteCopyDraft(args.copy);
  return {
    sourceJobId: args.sourceJobId,
    previewRevision: revision,
    title: args.title,
    contentType: 'note',
    noteCopy,
    imageSource: args.source,
    // 静帧来源绝不能带素材 id（服务端会直接 400），所以这里按来源决定字段是否存在
    ...(args.source === 'library' ? { imageAssetIds: [...args.selectedImageIds] } : {}),
    platforms: [{ platform: 'douyin', copy: noteCopy }],
  };
}
