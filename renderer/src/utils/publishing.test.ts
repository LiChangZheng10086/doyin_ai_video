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
  AUTO_PUBLISH_STALE_MS,
  getPublishingActionIds,
  getPublishingAutoPublishBlocker,
  getPublishingAutoPublishHint,
  buildCreatePublishingInput,
  createPublishingWizardState,
  formatDueNotification,
  formatPublishingCopy,
  getPublishingScheduleStatus,
  publishingNextStep,
  groupPublishingPackages,
  isPublishingEligibleVideo,
  publishingWizardReducer,
} from './publishing.js';
import { desktop } from '../electron-bridge.js';
import { isStaleLocalSession, parseApiError } from '../services/api.js';

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

test('API error parser keeps the backend message for the flattened publishing error', () => {
  // publishingRequest 抛出的是扁平化形状（code/message 直接挂在 error 上，没有 response）。
  // 这条用例守住它：否则界面上所有发布错误都会退化成「发布请求失败，请稍后重试」。
  const flattened = Object.assign(new Error('未配置 sau 可执行文件（sauBinary / SAU_BINARY）。'), {
    code: 'sau_not_configured',
    status: 422,
    details: { hint: 'install' },
    name: 'PublishingApiError',
  });

  assert.deepEqual(parseApiError(flattened), {
    code: 'sau_not_configured',
    message: '未配置 sau 可执行文件（sauBinary / SAU_BINARY）。',
    details: { hint: 'install' },
    status: 422,
  });

  // 普通网络错误不该把英文原文糊到用户脸上，仍走中文兜底
  assert.equal(parseApiError(new Error('Network Error')).message, '发布请求失败，请稍后重试');
});

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
  assert.equal(state.preview?.previewRevision, preview.previewRevision);
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
  assert.equal(input.platforms.some((item) => 'copySource' in item), false);
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

// ─── ② 抖音图文自动发布：动作可见性与状态提示 ────────────────────────────────

function notePackageDetail(
  overrides: { assetHealth?: PublishingPackageDetail['package']['assetHealth']; status?: PublishTask['status']; autoPublish?: PublishTask['autoPublish'] } = {},
): PublishingPackageDetail {
  const detail = packageDetail("job-note", 1);
  return {
    ...detail,
    package: {
      ...detail.package,
      contentType: 'note',
      imagePaths: ['images/01.png', 'images/02.png'],
      noteCopy: { title: '抖音图文标题', description: '抖音图文正文', hashtags: ['内容创作'] },
      assetHealth: overrides.assetHealth ?? 'healthy',
      videoPath: undefined,
    },
    tasks: [{
      ...detail.tasks[0],
      status: overrides.status ?? 'ready',
      ...(overrides.autoPublish ? { autoPublish: overrides.autoPublish } : {}),
    }],
  };
}

test('note packages offer the Douyin auto publish action, video packages do not', () => {
  const note = notePackageDetail();
  assert.ok(getPublishingActionIds(note, note.tasks[0], 'publisher').includes('auto-publish'));

  const video = packageDetail("job-video", 1);
  assert.equal(getPublishingActionIds(video, video.tasks[0], 'publisher').includes('auto-publish'), false);
  assert.match(getPublishingAutoPublishBlocker(video, video.tasks[0]) ?? '', /视频包|人工/);
});

test('auto publish is blocked with a readable reason when the note images are missing', () => {
  const missing = notePackageDetail({ assetHealth: 'missing_images' });

  assert.equal(getPublishingActionIds(missing, missing.tasks[0], 'publisher').includes('auto-publish'), false);
  assert.match(getPublishingAutoPublishBlocker(missing, missing.tasks[0]) ?? '', /图片/);
});

test('auto publish is withheld for published, cancelled and scheduled tasks', () => {
  for (const [status, expected] of [
    ['published', /已发布|标记/],
    ['cancelled', /已取消/],
    ['scheduled', /排期/],
  ] as const) {
    const detail = notePackageDetail({ status });
    assert.equal(
      getPublishingActionIds(detail, detail.tasks[0], 'publisher').includes('auto-publish'),
      false,
      `${status} 不应提供自动发布`,
    );
    assert.match(getPublishingAutoPublishBlocker(detail, detail.tasks[0]) ?? '', expected);
  }
  // 失败后人工重试是本设计的既定通路（spec §9：绝不自动重试，由人再次点击）
  const failed = notePackageDetail({ status: 'failed' });
  assert.ok(getPublishingActionIds(failed, failed.tasks[0], 'publisher').includes('auto-publish'));
  assert.equal(getPublishingAutoPublishBlocker(failed, failed.tasks[0]), null);
});

