import type {
  DueNotification,
  LocalUserRole,
  PlatformCopy,
  PublishTask,
  PublishingListStatus,
  PublishingPackageDetail,
} from '../types/index.js';

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

export function filterPublishingPackages(
  details: PublishingPackageDetail[],
  status: PublishingListStatus = 'action',
  now = new Date(),
): PublishingPackageDetail[] {
  return details.filter((detail) => {
    if (status === 'all') return detail.package.state === 'active';
    if (status === 'trash') return detail.package.state === 'trashed';
    if (detail.package.state !== 'active') return false;
    if (status === 'broken') return detail.package.assetHealth === 'broken_video';
    if (status !== 'action') return detail.tasks.some((task) => task.status === status);
    if (detail.package.assetHealth === 'broken_video') return true;
    return detail.tasks.some((task) => (
      task.status === 'ready'
      || task.status === 'failed'
      || (task.status === 'scheduled'
        && Boolean(task.scheduledAt)
        && new Date(task.scheduledAt!).getTime() <= now.getTime())
    ));
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
