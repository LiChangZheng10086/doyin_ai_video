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
  buildCreatePublishingInput,
  createPublishingWizardState,
  filterPublishingPackages,
  formatDueNotification,
  formatPublishingCopy,
  getPublishingActionIds,
  getPublishingScheduleStatus,
  groupPublishingPackages,
  isPublishingEligibleVideo,
  publishingWizardReducer,
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

function publishingPreview(): import('../types/index.js').PublishingPreview {
  return {
    sourceJobId: 'job-1',
    nextVersion: 2,
    previewRevision: 'revision-2',
    video: {
      filename: 'video.mp4',
      size: 12_000_000,
      width: 1080,
      height: 1920,
      duration: 58,
      coverAvailable: true,
    },
    copies: {
      douyin: { title: '抖音标题', description: '抖音正文', hashtags: ['AI'], copySource: 'ai' },
      xiaohongshu: { title: '小红书标题', description: '小红书正文', hashtags: ['创作'], copySource: 'ai' },
      wechat_channels: { title: '视频号标题', description: '视频号正文', hashtags: [], copySource: 'cleaned_fallback' },
      bilibili: { title: 'B站标题', description: 'B站正文', hashtags: ['视频'], copySource: 'ai' },
    },
    expectedPackagePath: '/publishing/job-1/v2-preview',
  };
}

test('wizard cannot leave platform selection when no platform is selected', () => {
  const state = { ...createPublishingWizardState(), step: 'platforms' as const };
  const next = publishingWizardReducer(state, { type: 'advance' });

  assert.equal(next.step, 'platforms');
  assert.equal(next.platformError, '请至少选择一个发布平台');
});

test('wizard preserves an over-limit title and reports its exact field limit', () => {
  const preview = publishingPreview();
  let state = createPublishingWizardState(['xiaohongshu']);
  state = publishingWizardReducer(state, { type: 'load-preview', preview, step: 'copy' });
  const title = '一'.repeat(21);
  state = publishingWizardReducer(state, {
    type: 'edit-draft',
    platform: 'xiaohongshu',
    field: 'title',
    value: title,
  });
  const next = publishingWizardReducer(state, { type: 'advance' });

  assert.equal(next.step, 'copy');
  assert.equal(next.drafts.xiaohongshu?.copy.title, title);
  assert.deepEqual(next.fieldErrors, [{
    platform: 'xiaohongshu',
    field: 'title',
    actual: 21,
    limit: 20,
    message: '小红书标题当前 21 字，最多 20 字',
  }]);
});

test('editing one platform marks only that draft as user edited', () => {
  const preview = publishingPreview();
  let state = createPublishingWizardState(['douyin', 'xiaohongshu']);
  state = publishingWizardReducer(state, { type: 'load-preview', preview, step: 'copy' });
  const xiaohongshuBefore = structuredClone(state.drafts.xiaohongshu);
  state = publishingWizardReducer(state, {
    type: 'edit-draft',
    platform: 'douyin',
    field: 'description',
    value: '只修改抖音正文',
  });

  assert.equal(state.drafts.douyin?.copySource, 'user_edited');
  assert.equal(state.drafts.douyin?.copy.description, '只修改抖音正文');
  assert.deepEqual(state.drafts.xiaohongshu, xiaohongshuBefore);
});

test('replacing Xiaohongshu copy leaves every other platform byte-identical', () => {
  const preview = publishingPreview();
  let state = createPublishingWizardState(['douyin', 'xiaohongshu', 'wechat_channels', 'bilibili']);
  state = publishingWizardReducer(state, { type: 'load-preview', preview, step: 'copy' });
  const otherPlatformsBefore = JSON.stringify({
    douyin: state.drafts.douyin,
    wechat_channels: state.drafts.wechat_channels,
    bilibili: state.drafts.bilibili,
  });
  const refreshedPreview = { ...preview, previewRevision: 'revision-3' };
  state = publishingWizardReducer(state, { type: 'update-preview', preview: refreshedPreview });
  state = publishingWizardReducer(state, {
    type: 'replace-draft',
    platform: 'xiaohongshu',
    draft: {
      copy: { title: '重新生成标题', description: '重新生成正文', hashtags: ['新内容'] },
      copySource: 'ai',
      scheduledAt: '',
    },
  });

  assert.equal(state.drafts.xiaohongshu?.copy.title, '重新生成标题');
  assert.equal(state.preview?.previewRevision, 'revision-3');
  assert.equal(JSON.stringify({
    douyin: state.drafts.douyin,
    wechat_channels: state.drafts.wechat_channels,
    bilibili: state.drafts.bilibili,
  }), otherPlatformsBefore);
});

test('platform schedules independently map only future values to scheduled', () => {
  const now = new Date('2026-08-10T10:00:00');
  const preview = publishingPreview();
  let state = createPublishingWizardState(['douyin', 'xiaohongshu', 'wechat_channels', 'bilibili']);
  state = publishingWizardReducer(state, { type: 'load-preview', preview, step: 'schedule' });
  state = publishingWizardReducer(state, { type: 'set-schedule', platform: 'douyin', value: '' });
  state = publishingWizardReducer(state, { type: 'set-schedule', platform: 'xiaohongshu', value: '2026-08-10T11:00' });
  state = publishingWizardReducer(state, { type: 'set-schedule', platform: 'wechat_channels', value: '2026-08-10T10:00' });
  state = publishingWizardReducer(state, { type: 'set-schedule', platform: 'bilibili', value: '2026-08-10T09:00' });

  const input = buildCreatePublishingInput(state, 'job-1', '作品标题', now);
  const scheduled = Object.fromEntries(input.platforms.map((item) => [item.platform, item.scheduledAt]));
  assert.deepEqual(scheduled, {
    douyin: undefined,
    xiaohongshu: new Date('2026-08-10T11:00').toISOString(),
    wechat_channels: undefined,
    bilibili: undefined,
  });
  assert.equal(getPublishingScheduleStatus('', now), 'ready');
  assert.equal(getPublishingScheduleStatus('2026-08-10T11:00', now), 'scheduled');
  assert.equal(getPublishingScheduleStatus('2026-08-10T10:00', now), 'ready');
  assert.equal(getPublishingScheduleStatus('2026-08-10T09:00', now), 'ready');
  assert.equal('actor' in input, false);
});

test('publishing entry requires a complete usable MP4 output', () => {
  const output: import('../types/index.js').HyperframesVideoOutput = {
    provider: 'hyperframes',
    projectPath: '/project',
    videoPath: '/project/renders/video.mp4',
    manifestPath: '/project/video-source.json',
    createdAt: '2026-08-10T10:00:00.000Z',
    duration: 58,
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    scenes: [],
  };

  assert.equal(isPublishingEligibleVideo(output), true);
  assert.equal(isPublishingEligibleVideo({ ...output, videoPath: '' }), false);
  assert.equal(isPublishingEligibleVideo({ ...output, duration: 0 }), false);
  assert.equal(isPublishingEligibleVideo(null), false);
});
