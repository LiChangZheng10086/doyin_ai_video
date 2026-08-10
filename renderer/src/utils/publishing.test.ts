import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ActorSnapshot,
  DeliveryPackage,
  DueNotification,
  PlatformCopy,
  PublishTask,
  PublishingPackageDetail,
} from '../types/index.js';
import {
  filterPublishingPackages,
  formatDueNotification,
  formatPublishingCopy,
  getPublishingActionIds,
  groupPublishingPackages,
} from './publishing.js';
import { desktop } from '../electron-bridge.js';
import { parseApiError } from '../services/api.js';

const publisher: ActorSnapshot = {
  userId: 'publisher-1',
  displayName: '发布者',
  role: 'publisher',
};

function packageDetail(
  sourceJobId: string,
  version: number,
  status: PublishTask['status'] = 'ready',
  overrides: Partial<DeliveryPackage> = {},
): PublishingPackageDetail {
  const packageId = `${sourceJobId}-v${version}`;
  const createdAt = `2026-08-${String(version).padStart(2, '0')}T00:00:00.000Z`;
  return {
    package: {
      id: packageId,
      sourceJobId,
      version,
      state: 'active',
      title: `${sourceJobId} 标题`,
      packagePath: `/publishing/${packageId}`,
      videoPath: `/publishing/${packageId}/video.mp4`,
      videoSha256: 'a'.repeat(64),
      videoSize: 1024,
      videoMethod: 'clone',
      assetHealth: 'healthy',
      createdBy: publisher,
      createdAt,
      updatedAt: createdAt,
      ...overrides,
    },
    tasks: [{
      id: `${packageId}-douyin`,
      packageId,
      platform: 'douyin',
      title: '标题',
      description: '正文',
      hashtags: ['AI'],
      copySource: 'ai',
      status,
      contentRevision: 1,
      createdAt,
      updatedAt: createdAt,
    }],
    audit: [],
  };
}

test('groups packages by source and sorts versions newest first', () => {
  const oldVersion = packageDetail('job-a', 1);
  oldVersion.package.title = '旧标题';
  const newVersion = packageDetail('job-a', 3);
  newVersion.package.title = '新标题';
  const grouped = groupPublishingPackages([
    oldVersion,
    packageDetail('job-b', 1),
    newVersion,
    packageDetail('job-a', 2),
  ]);

  assert.deepEqual(grouped.map((group) => group.sourceJobId), ['job-a', 'job-b']);
  assert.deepEqual(grouped[0].versions.map((detail) => detail.package.version), [3, 2, 1]);
  assert.equal(grouped[0].title, '新标题');
  assert.deepEqual(grouped[1].versions.map((detail) => detail.package.version), [1]);
});

test('action-needed filter includes ready, failed, overdue, and broken packages only', () => {
  const now = new Date('2026-08-10T10:00:00.000Z');
  const scheduledFuture = packageDetail('scheduled-future', 1, 'scheduled');
  scheduledFuture.tasks[0].scheduledAt = '2026-08-10T11:00:00.000Z';
  const scheduledOverdue = packageDetail('scheduled-overdue', 1, 'scheduled');
  scheduledOverdue.tasks[0].scheduledAt = '2026-08-10T09:00:00.000Z';

  const result = filterPublishingPackages([
    packageDetail('ready', 1, 'ready'),
    packageDetail('failed', 1, 'failed'),
    packageDetail('published', 1, 'published'),
    packageDetail('cancelled', 1, 'cancelled'),
    scheduledFuture,
    scheduledOverdue,
    packageDetail('broken', 1, 'published', { assetHealth: 'broken_video' }),
  ], 'action', now);

  assert.deepEqual(result.map((detail) => detail.package.sourceJobId), [
    'ready',
    'failed',
    'scheduled-overdue',
    'broken',
  ]);
});

