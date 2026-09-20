import type {
  CreatePublishingPackageInput,
  DueNotification,
  HyperframesVideoOutput,
  LocalUserRole,
  PackageContentType,
  PlatformCopy,
  PublishCopySource,
  PublishPlatform,
  PublishTask,
  PublishingListStatus,
  PublishingPackageDetail,
  PublishingPreview,
} from '../types/index.js';
import { stripAnsi } from './display.js';

export const PUBLISHING_PLATFORMS: Array<{
  id: PublishPlatform;
  label: string;
  titleMax: number;
  descriptionMax: number;
  hashtagMax: number;
  hashtagLengthMax: number;
  creatorUrl: string;
}> = [
  { id: 'douyin', label: '抖音', titleMax: 55, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://creator.douyin.com/creator-micro/content/upload' },
  { id: 'xiaohongshu', label: '小红书', titleMax: 20, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://creator.xiaohongshu.com/publish/publish' },
  { id: 'wechat_channels', label: '微信视频号', titleMax: 30, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://channels.weixin.qq.com/platform/post/create' },
  { id: 'bilibili', label: '哔哩哔哩', titleMax: 80, descriptionMax: 2000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://member.bilibili.com/platform/upload/video/frame' },
  { id: 'wechat_mp', label: '微信公众号', titleMax: 32, descriptionMax: 120, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://mp.weixin.qq.com/' },
  // 今日头条（文章通路）：标题 2~30 字是平台硬限制，这张表只放上限；
  // `description` 在头条文章语境里是正文文本，上限 = 服务端 `TOUTIAO_ARTICLE_LIMITS.bodyChars`。
  { id: 'toutiao', label: '今日头条', titleMax: 30, descriptionMax: 20000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://mp.toutiao.com/profile_v4/graphic/publish' },
];

export const PUBLISH_FILTERS: Array<{ id: PublishingListStatus; label: string }> = [
  { id: 'action', label: '待处理' },
  { id: 'all', label: '全部' },
  { id: 'ready', label: '待发布' },
  { id: 'scheduled', label: '已排期' },
  { id: 'published', label: '已发布' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
  { id: 'broken', label: '资产异常' },
  { id: 'trash', label: '发布垃圾桶' },
];

export type PublishingWizardStep = 'asset' | 'platforms' | 'copy' | 'schedule' | 'confirm';

export interface PublishingWizardDraft {
  copy: PlatformCopy;
  copySource: PublishCopySource;
  scheduledAt: string;
}

export interface PublishingWizardFieldError {
  platform: PublishPlatform;
  field: keyof PlatformCopy;
  actual: number;
  limit: number;
  message: string;
}

export interface PublishingWizardState {
  step: PublishingWizardStep;
  selectedPlatforms: PublishPlatform[];
  preview?: PublishingPreview;
  drafts: Partial<Record<PublishPlatform, PublishingWizardDraft>>;
  platformError?: string;
  fieldErrors: PublishingWizardFieldError[];
}

export type PublishingWizardAction =
  | { type: 'advance' }
  | { type: 'back' }
  | { type: 'toggle-platform'; platform: PublishPlatform }
  | { type: 'load-preview'; preview: PublishingPreview; step?: PublishingWizardStep }
  | { type: 'edit-draft'; platform: PublishPlatform; field: keyof PlatformCopy; value: string | string[] }
  | { type: 'replace-draft'; platform: PublishPlatform; draft: PublishingWizardDraft }
  | { type: 'set-schedule'; platform: PublishPlatform; value: string };

const WIZARD_STEPS: PublishingWizardStep[] = ['asset', 'platforms', 'copy', 'schedule', 'confirm'];

export function createPublishingWizardState(
  selectedPlatforms: PublishPlatform[] = [],
): PublishingWizardState {
  return {
    step: 'asset',
    selectedPlatforms: [...selectedPlatforms],
    drafts: {},
    fieldErrors: [],
  };
}

export function publishingWizardReducer(
  state: PublishingWizardState,
  action: PublishingWizardAction,
): PublishingWizardState {
  if (action.type === 'toggle-platform') {
    const selected = state.selectedPlatforms.includes(action.platform)
      ? state.selectedPlatforms.filter((platform) => platform !== action.platform)
      : [...state.selectedPlatforms, action.platform];
    return { ...state, selectedPlatforms: selected, platformError: undefined };
  }
  if (action.type === 'load-preview') {
    const drafts = { ...state.drafts };
    for (const platform of state.selectedPlatforms) {
      const generated = action.preview.copies[platform];
      if (generated) {
        drafts[platform] = {
          copy: {
            title: generated.title,
            description: generated.description,
            hashtags: [...generated.hashtags],
          },
          copySource: generated.copySource,
          scheduledAt: drafts[platform]?.scheduledAt ?? '',
        };
      }
    }
    return {
      ...state,
      preview: action.preview,
      drafts,
      step: action.step ?? state.step,
      platformError: undefined,
      fieldErrors: [],
    };
  }
  if (action.type === 'edit-draft') {
    const draft = state.drafts[action.platform];
    if (!draft) return state;
    return {
      ...state,
      drafts: {
        ...state.drafts,
        [action.platform]: {
          ...draft,
          copy: { ...draft.copy, [action.field]: action.value } as PlatformCopy,
          copySource: 'user_edited',
        },
      },
      fieldErrors: state.fieldErrors.filter((error) => (
        error.platform !== action.platform || error.field !== action.field
      )),
    };
  }
  if (action.type === 'replace-draft') {
    return {
      ...state,
      drafts: { ...state.drafts, [action.platform]: structuredClone(action.draft) },
      fieldErrors: state.fieldErrors.filter((error) => error.platform !== action.platform),
    };
  }
  if (action.type === 'set-schedule') {
    const draft = state.drafts[action.platform];
    if (!draft) return state;
    return {
      ...state,
      drafts: { ...state.drafts, [action.platform]: { ...draft, scheduledAt: action.value } },
    };
  }
  if (action.type === 'back') {
    const index = WIZARD_STEPS.indexOf(state.step);
    return { ...state, step: WIZARD_STEPS[Math.max(0, index - 1)], platformError: undefined };
  }

  if (state.step === 'platforms' && state.selectedPlatforms.length === 0) {
    return { ...state, platformError: '请至少选择一个发布平台' };
  }
  if (state.step === 'copy') {
    const fieldErrors = validatePublishingDrafts(state);
    if (fieldErrors.length > 0) return { ...state, fieldErrors };
  }
  const index = WIZARD_STEPS.indexOf(state.step);
  return { ...state, step: WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, index + 1)] };
}

export function validatePublishingDrafts(
  state: PublishingWizardState,
): PublishingWizardFieldError[] {
  const errors: PublishingWizardFieldError[] = [];
  for (const platform of state.selectedPlatforms) {
    const policy = PUBLISHING_PLATFORMS.find((item) => item.id === platform)!;
    const copy = state.drafts[platform]?.copy;
    if (!copy) continue;
    const titleLength = [...copy.title.trim()].length;
    const descriptionLength = [...copy.description.trim()].length;
    if (titleLength === 0) {
      errors.push({ platform, field: 'title', actual: 0, limit: 1, message: `${policy.label}标题不能为空` });
    } else if (titleLength > policy.titleMax) {
      errors.push({ platform, field: 'title', actual: titleLength, limit: policy.titleMax, message: `${policy.label}标题当前 ${titleLength} 字，最多 ${policy.titleMax} 字` });
    }
    if (descriptionLength > policy.descriptionMax) {
      errors.push({ platform, field: 'description', actual: descriptionLength, limit: policy.descriptionMax, message: `${policy.label}正文当前 ${descriptionLength} 字，最多 ${policy.descriptionMax} 字` });
    }
    if (copy.hashtags.length > policy.hashtagMax) {
      errors.push({ platform, field: 'hashtags', actual: copy.hashtags.length, limit: policy.hashtagMax, message: `${policy.label}标签当前 ${copy.hashtags.length} 个，最多 ${policy.hashtagMax} 个` });
    }
    for (const tag of copy.hashtags) {
      const length = [...tag.trim().replace(/^#+/u, '')].length;
      if (length > policy.hashtagLengthMax) {
        errors.push({ platform, field: 'hashtags', actual: length, limit: policy.hashtagLengthMax, message: `${policy.label}标签“${tag}”当前 ${length} 字，最多 ${policy.hashtagLengthMax} 字` });
      }
    }
  }
  return errors;
}

export function getPublishingScheduleStatus(
  value: string,
  now = new Date(),
): 'ready' | 'scheduled' {
  const time = new Date(value).getTime();
  return value && Number.isFinite(time) && time > now.getTime() ? 'scheduled' : 'ready';
}

export function buildCreatePublishingInput(
  state: PublishingWizardState,
  sourceJobId: string,
  title: string,
  now = new Date(),
): CreatePublishingPackageInput {
  if (!state.preview) throw new Error('发布预览尚未完成');
  return {
    sourceJobId,
    previewRevision: state.preview.previewRevision,
    title,
    platforms: state.selectedPlatforms.map((platform) => {
      const draft = state.drafts[platform];
      if (!draft) throw new Error('发布文案尚未完成');
      const scheduledAt = getPublishingScheduleStatus(draft.scheduledAt, now) === 'scheduled'
        ? new Date(draft.scheduledAt).toISOString()
        : undefined;
      return {
        platform,
        copy: structuredClone(draft.copy),
        scheduledAt,
      };
    }),
  };
}

export function isPublishingEligibleVideo(
  output: HyperframesVideoOutput | null,
): output is HyperframesVideoOutput {
  return Boolean(
    output?.videoPath
    && output.videoPath.toLowerCase().endsWith('.mp4')
    && output.width > 0
    && output.height > 0
    && output.duration > 0,
  );
}

export type PublishingActionId =
  | 'copy-title'
  | 'copy-description'
  | 'copy-hashtags'
  | 'copy-full'
  | 'show-in-finder'
  | 'open-platform'
  | 'edit-content'
  | 'schedule'
  | 'mark-published'
  | 'record-failure'
  | 'cancel'
  | 'restore'
  | 'create-version'
  | 'withdraw'
  | 'trash-package'
  | 'restore-package'
  | 'preview'
  | 'auto-publish'
  | 'submit-code'
  /** 文章包：下载/打开包内 `article.html`（降级通路，任何时候可用、零依赖）。 */
  | 'download-article';

export interface PublishingSourceGroup {
  sourceJobId: string;
  title: string;
  versions: PublishingPackageDetail[];
}

export const PUBLISH_STATUS_LABELS: Record<PublishTask['status'], string> = {
  scheduled: '已排期',
  ready: '待发布',
  published: '已发布',
  failed: '失败',
  cancelled: '已取消',
};

export function groupPublishingPackages(
  details: PublishingPackageDetail[],
): PublishingSourceGroup[] {
  const groups = new Map<string, PublishingSourceGroup>();
  for (const detail of details) {
    const sourceJobId = detail.package.sourceJobId;
    const group = groups.get(sourceJobId) ?? {
      sourceJobId,
      title: detail.package.title,
      versions: [],
    };
    group.versions.push(detail);
    groups.set(sourceJobId, group);
  }
  return [...groups.values()].map((group) => {
    const versions = group.versions.sort((a, b) => b.package.version - a.package.version);
    return { ...group, title: versions[0].package.title, versions };
  });
}

/** 文章包判定：`contentType` 缺省视为 video（存量包不变）。 */
export function isArticlePackage(detail: PublishingPackageDetail): boolean {
  return (detail.package.contentType ?? 'video') === 'article';
}

// ─── 发布中心「渠道」分栏（spec: 2026-09-18-publishing-channel-tabs-design.md）────
//
// 渠道是**内容类型的界面投影**，不是新概念：note = 抖音图文、article = 今日头条文章、
// video = 视频人工交付（后者**不会自动上传**，只准备交付包）。
// 为什么按内容类型而不是平台：三者本来就互斥（note 只可能配抖音、article 只可能配头条、
// 其余都是 video），所以服务端只需要一个 `contentType` 过滤字段，不必引入复合查询。
// 状态语义仍在服务端（前端只传 `status`），这里只做**分组与计数**。

export type PublishChannelId = 'douyin-note' | 'toutiao-article' | 'video-manual';

export interface PublishChannel {
  id: PublishChannelId;
  label: string;
  /** 渠道的唯一真源：包的内容类型。 */
  contentType: PackageContentType;
  /** 该渠道会出现的平台（用于决定平台下拉与空态文案）；单平台渠道界面不显示下拉。 */
  platforms: PublishPlatform[];
  /** 页签下方一句话：谁在提交、需要什么前置条件。 */
  hint: string;
  /** 空态里可照抄的入口。 */
  emptyHint: string;
}

export const PUBLISH_CHANNELS: PublishChannel[] = [
  {
    id: 'douyin-note',
    label: '抖音图文',
    contentType: 'note',
    platforms: ['douyin'],
    hint: '由外部 sau 引擎自动提交到抖音；提交前必经预览，提交后需人工核实再「标记已发布」。',
    emptyHint: '还没有抖音图文包：到作品详情页的成果画布点「创建图文包」（图片可选场景静帧或素材库）。',
  },
  {
    id: 'toutiao-article',
    label: '今日头条文章',
    contentType: 'article',
    platforms: ['toutiao'],
    hint: '由自研执行器自动提交到头条号；先在「设置 → 今日头条」扫码登录，提交前必经预览。',
    emptyHint: '还没有头条文章包：到作品详情页的成果画布点「创建头条文章包」（AI 成文 + 16:9 封面）。',
  },
  {
    id: 'video-manual',
    label: '视频人工交付',
    contentType: 'video',
    platforms: ['douyin', 'xiaohongshu', 'wechat_channels', 'bilibili'],
    hint: '不会自动上传：这里只准备交付包，由人工复制文案后到平台发布，发完点「标记已发布」。',
    emptyHint: '还没有视频交付包：到作品详情页点「加入发布中心」，按向导选平台并生成文案。',
  },
];

export function findPublishChannel(channelId: string): PublishChannel {
  return PUBLISH_CHANNELS.find((channel) => channel.id === channelId) ?? PUBLISH_CHANNELS[0]!;
}

/** 包属于哪个渠道（`contentType` 缺省即视频，与后端同一口径）。 */
export function publishChannelOf(detail: PublishingPackageDetail): PublishChannel {
  const contentType = detail.package.contentType ?? 'video';
  return PUBLISH_CHANNELS.find((channel) => channel.contentType === contentType) ?? PUBLISH_CHANNELS[2]!;
}

export function selectChannelPackages(
  details: PublishingPackageDetail[],
  channelId: PublishChannelId,
): PublishingPackageDetail[] {
  const channel = findPublishChannel(channelId);
  return details.filter((detail) => (detail.package.contentType ?? 'video') === channel.contentType);
}

/**
 * 渠道页签上的数字：各渠道的包数。
 *
 * **垃圾桶里的包不计入**（与后端 `status=all` 只回 active 的口径一致）——
 * 否则「删掉一个图文包」会让渠道数字忽上忽下。
 */
export function countChannelPackages(
  details: PublishingPackageDetail[],
): Record<PublishChannelId, number> {
  const counts = { 'douyin-note': 0, 'toutiao-article': 0, 'video-manual': 0 } as Record<PublishChannelId, number>;
  for (const detail of details) {
    if (detail.package.state === 'trashed') continue;
    counts[publishChannelOf(detail).id] += 1;
  }
  return counts;
}

/**
 * 状态页签的数字：**当前渠道内**按任务计。
 *
 * 与页面既有口径一致（一个包有多个平台任务时各算一次），但修掉了「局部计数」：
 * 计数必须来自**不带状态筛选**的那一次请求，否则「失败」在「待处理」视图里永远显示 0。
 */
export function countStatusesInChannel(
  details: PublishingPackageDetail[],
  channelId: PublishChannelId,
): Record<PublishingListStatus, number> {
  const counts = {
    action: 0,
    all: 0,
    ready: 0,
    scheduled: 0,
    published: 0,
    failed: 0,
    cancelled: 0,
    broken: 0,
    trash: 0,
  } as Record<PublishingListStatus, number>;

  for (const detail of selectChannelPackages(details, channelId)) {
    if (detail.package.state === 'trashed') {
      // 垃圾桶是独立视图：桶里的包只计入 trash，不再计入常规状态。
      counts.trash += 1;
      continue;
    }
    counts.all += 1;
    if (detail.package.assetHealth !== 'healthy') counts.broken += 1;
    if (detail.package.assetHealth === 'broken_video'
      || detail.tasks.some((task) => task.status === 'ready' || task.status === 'failed')) {
      counts.action += 1;
    }
    for (const task of detail.tasks) counts[task.status] += 1;
  }
  return counts;
}

/** 单平台渠道返回空数组 → 界面据此隐藏平台下拉（避免「选了头条却把列表筛空」）。 */
export function channelPlatformOptions(channelId: PublishChannelId): typeof PUBLISHING_PLATFORMS {
  const channel = findPublishChannel(channelId);
  if (channel.platforms.length <= 1) return [];
  return PUBLISHING_PLATFORMS.filter((item) => channel.platforms.includes(item.id));
}

export function channelEmptyHint(channelId: PublishChannelId): string {
  return findPublishChannel(channelId).emptyHint;
}

export function getPublishingActionIds(
  detail: PublishingPackageDetail,
  task: PublishTask,
  role: LocalUserRole,
): PublishingActionId[] {
  if (detail.package.state === 'trashed') {
    return role === 'admin' ? ['restore-package'] : [];
  }
  if (detail.package.state !== 'active') return [];

  const actions: PublishingActionId[] = [
    'copy-title',
    'copy-description',
    'copy-hashtags',
    'copy-full',
  ];
  // 只读预览（spec §14.2）：随时能看一眼「将要发出去的内容」，视频包走这个入口。
  // 与任务状态无关（纯查看），垃圾桶里的包在上面的 early return 已经排除。
  actions.push('preview');
  const healthyVideo = detail.package.assetHealth !== 'broken_video';
  if (healthyVideo && detail.package.videoPath) actions.push('show-in-finder');

  if (task.status === 'published') {
    actions.push('create-version');
    if (role === 'admin') actions.push('withdraw');
  } else {
    // 文章包的正文是**包级** `article.html` 的渲染结果：改任务文案只会让「预览看到的」与
    // 「发出去的」漂移，所以文章任务不提供「编辑文案」（要改就重建文章包）。
    if (isArticlePackage(detail)) actions.push('download-article');
    if (!isArticlePackage(detail)) actions.push('edit-content');
    if (task.status === 'scheduled' || task.status === 'ready') {
      actions.push('schedule');
    }
    if (task.status === 'cancelled' || task.status === 'failed') actions.push('restore');
    if (task.status === 'scheduled' || task.status === 'ready') actions.push('record-failure');
    if (task.status === 'scheduled' || task.status === 'ready' || task.status === 'failed') actions.push('cancel');
    if (task.status === 'ready' && healthyVideo) {
      actions.push('open-platform', 'mark-published');
    }
    // 图文包的自动发布：只有「可以立刻提交」时才给动作，其余情况用 blocker 说明原因。
    if (!getPublishingAutoPublishBlocker(detail, task)) actions.push('auto-publish');
    if (task.autoPublish?.status === 'awaiting_code') actions.push('submit-code');
  }

  if (role === 'admin') actions.push('trash-package');
  return actions;
}

/**
 * 图文自动发布当前是否可用；返回 `null` 表示可用，否则是给操作者看的中文原因。
 *
 * 做成「返回原因」而不是纯布尔：界面要能显示禁用态**为什么**灰掉，
 * 否则用户只会看到一个点不动的按钮（本项目在侧栏折叠上已经吃过一次这个亏）。
 */
/**
 * 与后端 `publishing-store.ts` 的 `AUTO_PUBLISH_STALE_MS` 保持一致。
 *
 * 超过这个时长仍停在 running/awaiting_code 视为「进程已死」：发布请求是同步的，
 * 进程被杀会留下永远 running 的记录，界面若一直按「进行中」灰掉按钮就再也点不动了。
 */
export const AUTO_PUBLISH_STALE_MS = 30 * 60 * 1000;

function autoPublishInFlight(task: PublishTask, now = Date.now()): boolean {
  const record = task.autoPublish;
  if (!record) return false;
  if (record.status !== 'running' && record.status !== 'awaiting_code') return false;
  const startedAt = new Date(record.startedAt).getTime();
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt < AUTO_PUBLISH_STALE_MS;
}

export function getPublishingAutoPublishBlocker(
  detail: PublishingPackageDetail,
  task: PublishTask,
): string | null {
  if (detail.package.state === 'trashed') return '发布包在垃圾桶中，先恢复后再发布';
  if (detail.package.state !== 'active') return '发布包已清理，无法发布';
  const contentType = detail.package.contentType ?? 'video';
  if (contentType === 'article') {
    // 文章通路目前只接入今日头条（服务端是同一张 (内容类型 × 平台) 路由表）。
    if (task.platform !== 'toutiao') return '文章发布目前只支持今日头条';
    // 头条封面必填：缺封面时在这里就说清楚，而不是等提交时才失败。
    if (detail.package.assetHealth === 'missing_cover') {
      return '缺少封面：今日头条要求文章必须有封面，请重新创建文章包并选择封面';
    }
    if (detail.package.assetHealth !== 'healthy') return '文章包资产异常，请先修复后再发布';
    if (autoPublishInFlight(task)) return '自动发布正在进行中，请等本次结束后再试';
    if (task.status === 'published') return '任务已标记为发布，如需改动请先撤回';
    if (task.status === 'cancelled') return '任务已取消，先恢复任务再发布';
    if (task.status === 'scheduled') return '任务已排期，如需立即发布请先取消排期';
    if (task.status !== 'ready' && task.status !== 'failed') return '当前状态不允许自动发布';
    return null;
  }
  if (contentType !== 'note') {
    return '视频包仍走人工交付，不支持自动发布';
  }
  if (detail.package.assetHealth === 'missing_images') {
    return '图文包缺少图片素材，请重新生成视频静帧或从素材库选择图片';
  }
  if (detail.package.assetHealth !== 'healthy') {
    return '图文包资产异常，请先修复后再发布';
  }
  if (detail.package.imagePaths?.length === 0) return '图文包没有图片，无法发布';

  // 同步请求还在跑（或正在等验证码）时不给第二次动作，避免必然 409
  if (autoPublishInFlight(task)) return '自动发布正在进行中，请等本次结束后再试';
  if (task.status === 'published') return '任务已标记为发布，如需改动请先撤回';
  if (task.status === 'cancelled') return '任务已取消，先恢复任务再发布';
  // 排期中的任务不该被「立即发布」绕过；失败后人工重试是既定通路（spec §9：绝不自动重试）
  if (task.status === 'scheduled') return '任务已排期，如需立即发布请先取消排期';
  if (task.status !== 'ready' && task.status !== 'failed') return '当前状态不允许自动发布';
  return null;
}

/** 任务行上的一句话状态提示；没有自动发布记录时返回 `null`。 */
/**
 * 平台中文名（用于「提交到 X」这类用户可见文案）。
 *
 * 以前这些文案把「抖音」写死在字符串里 —— 头条文章任务会显示「正在提交到**抖音**…」，
 * 属于会误导操作者的错平台文案（本项目在「文案指错动作」上已经吃过一次亏）。
 */
export function publishingPlatformLabel(platform: PublishPlatform): string {
  return PUBLISHING_PLATFORMS.find((item) => item.id === platform)?.label ?? platform;
}

/** 自动发布的确认按钮文案（按平台取，不再写死「抖音」）。 */
export function getAutoPublishConfirmLabel(platform: PublishPlatform): string {
  return `确认发布到${publishingPlatformLabel(platform)}`;
}

export function getPublishingAutoPublishHint(task: PublishTask): string | null {
  const record = task.autoPublish;
  if (!record) return null;
  const label = publishingPlatformLabel(task.platform);
  if (record.status === 'running') return `正在提交到${label}…`;
  if (record.status === 'awaiting_code') {
    return '等待短信验证码：请点「提交验证码」填入手机收到的验证码';
  }
  if (record.status === 'succeeded') {
    // 「点了发布但没拿到成功判据」必须显示出来：这是「重复发布」这个最大风险的补偿手段
    //（服务端把原话写进了 message，此前只有展开审计记录才看得到）。
    if ((record.message ?? '').includes('未能')) {
      return `已提交，但未能自动确认：请务必先去${label}后台核实是否已发出，再决定要不要重试，最后点「标记已发布」`;
    }
    return `已提交，请在${label}后台确认后点「标记已发布」`;
  }
  // 外部 CLI 的原始输出带 ANSI 色码（历史记录里已经存了），展示前统一清掉
  return record.message ? `提交失败：${stripAnsi(record.message)}` : '提交失败，请查看审计记录后重试';
}

/**
 * 发布包那一行显示的「下一步」提示。
 *
 * 这段文案必须**只提真实可用的动作**：之前对已取消的任务写「恢复已取消任务或创建新版本」，
 * 但 `create-version` 只在任务处于 `published` 时才会出现在动作列表里 —— 提示词指向一个
 * 不存在的按钮，用户会照着找却找不到（用户实测反馈）。见下方 `canCreateVersion` 判定。
 */
export function publishingNextStep(detail: PublishingPackageDetail): string {
  if (detail.package.state === 'trashed') return '由管理员恢复发布包';
  if (detail.package.assetHealth === 'broken_video') return '视频资产异常，请查看资产说明';
  if (detail.tasks.some((task) => task.status === 'ready')) return '打开平台并完成发布';
  if (detail.tasks.some((task) => task.status === 'failed')) return '处理失败原因并恢复任务';
  if (detail.tasks.some((task) => task.status === 'scheduled')) return '等待排期提醒';
  // 与 `getPublishingActionIds` 保持一致：只有存在已发布任务时「创建新版本」才真的可用
  const canCreateVersion = detail.tasks.some((task) => task.status === 'published');
  if (detail.tasks.every((task) => task.status === 'published')) return '已完成，可创建新版本';
  if (canCreateVersion) return '恢复已取消的任务，或基于已发布版本创建新版本';
  return '恢复已取消的任务后可继续人工发布';
}

export function formatDueNotification(notification: DueNotification): string {
  const planned = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(notification.scheduledAt));
  const roundedMinutes = Math.max(0, Math.round(notification.overdueMs / 60_000));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  const duration = [
    hours > 0 ? `${hours} 小时` : '',
    minutes > 0 || hours === 0 ? `${minutes} 分钟` : '',
  ].filter(Boolean).join(' ');
  return `原计划 ${planned}，已逾期 ${duration}`;
}

export function formatPublishingCopy(copy: PlatformCopy): {
  title: string;
  description: string;
  hashtags: string;
  full: string;
} {
  const title = copy.title.trim();
  const description = copy.description.trim();
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of copy.hashtags) {
    const tag = value.trim().replace(/^#+/u, '').trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  const hashtags = tags.map((tag) => `#${tag}`).join(' ');
  return {
    title,
    description,
    hashtags,
    full: [title, description, hashtags].filter(Boolean).join('\n\n'),
  };
}
