import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getJobVisualState,
  selectActiveJob,
  filterJobOverviews,
  buildWorkflowSteps,
  buildArtifactStates,
  readStoredViewMode,
} from './jobPresentation.js';
import type { Job, JobOverview } from '../../types/index.js';

// ── Fixtures ──

const baseJob = {
  id: 'job-1',
  sourceUrl: 'https://example.test/video/123',
  status: 'processing' as const,
  stage: 'transcribing' as const,
  workflowMode: 'manual' as const,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T01:00:00Z',
};

function makeJob(overrides: Partial<Job> = {}): Job {
  return { ...baseJob, ...overrides };
}

function makeOverview(overrides: Partial<JobOverview> = {}): JobOverview {
  return {
    ...baseJob,
    preview: {
      displayTitle: '测试作品',
      subtitle: '测试来源',
      sourcePlatform: '抖音',
      summary: '摘要',
      coverTitle: '封面',
      coverUrl: undefined,
      hasTranscript: false,
      hasRewrite: false,
      hasVideoPrompts: false,
      hasVideo: false,
      nextActionLabel: '执行 视频转录',
    },
    ...overrides,
  } as JobOverview;
}

// ── Tests ──

test('getJobVisualState returns correct labels and tones', () => {
  assert.equal(getJobVisualState(makeJob({ status: 'processing' })).label, '处理中');
  assert.equal(getJobVisualState(makeJob({ status: 'failed' })).tone, 'danger');
  assert.equal(getJobVisualState(makeJob({ status: 'done' })).tone, 'success');
  assert.equal(getJobVisualState(makeJob({ status: 'queued', workflowMode: 'manual' })).tone, 'info');
});

test('selectActiveJob picks processing first', () => {
  const done = makeOverview({ id: 'done', status: 'done' });
  const running = makeOverview({ id: 'running', status: 'processing' });
  assert.equal(selectActiveJob([done, running])?.id, running.id);
  assert.equal(selectActiveJob([done])?.id, undefined); // no active
});

test('filterJobOverviews matches status and search', () => {
  const running = makeOverview({ id: 'running', status: 'processing', preview: { ...makeOverview().preview, displayTitle: '系统测试' } });
  const done = makeOverview({ id: 'done', status: 'done', preview: { ...makeOverview().preview, displayTitle: '已完成' } });
  const result = filterJobOverviews([running, done], '系统', 'processing');
  assert.deepEqual(result.map((j) => j.id), [running.id]);
});

test('buildWorkflowSteps shows blocked steps', () => {
  const blockedJob = makeJob({
    steps: {
      transcribe: { status: 'succeeded', attempts: 1 },
      clean: { status: 'pending', attempts: 0 },
      generate_video_prompts: { status: 'pending', attempts: 0 },
      generate_video: { status: 'pending', attempts: 0 },
    },
  });
  const steps = buildWorkflowSteps(blockedJob, null);
  assert.equal(steps[1].status, 'pending');
  assert.equal(steps[1].blocked, false); // transcribe succeeded, so clean is not blocked
  assert.equal(steps[2].blocked, true);
  assert.match(steps[2].actionLabel, /等待 AI 洗稿完成/);
});

test('buildArtifactStates resolves from availability', () => {
  const videoJob = makeJob({
    steps: {
      transcribe: { status: 'succeeded', attempts: 1 },
      clean: { status: 'succeeded', attempts: 1 },
      generate_video_prompts: { status: 'failed', attempts: 3, lastError: '生成失败' },
      generate_video: { status: 'pending', attempts: 0 },
    },
  });
  const availability = {
    transcriptReady: true,
    rewriteReady: true,
    shotsReady: false,
    videoReady: false,
    transcriptError: null,
    rewriteError: null,
    videoError: null,
  };
  const artifacts = buildArtifactStates(videoJob, availability);
  assert.equal(artifacts.find((a) => a.key === 'transcript')?.state, 'ready');
  assert.equal(artifacts.find((a) => a.key === 'script')?.state, 'ready');
  assert.equal(artifacts.find((a) => a.key === 'shots')?.state, 'failed');
  assert.equal(artifacts.find((a) => a.key === 'video')?.state, 'waiting');
});

test('readStoredViewMode returns list for missing/invalid', () => {
  const empty = new Map<string, string>();
  assert.equal(readStoredViewMode({ getItem: (k) => empty.get(k) ?? null } as Storage), 'list');
  assert.equal(readStoredViewMode({ getItem: () => { throw new Error('blocked'); } } as unknown as Storage), 'list');
});