test('auto publish is withheld inside the trash and for a publisher in a foreign package state', () => {
  const trashed = notePackageDetail();
  trashed.package.state = 'trashed';

  assert.equal(getPublishingActionIds(trashed, trashed.tasks[0], 'publisher').includes('auto-publish'), false);
  assert.match(getPublishingAutoPublishBlocker(trashed, trashed.tasks[0]) ?? '', /垃圾桶/);
});

test('auto publish status hints tell the operator what actually happened', () => {
  const running = notePackageDetail({ autoPublish: { status: 'running', startedAt: '2026-08-10T08:00:00.000Z', attemptId: 'a' } });
  assert.match(getPublishingAutoPublishHint(running.tasks[0]) ?? '', /正在/);

  const awaiting = notePackageDetail({ autoPublish: { status: 'awaiting_code', startedAt: '2026-08-10T08:00:00.000Z', attemptId: 'a' } });
  assert.match(getPublishingAutoPublishHint(awaiting.tasks[0]) ?? '', /验证码/);

  // 退出码 0 只表示「已提交」，必须引导人去抖音后台核对后再点「标记已发布」
  const succeeded = notePackageDetail({ autoPublish: { status: 'succeeded', startedAt: '2026-08-10T08:00:00.000Z', finishedAt: '2026-08-10T08:01:00.000Z', attemptId: 'a', message: '已提交' } });
  assert.equal(getPublishingAutoPublishHint(succeeded.tasks[0]), '已提交，请在抖音后台确认后点「标记已发布」');

  const failed = notePackageDetail({ autoPublish: { status: 'failed', startedAt: '2026-08-10T08:00:00.000Z', finishedAt: '2026-08-10T08:01:00.000Z', attemptId: 'a', message: '预检失败' } });
  assert.match(getPublishingAutoPublishHint(failed.tasks[0]) ?? '', /预检失败/);

  const untouched = notePackageDetail();
  assert.equal(getPublishingAutoPublishHint(untouched.tasks[0]), null);
});

test('a read-only preview entry is offered for both note and video packages', () => {
  // spec §14.2：预览是独立入口，「随时查看」，视频包也走它
  const note = notePackageDetail();
  assert.ok(getPublishingActionIds(note, note.tasks[0], 'publisher').includes('preview'));

  const video = packageDetail('job-video', 1);
  assert.ok(getPublishingActionIds(video, video.tasks[0], 'publisher').includes('preview'));

  // 只读查看与任务状态无关：已发布 / 已取消 / 已排期都仍然可以看一眼
  for (const status of ['published', 'cancelled', 'scheduled', 'failed'] as const) {
    const detail = notePackageDetail({ status });
    assert.ok(
      getPublishingActionIds(detail, detail.tasks[0], 'publisher').includes('preview'),
      `${status} 也应能预览`,
    );
  }

  // 垃圾桶里不给（上面的 early return 已排除）
  const trashed = notePackageDetail();
  trashed.package.state = 'trashed';
  assert.equal(getPublishingActionIds(trashed, trashed.tasks[0], 'admin').includes('preview'), false);
});

test('auto publish is withheld while an attempt is genuinely in flight, but not once it is stale', () => {
  const inFlight = notePackageDetail({
    autoPublish: { status: 'running', startedAt: new Date().toISOString(), attemptId: 'a' },
  });
  assert.equal(getPublishingActionIds(inFlight, inFlight.tasks[0], 'publisher').includes('auto-publish'), false);
  assert.match(getPublishingAutoPublishBlocker(inFlight, inFlight.tasks[0]) ?? '', /正在进行中/);

  // 进程被杀会留下永远 running 的记录；超过阈值必须重新可点，否则按钮永久灰掉
  const stale = notePackageDetail({
    autoPublish: {
      status: 'running',
      startedAt: new Date(Date.now() - AUTO_PUBLISH_STALE_MS - 60_000).toISOString(),
      attemptId: 'dead',
    },
  });
  assert.ok(getPublishingActionIds(stale, stale.tasks[0], 'publisher').includes('auto-publish'));

  // 等验证码时给「提交验证码」，而不是再点一次自动发布
  const awaiting = notePackageDetail({
    autoPublish: { status: 'awaiting_code', startedAt: new Date().toISOString(), attemptId: 'a' },
  });
  const actions = getPublishingActionIds(awaiting, awaiting.tasks[0], 'publisher');
  assert.ok(actions.includes('submit-code'));
  assert.equal(actions.includes('auto-publish'), false);
});

