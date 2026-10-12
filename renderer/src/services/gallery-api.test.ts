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
  await (client as any).generateGalleryCopy('g', 4);
  assert.deepEqual(calls[0].data, { version: 2, targetLines: 8 });
  assert.deepEqual(calls[1].data, { version: 3, planId: 'p', subtitlesConfirmed: true });
  assert.equal(calls[0].url, '/api/galleries/g/plan');
  assert.equal(calls[1].url, '/api/galleries/g/plan/render');
  assert.equal(calls[0].timeout, 0);
  assert.equal(calls[1].timeout, 0);
  assert.deepEqual(calls[2].data, { version: 4 });
  assert.equal(calls[2].url, '/api/galleries/g/copy');
  assert.equal(calls[2].timeout, 0);
});

test('controlled retranscription is separate from repeating a succeeded step', async () => {
  const client = new ApiClient(); const calls: string[] = [];
  client.getClient = async () => ({ post: async (url: string) => {
    calls.push(url); return { data: { job: { id: 'job' } } };
  } }) as any;
  assert.equal((await (client as any).retranscribeJob('job')).id, 'job');
  assert.deepEqual(calls, ['/api/jobs/job/retranscribe']);
});

test('text choices and asynchronous gallery operations retain version, confirmations and operation identity', async () => {
  const client = new ApiClient(); const calls: any[] = [];
  client.getClient = async () => ({ request: async (config: any) => { calls.push(config); return { status: 202, data: { gallery: { id: 'g', operation: { id: 'op' } } } }; } }) as any;
  await (client as any).prepareGalleryContent('g', 2, 8);
  await (client as any).updateGalleryContent('g', 3, 'text', ['a']);
  const accepted = await (client as any).startGalleryOperation('g', { version: 4, kind: 'candidates', contentPlanId: 'text', contentConfirmed: true });
  await (client as any).startGalleryOperation('g', { version: 5, kind: 'render', planId: 'plan', subtitlesConfirmed: true });
  await (client as any).pauseGalleryOperation('g', 'op');
  await (client as any).resumeGalleryOperation('g', 'op');
  assert.equal(accepted.operation.id, 'op');
  assert.deepEqual(calls.map(c => [c.method, c.url, c.data]), [
    ['POST', '/api/galleries/g/content-plan', { version: 2, targetLines: 8 }],
    ['PATCH', '/api/galleries/g/content-plan', { version: 3, contentPlanId: 'text', selectedIds: ['a'] }],
    ['POST', '/api/galleries/g/operation', { version: 4, kind: 'candidates', contentPlanId: 'text', contentConfirmed: true }],
    ['POST', '/api/galleries/g/operation', { version: 5, kind: 'render', planId: 'plan', subtitlesConfirmed: true }],
    ['POST', '/api/galleries/g/operation/pause', { operationId: 'op' }],
    ['POST', '/api/galleries/g/operation/resume', { operationId: 'op' }],
  ]);
  assert.ok(calls.every(c => c.timeout !== 0), 'background work must not hold a long foreground request');
});

test('explicit translated range reaches text preparation while callers can retain the full-video default', async () => {
  const client = new ApiClient(); const calls: any[] = [];
  client.getClient = async () => ({ request: async (config: any) => { calls.push(config); return { data: { gallery: { id: 'g' } } }; } }) as any;
  await (client as any).prepareGalleryContent('g', 2, 8, false);
  assert.deepEqual(calls[0].data, { version: 2, targetLines: 8, fullVideo: false });
});
