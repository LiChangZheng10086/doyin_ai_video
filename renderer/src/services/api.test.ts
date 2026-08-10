import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, parseApiError } from './api.js';

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
  const rejectingClient = { request: async () => { throw axiosError; } };
  client.getClient = async () => rejectingClient as Awaited<ReturnType<ApiClient['getClient']>>;
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
