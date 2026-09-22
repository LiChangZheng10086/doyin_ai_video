import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ActorSnapshot,
  DeliveryPackage,
  DueNotification,
  PackageContentType,
  PlatformCopy,
  PublishPlatform,
  PublishTask,
  PublishingPackageDetail,
} from '../types/index.js';
import {
  AUTO_PUBLISH_STALE_MS,
  getPublishingActionIds,
  getAutoPublishConfirmLabel,
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
  PUBLISHING_PLATFORMS,
  PUBLISH_CHANNELS,
  channelContentTypes,
  channelEmptyHint,
  contentTypeAfterChannelChange,
  countChannelContentTypes,
  countChannelPackages,
  countStatusesInChannel,
  findPublishChannel,
  selectChannelPackages,
  publishingCopySourceOf,
  publishingOpenPlatformTarget,
  XHS_CREATOR_HOME_URL,
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
  overrides: {
    assetHealth?: PublishingPackageDetail['package']['assetHealth'];
    status?: PublishTask['status'];
    autoPublish?: PublishTask['autoPublish'];
    /** 平台（默认抖音；小红书那条通路要显式给）。 */
    platform?: PublishTask['platform'];
    /** 小红书发布选项（AI 声明 / 是否真提交）。 */
    xhsOptions?: { aiDeclaration: boolean; submit: boolean };
  } = {},
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
      ...(overrides.xhsOptions ? { xhsOptions: overrides.xhsOptions } : {}),
    },
    tasks: [{
      ...detail.tasks[0],
      status: overrides.status ?? 'ready',
      ...(overrides.platform ? { platform: overrides.platform } : {}),
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

  // ⚠️ 2026-09-21 收紧：ready 的**图文**包不再写「打开平台」（那是视频人工交付的动作文案），
  // 而是点名它真实的按钮 —— 并且这里断言那个按钮**确实在动作列表里**（提示与动作不许各说一套）。
  const ready = notePackageDetail({ status: 'ready' });
  assert.match(publishingNextStep(ready), /发布图文到抖音/);
  assert.equal(
    getPublishingActionIds(ready, ready.tasks[0], 'publisher').includes('auto-publish'),
    true,
    '提示点到的按钮必须真的存在',
  );

  // 视频包（人工交付）仍然是「打开平台」。
  const readyVideo = packageDetail('job-video-2', 1);
  assert.match(publishingNextStep(readyVideo), /打开平台/);
  assert.equal(
    getPublishingActionIds(readyVideo, readyVideo.tasks[0], 'publisher').includes('open-platform'),
    true,
  );

  const failed = notePackageDetail({ status: 'failed' });
  assert.match(publishingNextStep(failed), /恢复任务/);

  const scheduled = notePackageDetail({ status: 'scheduled' });
  assert.match(publishingNextStep(scheduled), /排期/);

  const published = notePackageDetail({ status: 'published' });
  assert.match(publishingNextStep(published), /创建新版本/);
  assert.ok(getPublishingActionIds(published, published.tasks[0], 'publisher').includes('create-version'));
});