test('the next-step hint never names an action that is not actually offered', () => {
  // 用户实测反馈：已取消的任务提示「恢复已取消任务或创建新版本」，但「创建新版本」只在已发布时才有
  const cancelled = notePackageDetail({ status: 'cancelled' });
  const cancelledActions = getPublishingActionIds(cancelled, cancelled.tasks[0], 'publisher');
  assert.equal(cancelledActions.includes('create-version'), false, '前提：已取消的任务没有创建新版本');
  const hint = publishingNextStep(cancelled);
  assert.match(hint, /恢复/);
  assert.doesNotMatch(hint, /创建新版本/, '提示不得指向一个不存在的按钮');

  // 但真的可用时（存在已发布任务）就该提它
  const mixed = notePackageDetail({ status: 'cancelled' });
  mixed.tasks = [
    mixed.tasks[0],
    { ...mixed.tasks[0], id: 'task-published', status: 'published' },
  ];
  // 动作是**逐任务**判定的：已发布的那一行才有创建新版本，所以前提要在那一行上检查
  const publishedTask = mixed.tasks.find((task) => task.status === 'published')!;
  assert.equal(getPublishingActionIds(mixed, publishedTask, 'publisher').includes('create-version'), true,
    '前提：已发布任务那一行有创建新版本');
  assert.equal(getPublishingActionIds(mixed, mixed.tasks[0], 'publisher').includes('create-version'), false,
    '前提：已取消任务那一行没有创建新版本');
  assert.match(publishingNextStep(mixed), /创建新版本/);
});

test('the next-step hint matches the actions offered for each task status', () => {
  const video = packageDetail('job-video', 1);
  const trashed = { ...video, package: { ...video.package, state: 'trashed' as const } };
  assert.match(publishingNextStep(trashed), /恢复发布包/);

  const ready = notePackageDetail({ status: 'ready' });
  assert.match(publishingNextStep(ready), /打开平台/);

  const failed = notePackageDetail({ status: 'failed' });
  assert.match(publishingNextStep(failed), /恢复任务/);

  const scheduled = notePackageDetail({ status: 'scheduled' });
  assert.match(publishingNextStep(scheduled), /排期/);

  const published = notePackageDetail({ status: 'published' });
  assert.match(publishingNextStep(published), /创建新版本/);
  assert.ok(getPublishingActionIds(published, published.tasks[0], 'publisher').includes('create-version'));
});

test('external CLI colour codes never reach the operator facing hint', () => {
  // 历史数据里真存过带 loguru 色码的 message（用户截图反馈过）
  const task = notePackageDetail({
    autoPublish: {
      status: 'failed',
      startedAt: '2026-08-10T08:00:00.000Z',
      finishedAt: '2026-08-10T08:01:00.000Z',
      attemptId: 'a',
      message: '\u001B[38;2;112;172;222m16:55:12\u001B[0m | \u001B[97m✍️ 开始填标题\u001B[0m \u001B[31mTimeoutError: Timeout 120000ms exceeded\u001B[0m',
    },
  }).tasks[0];

  const hint = getPublishingAutoPublishHint(task)!;

  assert.match(hint, /提交失败/);
  assert.match(hint, /Timeout 120000ms exceeded/, '失败原因必须在提示里可见');
  assert.doesNotMatch(hint, /\u001B\[/u, '不能把 ANSI 控制序列显示给用户');
  assert.doesNotMatch(hint, /38;2;112;172;222/u);
});

// ─── 会话自愈：后端重启后不该再冒「请选择当前操作者」 ──────────────────────

function staleSessionError(overrides: Record<string, unknown> = {}) {
  return {
    response: { status: 401, data: { code: 'local_session_required', message: '请选择当前操作者' } },
    config: { url: '/api/publishing/packages', ...(overrides.config as object ?? {}) },
    ...overrides,
  };
}

test('a session invalidated by a backend restart is recognised and healed once', () => {
  // 会话是内存的：后端重启即失效，而登录界面已移除，客户端必须自动重开会话
  assert.equal(isStaleLocalSession(staleSessionError()), true);

  // 只重放一次，避免死循环
  assert.equal(isStaleLocalSession(staleSessionError({ config: { url: '/api/x', _sessionRetried: true } })), false);

  // 会话接口自身失败不再递归重开
  assert.equal(isStaleLocalSession(staleSessionError({ config: { url: '/api/local-sessions/auto' } })), false);

  // 其它 401（例如真的权限不足）与其它状态码都不该被吞掉重试
  assert.equal(isStaleLocalSession({ response: { status: 401, data: { code: 'local_user_pin_invalid' } }, config: { url: '/api/x' } }), false);
  assert.equal(isStaleLocalSession({ response: { status: 403, data: { code: 'local_session_required' } }, config: { url: '/api/x' } }), false);
  assert.equal(isStaleLocalSession({ response: { status: 409, data: { code: 'publish_revision_conflict' } }, config: { url: '/api/x' } }), false);
  assert.equal(isStaleLocalSession(new Error('Network Error')), false);
  assert.equal(isStaleLocalSession(undefined), false);
});
