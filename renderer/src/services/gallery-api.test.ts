import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from './api.js';

test('gallery plan confirmation sends version and plan identity and allows long local work', async () => {
  const client = new ApiClient();
  const calls: any[] = [];
  client.getClient = async () => ({ request: async (config: any) => {
    calls.push(config); return { data: { gallery: { id: 'g' } } };
  } }) as any;
  await (client as any).planGallery('g', { version: 2, targetLines: 8 });
  await (client as any).renderGalleryPlan('g', 3, 'p', true);
  assert.deepEqual(calls[0].data, { version: 2, targetLines: 8 });
  assert.deepEqual(calls[1].data, { version: 3, planId: 'p', subtitlesConfirmed: true });
  assert.equal(calls[0].url, '/api/galleries/g/plan');
  assert.equal(calls[1].url, '/api/galleries/g/plan/render');
  assert.equal(calls[0].timeout, 0);
  assert.equal(calls[1].timeout, 0);
});

test('controlled retranscription is separate from repeating a succeeded step', async () => {
  const client = new ApiClient(); const calls: string[] = [];
  client.getClient = async () => ({ post: async (url: string) => {
    calls.push(url); return { data: { job: { id: 'job' } } };
  } }) as any;
  assert.equal((await (client as any).retranscribeJob('job')).id, 'job');
  assert.deepEqual(calls, ['/api/jobs/job/retranscribe']);
});
