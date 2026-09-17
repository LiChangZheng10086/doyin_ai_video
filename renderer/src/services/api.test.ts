import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, parseApiError, parseJobStepStreamEvent } from './api.js';

test('all publishing API methods reject with one parsed error shape', async () => {
  const axiosError = {
    message: 'Request failed with status code 409',
    response: {
      status: 409,
      data: {
        code: 'publish_revision_conflict',
        message: '源内容已变化，请重新预览',
        details: { currentRevision: 'new' },
      },
    },
  };
  const client = new ApiClient();
  const rejectingClient = { request: async () => { throw axiosError; } } as unknown as Awaited<ReturnType<ApiClient['getClient']>>;
  // Override getClient to return the rejecting mock
  (client as any).getClient = async () => rejectingClient;
  const copy = { title: '标题', description: '正文', hashtags: ['AI'] };
  const calls = [
    () => client.previewPublishing('job-1', ['douyin']),
    () => client.createPublishingPackage({
      sourceJobId: 'job-1',
      previewRevision: 'revision-1',
      title: '作品',
      platforms: [{ platform: 'douyin' as const, copy, copySource: 'ai' as const }],
    }),
    () => client.listPublishingPackages(),
    () => client.getPublishingPackage('package-1'),
    () => client.checkPublishingDue(),
    () => client.createPublishingVersion('package-1', {}),
    () => client.updatePublishingContent('task-1', { ...copy, expectedRevision: 1 }),
    () => client.updatePublishingSchedule('task-1', null),
    () => client.cancelPublishingTask('task-1', { confirmation: true }),
    () => client.restorePublishingTask('task-1', null),
    () => client.markPublishingTaskPublished('task-1', { confirmation: true }),
    () => client.withdrawPublishingTask('task-1', { confirmation: true, reason: '纠正记录' }),
    () => client.recordPublishingFailure('task-1', '平台拒绝上传'),
    () => client.recordPublishingActionError('task-1', 'open_platform', '无法打开平台'),
    () => client.trashPublishingPackage('package-1', { confirmation: true }),
    () => client.restorePublishingPackage('package-1'),
  ];

  for (const call of calls) {
    await assert.rejects(call, (error: Error & Record<string, unknown>) => {
      assert.equal(error.name, 'PublishingApiError');
      assert.equal(error.status, 409);
      assert.equal(error.code, 'publish_revision_conflict');
      assert.equal(error.message, '源内容已变化，请重新预览');
      assert.deepEqual(error.details, { currentRevision: 'new' });
      return true;
    });
  }
});

test('publishing API parser never exposes Axios English when backend omits message', () => {
  assert.deepEqual(parseApiError({
    message: 'Request failed with status code 404',
    response: { status: 404, data: { code: 'publish_package_not_found' } },
  }), {
    status: 404,
    code: 'publish_package_not_found',
    message: '发布请求失败，请稍后重试',
  });
});

test('AI step stream parser accepts valid events and rejects malformed data', () => {
  assert.deepEqual(parseJobStepStreamEvent(JSON.stringify({
    id: 2,
    type: 'preview',
    jobId: 'job-1',
    step: 'clean',
    delta: '第二段',
    text: '第一段第二段',
    model: 'deepseek-chat',
  })), {
    id: 2,
    type: 'preview',
    jobId: 'job-1',
    step: 'clean',
    delta: '第二段',
    text: '第一段第二段',
    model: 'deepseek-chat',
  });
  assert.equal(parseJobStepStreamEvent('{broken'), null);
  assert.equal(parseJobStepStreamEvent(JSON.stringify({ type: 'preview', step: 'transcribe' })), null);
});

test('a session invalidated by a backend restart is reopened and the request replayed', async () => {
  // 会话是内存的（后端重启即失效），登录界面又已移除 —— 客户端必须静默自救，
  // 否则用户会看到属于已移除功能的「请选择当前操作者」。
  const client = new ApiClient();
  await (client as any).initialize();
  const instance = (client as any).client as {
    defaults: { adapter?: unknown };
    request: (config: unknown) => Promise<{ data: unknown }>;
  };
  (client as any).setLocalSession('stale-token');

  const seen: Array<{ url: string; token: unknown }> = [];
  let packageCalls = 0;
  instance.defaults.adapter = async (config: any) => {
    seen.push({ url: String(config.url), token: config.headers?.['X-Local-Session'] ?? (config.headers?.get?.('X-Local-Session') ?? null) });
    if (String(config.url).includes('/api/local-sessions/auto')) {
      return { data: { session: { token: 'fresh-token' } }, status: 200, statusText: 'OK', headers: {}, config };
    }
    packageCalls += 1;
    if (packageCalls === 1) {
      return Promise.reject({
        isAxiosError: true,
        message: 'Request failed with status code 401',
        config,
        response: { status: 401, data: { code: 'local_session_required', message: '请选择当前操作者' }, config },
      });
    }
    return { data: { packages: [] }, status: 200, statusText: 'OK', headers: {}, config };
  };

  const result = await client.listPublishingPackages();

  assert.deepEqual(result, []);
  assert.deepEqual(seen.map((entry) => entry.url), [
    '/api/publishing/packages',
    '/api/local-sessions/auto',
    '/api/publishing/packages',
  ]);
  // 重放时必须带上新 token，否则又会 401
  assert.equal(seen[2].token, 'fresh-token');
});

test('a genuine 401 is surfaced instead of being retried forever', async () => {
  const client = new ApiClient();
  await (client as any).initialize();
  const instance = (client as any).client as { defaults: { adapter?: unknown } };
  (client as any).setLocalSession('token');
  let calls = 0;
  instance.defaults.adapter = async (config: any) => {
    calls += 1;
    return Promise.reject({
      isAxiosError: true,
      message: 'Request failed with status code 401',
      config,
      response: { status: 401, data: { code: 'local_user_pin_invalid' }, config },
    });
  };

  await assert.rejects(client.listPublishingPackages(), (error: unknown) => {
    assert.equal(parseApiError(error).code, 'local_user_pin_invalid');
    return true;
  });
  assert.equal(calls, 1, '非会话失效的 401 不应被重放');
});