test('「只填到草稿」的提示不能说「已提交」（用户实测：显示已提交但平台上找不到）', () => {
  // 2026-09-21 实测：点了「填写到小红书（不提交）」后任务显示「已提交，请在小红书后台确认后点标记已发布」，
  // 用户去小红书找内容却找不到 —— 因为那条通路**按设计没有点发布**，内容只在草稿箱里。
  const draftOnly = notePackageDetail({
    platform: 'xiaohongshu',
    xhsOptions: { aiDeclaration: true, submit: false },
    autoPublish: { status: 'succeeded', startedAt: new Date().toISOString(), attemptId: 'a', draftOnly: true },
  });
  const hint = getPublishingAutoPublishHint(draftOnly.tasks[0]) ?? '';
  assert.match(hint, /草稿箱/u, hint);
  assert.equal(hint.includes('已提交'), false, '只填草稿绝不能说已提交');
  assert.match(hint, /没有点发布/u, hint);

  // 老记录（字段出现之前落的）没有 draftOnly —— 但它的 message 是执行器写下的「没有点发布」，
  // 只在**字段缺失**时兜底识别一次，免得用户此刻正看着的那条继续说「已提交」。
  const legacy = notePackageDetail({
    platform: 'xiaohongshu',
    xhsOptions: { aiDeclaration: true, submit: false },
    autoPublish: {
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      attemptId: 'legacy',
      message: '已把标题、正文与 AI 声明填好，内容会由小红书自动存为草稿（本工具没有点「发布」）。\n逐步记录：… → 演练：停在点「发布」之前',
    },
  });
  const legacyHint = getPublishingAutoPublishHint(legacy.tasks[0]) ?? '';
  assert.match(legacyHint, /草稿箱/u, legacyHint);
  assert.equal(legacyHint.includes('已提交'), false, '老记录也不许说已提交');

  // 真提交（没有 draftOnly）仍然是「已提交」，且要求人工核实。
  const submitted = notePackageDetail({
    platform: 'xiaohongshu',
    xhsOptions: { aiDeclaration: true, submit: true },
    autoPublish: { status: 'succeeded', startedAt: new Date().toISOString(), attemptId: 'b' },
  });
  const submittedHint = getPublishingAutoPublishHint(submitted.tasks[0]) ?? '';
  assert.match(submittedHint, /已提交/u, submittedHint);
  assert.match(submittedHint, /标记已发布/u, submittedHint);
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

// ─── 平台清单守卫（渲染层）────────────────────────────────────────────────────
//
// 渲染层是**独立的 TS 工程**（`tsconfig.renderer.json` 只 include `renderer/src`），
// 引用不到 `src/lib` 的平台表，所以这份清单是**第二份真源**、编译器也兜不住它。
// 后端加了平台而这里忘了加的表现是：包建得出来，但界面上看不见、选不到。

test('渲染层平台表与后端平台集合一一对应（新增平台不许漏点）', () => {
  assert.deepEqual(
    PUBLISHING_PLATFORMS.map((item) => item.id).sort(),
    ['bilibili', 'douyin', 'toutiao', 'wechat_channels', 'wechat_mp', 'xiaohongshu'],
  );
});

test('渲染层平台表的微信公众号口径与后端一致（标题 32 / 摘要 120）', () => {
  const policy = PUBLISHING_PLATFORMS.find((item) => item.id === 'wechat_mp');
  assert.ok(policy, '渲染层缺少微信公众号');
  assert.equal(policy.label, '微信公众号');
  assert.equal(policy.titleMax, 32);
  assert.equal(policy.descriptionMax, 120);
  assert.equal(policy.creatorUrl, 'https://mp.weixin.qq.com/');
});

// ─── 今日头条（文章通路）在渲染层的口径 ──────────────────────────────────────

test('渲染层今日头条口径与后端一致（标题 30 / 正文 20000）', () => {
  const policy = PUBLISHING_PLATFORMS.find((item) => item.id === 'toutiao');
  assert.ok(policy, '渲染层缺少今日头条');
  assert.equal(policy.label, '今日头条');
  assert.equal(policy.titleMax, 30);
  assert.equal(policy.descriptionMax, 20000);
  assert.equal(policy.creatorUrl, 'https://mp.toutiao.com/profile_v4/graphic/publish');
});

test('文章包：缺封面时明确禁用并说明原因（头条封面必填）', () => {
  const detail = articlePackageDetail({ assetHealth: 'missing_cover' });
  const task = detail.tasks[0]!;

  const blocker = getPublishingAutoPublishBlocker(detail, task);
  assert.match(blocker ?? '', /封面/u);
  assert.equal(getPublishingActionIds(detail, task, 'publisher').includes('auto-publish'), false);
});

test('文章包：健康时给「提交到头条号」与「下载文章 HTML」，但不给「编辑文案」', () => {
  const detail = articlePackageDetail();
  const task = detail.tasks[0]!;
  const actions = getPublishingActionIds(detail, task, 'publisher');

  assert.equal(getPublishingAutoPublishBlocker(detail, task), null);
  assert.ok(actions.includes('auto-publish'));
  assert.ok(actions.includes('download-article'));
  // 正文是包级 article.html 的渲染结果：改任务文案会让预览与实际发出去的内容漂移
  assert.equal(actions.includes('edit-content'), false);
  // 视频包的行为一字未改（回归）
  assert.ok(getPublishingActionIds(packageDetail('job-1', 1), packageDetail('job-1', 1).tasks[0]!, 'publisher')
    .includes('edit-content'));
});

test('图文任务不给「编辑文案」：图文包的真源是包级 noteCopy，改了也发不出去', () => {
  // 2026-09-21 用户实测发现的假按钮：图文任务上的编辑改了任务文案（界面显示也变了），
  // 但两条图文通路取的都是 `noteCopy ?? task.*` ⇒ 发出去的仍是旧包文案。
  const note = notePackageDetail({ platform: 'xiaohongshu', xhsOptions: { aiDeclaration: true, submit: false } });
  const noteActions = getPublishingActionIds(note, note.tasks[0], 'publisher');
  assert.equal(noteActions.includes('edit-content'), false, '图文任务不该给假按钮');

  // 视频包（人工交付）必须保留：任务文案就是你要复制到平台的那份。
  const video = packageDetail('job-v', 1);
  assert.equal(getPublishingActionIds(video, video.tasks[0], 'publisher').includes('edit-content'), true);

  // 判定函数本身：video 才算「任务文案是真源」。
  assert.equal(publishingCopySourceOf(video), 'task');
  assert.equal(publishingCopySourceOf(note), 'package');
  assert.equal(publishingCopySourceOf(articlePackageDetail()), 'package');
});

test('图文包的「下一步」必须点名真实存在的按钮（用户实测：找不到「发布小红书」）', () => {
  // 只填草稿的包：真实存在的按钮是「填写到小红书（不提交）」，绝不能再写「打开平台并完成发布」。
  const draft = notePackageDetail({ platform: 'xiaohongshu', xhsOptions: { aiDeclaration: true, submit: false } });
  const draftStep = publishingNextStep(draft);
  assert.match(draftStep, /填写到小红书（不提交）/u, draftStep);
  assert.match(draftStep, /草稿/u, draftStep);
  assert.equal(draftStep.includes('打开平台'), false, '不该再指向不存在的按钮');
  // 而且这个按钮**真的在动作列表里**（提示词与动作列表不许各说一套）。
  assert.equal(getPublishingActionIds(draft, draft.tasks[0], 'publisher').includes('fill-xhs'), true);

  // 声明了要提交的包：点名「发布到小红书」。
  const submit = notePackageDetail({ platform: 'xiaohongshu', xhsOptions: { aiDeclaration: true, submit: true } });
  assert.match(publishingNextStep(submit), /发布到小红书/u);
  assert.equal(getPublishingActionIds(submit, submit.tasks[0], 'publisher').includes('submit-xhs'), true);

  // 抖音图文：点名「发布图文到抖音」。
  const douyin = notePackageDetail();
  assert.match(publishingNextStep(douyin), /发布图文到抖音/u);

  // 被闸门拦下时（例如没勾 AI 声明）：按钮不存在，就必须把**原因**写在这一行。
  const blocked = notePackageDetail({ platform: 'xiaohongshu', xhsOptions: { aiDeclaration: false, submit: false } });
  const blockedStep = publishingNextStep(blocked);
  assert.match(blockedStep, /AI合成内容/u, blockedStep);
  assert.equal(getPublishingActionIds(blocked, blocked.tasks[0], 'publisher').some((id) => id.endsWith('-xhs')), false);

  // 视频包（人工交付）一字未改。
  const video = packageDetail('job-v', 1);
  assert.match(publishingNextStep(video), /打开平台并完成发布/u);
});

test('「打开平台」对小红书图文要开草稿箱所在的创作中心首页，而不是「发布新笔记」页', () => {
  // 这套流程（机器只填草稿、人点发布）要求按钮把人送到**草稿箱**；平台表里的 creatorUrl 是
  // `publish/publish`（发布**新**笔记），打开它只会让人以为要重新发一条。
  const note = notePackageDetail({ platform: 'xiaohongshu', xhsOptions: { aiDeclaration: true, submit: false } });
  const target = publishingOpenPlatformTarget(note, note.tasks[0]);
  assert.equal(target.url, XHS_CREATOR_HOME_URL);
  assert.match(target.label, /创作中心/u, target.label);
  assert.equal(target.url.includes('publish/publish'), false, '不许开「发布新笔记」页');

  // 抖音图文 / 视频包仍走平台表里的作品发布页（人工交付＝复制文案后去发布）。
  const douyin = notePackageDetail();
  const douyinTarget = publishingOpenPlatformTarget(douyin, douyin.tasks[0]);
  assert.match(douyinTarget.url, /creator\.douyin\.com/u);
  assert.equal(douyinTarget.label, '打开平台');

  const video = packageDetail('job-v', 1);
  assert.equal(publishingOpenPlatformTarget(video, video.tasks[0]).label, '打开平台');
});

test('文章包 + 非头条任务：明确报「只支持今日头条」而不是静默走错通路', () => {
  const detail = articlePackageDetail();
  const task = { ...detail.tasks[0]!, platform: 'douyin' as const };
  assert.match(getPublishingAutoPublishBlocker(detail, task) ?? '', /只支持今日头条/u);
});

/** 文章包夹具（内容类型 article + 头条任务）。 */
function articlePackageDetail(options: {
  assetHealth?: DeliveryPackage['assetHealth'];
  status?: PublishTask['status'];
  autoPublish?: PublishTask['autoPublish'];
} = {}): PublishingPackageDetail {
  const base = packageDetail('job-1', 1, options.status ?? 'ready');
  const tasks = base.tasks.map((task) => ({
    ...task,
    platform: 'toutiao' as const,
    title: '头条文章标题',
    description: '## 小标题\n\n第一段正文。',
    hashtags: [],
    ...(options.autoPublish ? { autoPublish: options.autoPublish } : {}),
  }));
  return {
    ...base,
    package: {
      ...base.package,
      contentType: 'article',
      coverPath: '/tmp/pkg/cover.jpg',
      assetHealth: options.assetHealth ?? 'healthy',
      articleCopy: { title: '头条文章标题', htmlSha256: 'd'.repeat(64) },
      toutiaoOptions: { firstPublish: false, declarations: [], crossPostWeitoutiao: false },
    },
    tasks,
  };
}

// ─── 文案不许写死平台（头条任务曾被显示成「抖音」）─────────────────────────────

test('自动发布的提示与确认文案按平台取，不再写死「抖音」', () => {
  // 抖音：与改造前的文案逐字一致（回归）。
  const douyinTask = { ...articlePackageDetail().tasks[0]!, platform: 'douyin' as const };
  assert.equal(getAutoPublishConfirmLabel('douyin'), '确认发布到抖音');
  assert.equal(
    getPublishingAutoPublishHint({
      ...douyinTask,
      autoPublish: { status: 'succeeded', startedAt: new Date().toISOString(), attemptId: 'a' },
    }),
    '已提交，请在抖音后台确认后点「标记已发布」',
  );

  // 今日头条：文案必须跟着平台走（以前会显示成「抖音」，属于误导操作者的错平台文案）。
  assert.equal(getAutoPublishConfirmLabel('toutiao'), '确认发布到今日头条');
  assert.equal(
    getPublishingAutoPublishHint({
      ...articlePackageDetail().tasks[0]!,
      autoPublish: { status: 'running', startedAt: new Date().toISOString(), attemptId: 'a' },
    }),
    '正在提交到今日头条…',
  );
  assert.equal(
    getPublishingAutoPublishHint({
      ...articlePackageDetail().tasks[0]!,
      autoPublish: { status: 'succeeded', startedAt: new Date().toISOString(), attemptId: 'a' },
    }),
    '已提交，请在今日头条后台确认后点「标记已发布」',
  );
});

test('每个平台都有中文名（漏掉的表现是界面显示英文枚举值）', () => {
  for (const policy of PUBLISHING_PLATFORMS) {
    assert.ok(policy.label.trim().length > 0, `${policy.id} 缺 label`);
    assert.match(getAutoPublishConfirmLabel(policy.id), new RegExp(policy.label, 'u'));
  }
});

// ─── 发布中心「渠道」页签（2026-09-21 改版：一级 = 平台，二级 = 内容类型）─────────
//
// 这一组守住四件事：
// ① 渠道映射覆盖**每一种可创建的组合**（漏一个，那种包会在所有页签里都看不见）；
// ② 渠道归属按**任务平台**判定，一个包可以同时出现在多个页签；
// ③ 内容类型子页签只在真的有多种类型时才出现；
// ④ 计数只数**当前渠道内**的任务（拿整个包的 tasks 去数会让别的平台的数字漏进来）。

test('渠道清单固定五个，且每个渠道都有可照抄的空态入口', () => {
  assert.deepEqual(PUBLISH_CHANNELS.map((channel) => channel.id), [
    'douyin',
    'xiaohongshu',
    'toutiao',
    'wechat-mp',
    'other',
  ]);
  for (const channel of PUBLISH_CHANNELS) {
    assert.ok(channel.label.length > 0);
    assert.ok(channel.hint.length > 0, `${channel.id} 缺少说明文案`);
    assert.ok(channel.emptyHint.length > 0, `${channel.id} 缺少空态入口文案`);
    assert.ok(channel.platforms.length > 0, `${channel.id} 没有对应平台`);
    assert.ok(channel.contentTypes.length > 0, `${channel.id} 没有声明内容类型`);
  }
  // 空态要指向**具体入口**，不能只说「暂无数据」。
  assert.match(channelEmptyHint('douyin'), /创建图文包/u);
  assert.match(channelEmptyHint('xiaohongshu'), /创建图文包/u);
  assert.match(channelEmptyHint('toutiao'), /创建头条文章包/u);
  assert.match(channelEmptyHint('other'), /加入发布中心/u);
  // 未接入的渠道必须**明说**，不能让人以为它已经在自动发布。
  assert.match(channelEmptyHint('wechat-mp'), /尚未接入/u);
  assert.match(
    PUBLISH_CHANNELS.find((channel) => channel.id === 'other')!.hint,
    /不会自动上传/u,
  );
  // 微信公众号是**用户要求先划分好**的占位页签：`automation: false` 必须是真的。
  assert.equal(PUBLISH_CHANNELS.find((channel) => channel.id === 'wechat-mp')!.automation, false);
});

test('每一种可创建的「内容类型 × 平台」组合都唯一落在某个渠道里', () => {
  // 为什么要有这条：`CreatePublishPackageDialog` 的平台步骤是把 `PUBLISHING_PLATFORMS`
  // **全量**列出来的（含今日头条、微信公众号），所以「头条视频」「公众号视频」这类包真的存在；
  // 渠道声明里漏掉 `video`，那些包就会在**所有**页签里都看不见 —— 静默丢数据，最难发现的那种 bug。
  const creatable: Array<[PackageContentType, PublishPlatform]> = [
    ...PUBLISHING_PLATFORMS.map((item) => ['video', item.id] as [PackageContentType, PublishPlatform]),
    // 图文向导只给抖音与小红书（`NOTE_AUTOMATION_PLATFORMS`）。
    ['note', 'douyin'],
    ['note', 'xiaohongshu'],
    // 文章包目前只有头条入口。
    ['article', 'toutiao'],
  ];

  for (const [contentType, platform] of creatable) {
    const hit = PUBLISH_CHANNELS.filter(
      (channel) => channel.platforms.includes(platform) && channel.contentTypes.includes(contentType),
    );
    assert.equal(
      hit.length,
      1,
      `${contentType} × ${platform} 的渠道归属不是唯一：${hit.map((channel) => channel.id).join(' / ') || '无'}`,
    );
  }
});

test('渠道归属按任务平台判定：同一个包可以出现在多个页签', () => {
  const note = packageDetail('job-n', 1, 'ready', { contentType: 'note' });
  // 一个图文包同时发了抖音与小红书 → 两个页签里都该看到它。
  const multi = packageDetail('job-multi', 1, 'ready', { contentType: 'note' });
  multi.tasks.push({ ...multi.tasks[0]!, id: 'multi-xhs', platform: 'xiaohongshu', status: 'ready' });
  // 存量包没有 `contentType` 字段 —— 按后端口径视为视频，且它的任务在抖音。
  const legacy = packageDetail('job-old', 1);
  const all = [note, multi, legacy];

  assert.deepEqual(selectChannelPackages(all, 'douyin').map((d) => d.package.id), [
    note.package.id,
    multi.package.id,
    legacy.package.id,
  ]);
  assert.deepEqual(selectChannelPackages(all, 'xiaohongshu').map((d) => d.package.id), [multi.package.id]);
  assert.deepEqual(selectChannelPackages(all, 'toutiao'), []);
  // 老包没有 contentType 字段：与后端同一口径，缺省即视频。
  assert.equal(legacy.package.contentType, undefined);
  assert.deepEqual(channelContentTypes(all, 'douyin'), ['note', 'video']);
});

test('渠道筛选可按内容类型收窄（子页签用）', () => {
  const note = packageDetail('job-n', 1, 'ready', { contentType: 'note' });
  const video = packageDetail('job-v', 1, 'ready', { contentType: 'video' });
  const article = packageDetail('job-t', 1, 'ready', { contentType: 'article' });
  // 文章包配置在头条：任务平台也要跟着换，否则它压根不属于这个渠道。
  article.tasks = [{ ...article.tasks[0]!, id: 'article-toutiao', platform: 'toutiao' }];
  const all = [note, video, article];

  assert.deepEqual(
    selectChannelPackages(all, 'douyin', 'note').map((d) => d.package.id),
    [note.package.id],
  );
  assert.deepEqual(
    selectChannelPackages(all, 'douyin', 'video').map((d) => d.package.id),
    [video.package.id],
  );
  // `''` = 全部内容类型。
  assert.equal(selectChannelPackages(all, 'douyin', '').length, 2);
  assert.deepEqual(
    selectChannelPackages(all, 'toutiao', 'article').map((d) => d.package.id),
    [article.package.id],
  );
  assert.deepEqual(selectChannelPackages(all, 'toutiao', 'note'), []);
});

test('渠道计数：各渠道包数，一个包可同时计入多个渠道，垃圾桶不计入', () => {
  const note = packageDetail('job-n', 1, 'ready', { contentType: 'note' });
  const multi = packageDetail('job-multi', 1, 'ready', { contentType: 'note' });
  multi.tasks.push({ ...multi.tasks[0]!, id: 'multi-xhs', platform: 'xiaohongshu', status: 'ready' });
  const video = packageDetail('job-v', 1, 'ready', { contentType: 'video' });
  const article = packageDetail('job-t', 1, 'ready', { contentType: 'article' });
  article.tasks = [{ ...article.tasks[0]!, platform: 'toutiao' }];
  const trashed = packageDetail('job-trash', 1, 'ready', {
    contentType: 'note',
    state: 'trashed',
    deletedAt: '2026-08-20T00:00:00.000Z',
    purgeAt: '2026-09-20T00:00:00.000Z',
  });

  assert.deepEqual(countChannelPackages([note, multi, video, article, trashed]), {
    douyin: 3,
    xiaohongshu: 1,
    toutiao: 1,
    'wechat-mp': 0,
    other: 0,
  });
});

test('内容类型子页签：只有一种类型时只回一种（界面据此不渲染子页签）', () => {
  const note = packageDetail('job-n', 1, 'ready', { contentType: 'note' });
  const video = packageDetail('job-v', 1, 'ready', { contentType: 'video' });

  // 只有图文包 → 单元素数组 → 界面不显示子页签（只含一项的选择是假选择）。
  assert.deepEqual(channelContentTypes([note], 'douyin'), ['note']);
  // 两种都有 → 按**渠道声明**的顺序（note 在 video 前），与数据顺序无关。
  assert.deepEqual(channelContentTypes([note, video], 'douyin'), ['note', 'video']);
  assert.deepEqual(channelContentTypes([video, note], 'douyin'), ['note', 'video']);
  // 别的渠道的包不算数。
  assert.deepEqual(channelContentTypes([note], 'xiaohongshu'), []);
  // 垃圾桶里的包不参与「这个渠道有什么类型」。
  const trashedVideo = packageDetail('job-tv', 1, 'ready', {
    contentType: 'video',
    state: 'trashed',
    deletedAt: '2026-08-20T00:00:00.000Z',
    purgeAt: '2026-09-20T00:00:00.000Z',
  });
  assert.deepEqual(channelContentTypes([note, trashedVideo], 'douyin'), ['note']);
  // 子页签上的包数。
  assert.deepEqual(countChannelContentTypes([note, video], 'douyin'), { note: 1, video: 1 });
});

test('内容类型子页签：声明漏了的类型也要出现（宁可标签不好看，也不能把包藏起来）', () => {
  // 「其它平台」只声明了 video，但万一将来出现一条 B站文章包，它也必须在界面上有个位置。
  const article = packageDetail('job-x', 1, 'ready', { contentType: 'article' });
  article.tasks = [{ ...article.tasks[0]!, platform: 'bilibili' }];
  assert.deepEqual(channelContentTypes([article], 'other'), ['article']);
  assert.deepEqual(selectChannelPackages([article], 'other', 'article').map((d) => d.package.id), [
    article.package.id,
  ]);
});

test('换渠道后内容类型子页签：新渠道里还有就留着，没有就回到「全部」', () => {
  const note = packageDetail('job-n', 1, 'ready', { contentType: 'note' });
  const multi = packageDetail('job-multi', 1, 'ready', { contentType: 'note' });
  multi.tasks.push({ ...multi.tasks[0]!, id: 'multi-xhs', platform: 'xiaohongshu', status: 'ready' });
  const all = [note, multi];

  // 抖音 → 小红书：两边都有图文包 → 保留子页签选择。
  assert.equal(contentTypeAfterChannelChange(all, 'xiaohongshu', 'note'), 'note');
  // 抖音 → 头条：头条没有图文包 → 回到「全部」，否则会是一屏空列表。
  assert.equal(contentTypeAfterChannelChange(all, 'toutiao', 'note'), '');
  // 「全部」永远是「全部」。
  assert.equal(contentTypeAfterChannelChange(all, 'toutiao', ''), '');
});

test('状态计数：只数当前渠道内的任务（别的平台的任务不许漏进这个页签）', () => {
  const noteReady = packageDetail('job-n', 1, 'ready', { contentType: 'note' });
  const article = packageDetail('job-t', 1, 'ready', { contentType: 'article' });
  article.tasks = [{ ...article.tasks[0]!, platform: 'toutiao' }];
  // 一个图文包两个平台任务：抖音 ready + 小红书 scheduled。
  const multi = packageDetail('job-multi', 1, 'ready', { contentType: 'note' });
  multi.tasks.push({ ...multi.tasks[0]!, id: 'multi-xhs', platform: 'xiaohongshu', status: 'scheduled' });

  const douyin = countStatusesInChannel([noteReady, article, multi], 'douyin');
  assert.equal(douyin.ready, 2);
  // ⚠️ 关键：小红书那条 scheduled **不能**出现在抖音页签里。
  assert.equal(douyin.scheduled, 0);
  assert.equal(douyin.all, 2);

  const xhs = countStatusesInChannel([noteReady, article, multi], 'xiaohongshu');
  assert.equal(xhs.scheduled, 1);
  assert.equal(xhs.ready, 0);
  assert.equal(xhs.all, 1);

  // 头条那篇不该被算进抖音。
  assert.equal(countStatusesInChannel([noteReady, article], 'toutiao').ready, 1);
});

test('状态计数：按内容类型子页签收窄，且垃圾桶/资产异常口径不变', () => {
  const note = packageDetail('job-n', 1, 'ready', { contentType: 'note' });
  const videoFailed = packageDetail('job-v', 1, 'failed', { contentType: 'video' });
  const broken = packageDetail('job-b', 1, 'ready', { contentType: 'note', assetHealth: 'missing_images' });
  const trashed = packageDetail('job-t', 1, 'ready', {
    contentType: 'note',
    state: 'trashed',
    deletedAt: '2026-08-20T00:00:00.000Z',
    purgeAt: '2026-09-20T00:00:00.000Z',
  });
  const all = [note, videoFailed, broken, trashed];

  // 收窄到图文：视频那条 failed 不计入。
  const notes = countStatusesInChannel(all, 'douyin', 'note');
  assert.equal(notes.ready, 2);
  assert.equal(notes.failed, 0);
  assert.equal(notes.broken, 1);
  assert.equal(notes.trash, 1);
  // 垃圾桶里的包不再计入常规状态（与后端 `status=all` 只回 active 一致）。
  assert.equal(notes.all, 2);

  // 不收窄时两条都在。
  const everything = countStatusesInChannel(all, 'douyin');
  assert.equal(everything.failed, 1);
  assert.equal(everything.all, 3);
  assert.equal(everything.broken, 1);
  assert.equal(everything.trash, 1);
});

// ─── ⑤ 小红书图文（Task 8）：两个动作的可见性与本地闸门 ──────────────────────

test('小红书图文：`fill-xhs` 永远可用，`submit-xhs` 只在包声明了要提交时才给', () => {
  // 只填草稿的包：只能「填写到小红书（不提交）」。
  const draft = notePackageDetail({
    platform: 'xiaohongshu',
    xhsOptions: { aiDeclaration: true, submit: false },
  });
  assert.deepEqual(
    getPublishingActionIds(draft, draft.tasks[0], 'publisher').filter((id) => id.endsWith('-xhs')),
    ['fill-xhs'],
  );

  // 声明了要提交的包：两个都给（`submit-xhs` 才真的会点发布）。
  const willSubmit = notePackageDetail({
    platform: 'xiaohongshu',
    xhsOptions: { aiDeclaration: true, submit: true },
  });
  assert.deepEqual(
    getPublishingActionIds(willSubmit, willSubmit.tasks[0], 'publisher').filter((id) => id.endsWith('-xhs')),
    ['fill-xhs', 'submit-xhs'],
  );

  // 抖音图文仍走原来的 `auto-publish`，绝不给小红书动作。
  const douyin = notePackageDetail();
  const douyinActions = getPublishingActionIds(douyin, douyin.tasks[0], 'publisher');
  assert.equal(douyinActions.includes('auto-publish'), true);
  assert.equal(douyinActions.some((id) => id.endsWith('-xhs')), false);
});

test('小红书图文：没勾 AI 声明 → 两个动作都不给，且禁用原因说明是合规要求', () => {
  const blocked = notePackageDetail({
    platform: 'xiaohongshu',
    xhsOptions: { aiDeclaration: false, submit: false },
  });
  const actions = getPublishingActionIds(blocked, blocked.tasks[0], 'publisher');
  assert.equal(actions.some((id) => id.endsWith('-xhs')), false);
  assert.match(getPublishingAutoPublishBlocker(blocked, blocked.tasks[0]) ?? '', /AI合成内容/u);
  assert.match(getPublishingAutoPublishBlocker(blocked, blocked.tasks[0]) ?? '', /限制分发/u);
});

test('小红书图文：包里没有 xhsOptions（老包）同样被拦住，而不是默认放行', () => {
  const legacy = notePackageDetail({ platform: 'xiaohongshu' });
  assert.equal(
    getPublishingActionIds(legacy, legacy.tasks[0], 'publisher').some((id) => id.endsWith('-xhs')),
    false,
  );
  assert.match(getPublishingAutoPublishBlocker(legacy, legacy.tasks[0]) ?? '', /AI合成内容/u);
});

test('抖音 / 小红书渠道：文案必须写明风险自负，且小红书要说明默认只填到草稿', () => {
  const douyin = findPublishChannel('douyin');
  const xhs = findPublishChannel('xiaohongshu');
  assert.equal(douyin.label, '抖音');
  assert.equal(xhs.label, '小红书');
  assert.deepEqual(xhs.platforms, ['xiaohongshu']);
  // 风险告知是**必须出现**的产品文案（调研结论：不能承诺安全）。
  for (const channel of [douyin, xhs]) {
    assert.match(channel.hint, /风险由你的账号承担/u);
    assert.match(channel.hint, /不会自动上传/u, '视频那条必须写明不会自动上传');
    // 面向用户的纯文本里不许出现 markdown 记号（React 会原样渲染成星号）。
    assert.equal(channel.hint.includes('**'), false);
  }
  assert.match(xhs.hint, /草稿/u, '必须说明小红书默认只填到草稿');
});
