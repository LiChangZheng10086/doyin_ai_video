import type {
  CreatePublishingPackageInput,
  DueNotification,
  HyperframesVideoOutput,
  LocalUserRole,
  PlatformCopy,
  PublishCopySource,
  PublishPlatform,
  PublishTask,
  PublishingListStatus,
  PublishingPackageDetail,
  PublishingPreview,
} from '../types/index.js';

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
  | 'restore-package';

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
  const healthyVideo = detail.package.assetHealth !== 'broken_video';
  if (healthyVideo && detail.package.videoPath) actions.push('show-in-finder');

  if (task.status === 'published') {
    actions.push('create-version');
    if (role === 'admin') actions.push('withdraw');
  } else {
    actions.push('edit-content');
    if (task.status === 'scheduled' || task.status === 'ready') {
      actions.push('schedule');
    }
    if (task.status === 'cancelled' || task.status === 'failed') actions.push('restore');
    if (task.status === 'scheduled' || task.status === 'ready') actions.push('record-failure');
    if (task.status === 'scheduled' || task.status === 'ready' || task.status === 'failed') actions.push('cancel');
    if (task.status === 'ready' && healthyVideo) {
      actions.push('open-platform', 'mark-published');
    }
  }

  if (role === 'admin') actions.push('trash-package');
  return actions;
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