test('publisher actions exclude administrator-only package actions', () => {
  const detail = packageDetail('job-a', 1, 'ready');

  const publisherActions = getPublishingActionIds(detail, detail.tasks[0], 'publisher');
  const adminActions = getPublishingActionIds(detail, detail.tasks[0], 'admin');

  assert.equal(publisherActions.includes('withdraw'), false);
  assert.equal(publisherActions.includes('trash-package'), false);
  assert.equal(adminActions.includes('trash-package'), true);
});

test('published tasks allow a new version but lock content and schedule', () => {
  const detail = packageDetail('job-a', 1, 'published');
  const actions = getPublishingActionIds(detail, detail.tasks[0], 'admin');

  assert.equal(actions.includes('create-version'), true);
  assert.equal(actions.includes('withdraw'), true);
  assert.equal(actions.includes('edit-content'), false);
  assert.equal(actions.includes('schedule'), false);
});

test('failed tasks expose restore and cancel without invalid direct mutations', () => {
  const detail = packageDetail('job-a', 1, 'failed');
  const actions = getPublishingActionIds(detail, detail.tasks[0], 'publisher');

  assert.equal(actions.includes('restore'), true);
  assert.equal(actions.includes('cancel'), true);
  assert.equal(actions.includes('schedule'), false);
  assert.equal(actions.includes('record-failure'), false);
});

test('formats original planned time and rounded overdue duration in Simplified Chinese', () => {
  const due: DueNotification = {
    taskId: 'task-1',
    packageId: 'package-1',
    platform: 'douyin',
    platformLabel: '抖音',
    title: '待发布视频',
    scheduledAt: '2026-08-10T10:00:00',
    becameReadyAt: '2026-08-10T11:30:31',
    overdueMs: 5_431_000,
  };

  const text = formatDueNotification(due);

  assert.match(text, /原计划.*2026.*8.*10.*10:00/u);
  assert.match(text, /已逾期 1 小时 31 分钟/u);
  assert.equal(/[裏發佈劃]/u.test(text), false);
});

test('copy strings omit empty sections and match backend publish formatting', () => {
  const cases: Array<{ copy: PlatformCopy; expected: ReturnType<typeof formatPublishingCopy> }> = [
    {
      copy: { title: ' 标题 ', description: '', hashtags: ['AI', '#视频'] },
      expected: {
        title: '标题',
        description: '',
        hashtags: '#AI #视频',
        full: '标题\n\n#AI #视频',
      },
    },
    {
      copy: { title: '标题', description: ' 正文 ', hashtags: [] },
      expected: {
        title: '标题',
        description: '正文',
        hashtags: '',
        full: '标题\n\n正文',
      },
    },
    {
      copy: { title: ' 标题 ', description: '   ', hashtags: ['', '##AI', 'AI'] },
      expected: {
        title: '标题',
        description: '',
        hashtags: '#AI',
        full: '标题\n\n#AI',
      },
    },
  ];

  for (const item of cases) {
    assert.deepEqual(formatPublishingCopy(item.copy), item.expected);
  }
});

test('desktop actions explicitly report unavailable outside Electron', async () => {
  assert.deepEqual(desktop.capabilities, {
    openExternal: false,
    showItemInFolder: false,
    showNotification: false,
  });
  assert.deepEqual(await desktop.openExternal('https://example.com'), { available: false });
  assert.deepEqual(await desktop.showItemInFolder('/tmp/video.mp4'), { available: false });
  assert.deepEqual(await desktop.showNotification('待发布', '视频已到计划时间'), { available: false });
});

test('API error parser preserves backend publishing message and code', () => {
  assert.deepEqual(parseApiError({
    response: {
      status: 409,
      data: {
        code: 'publish_revision_conflict',
        message: '源内容已变化，请重新预览',
        details: { currentRevision: 'new' },
      },
    },
  }), {
    code: 'publish_revision_conflict',
    message: '源内容已变化，请重新预览',
    details: { currentRevision: 'new' },
    status: 409,
  });
});
