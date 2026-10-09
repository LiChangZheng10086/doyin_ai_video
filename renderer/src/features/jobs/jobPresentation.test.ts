import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getJobVisualState,
  selectActiveJob,
  filterJobOverviews,
  getJobDateRangeError,
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


test('creation dates include both local day boundaries and combine with search/status', () => {
  const date = (day: number, hour = 0, ms = 0) => new Date(2026, 9, day, hour, 0, 0, ms).toISOString();
  const jobs = [
    makeOverview({ id: 'before', createdAt: date(8, 23) }),
    makeOverview({ id: 'start', createdAt: date(9) }),
    makeOverview({ id: 'end', createdAt: new Date(2026, 9, 10, 23, 59, 59, 999).toISOString() }),
    makeOverview({ id: 'after', createdAt: date(11) }),
    makeOverview({ id: 'wrong-status', createdAt: date(9), status: 'done' }),
    makeOverview({ id: 'invalid', createdAt: 'invalid' }),
  ];
  const ids = (from?: string, to?: string) => filterJobOverviews(jobs, '测试', 'processing', { from, to }).map(j => j.id);
  assert.deepEqual(ids('2026-10-09', '2026-10-10'), ['start', 'end']);
  assert.deepEqual(ids('2026-10-09', '2026-10-09'), ['start']);
  assert.deepEqual(ids('2026-10-10'), ['end', 'after']);
  assert.deepEqual(ids(undefined, '2026-10-09'), ['before', 'start']);
  assert.deepEqual(ids(), ['before', 'start', 'end', 'after', 'invalid']);
  assert.deepEqual(filterJobOverviews(jobs, '不匹配', 'all', { from: '2026-10-09' }), []);
  assert.equal(getJobDateRangeError({ from: '2026-10-10', to: '2026-10-09' }), '开始日期不能晚于结束日期');
  assert.deepEqual(ids('2026-10-10', '2026-10-09'), []);
  for (const from of ['2026-02-29', '2026-13-01', '2026-01-32', 'bad']) {
    assert.equal(getJobDateRangeError({ from }), '请输入有效的创建日期');
    assert.deepEqual(ids(from), []);
  }
  assert.equal(getJobDateRangeError({ from: '2024-02-29' }), undefined);
});

test('creation date end follows local midnight over daylight-saving transitions', () => {
  for (const [month, day] of [[2, 8], [10, 1]]) {
    const end = new Date(2026, month, day, 23, 59, 59, 999);
    const next = new Date(2026, month, day + 1);
    const date = `2026-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const jobs = [makeOverview({ id: 'end', createdAt: end.toISOString() }), makeOverview({ id: 'next', createdAt: next.toISOString() })];
    assert.deepEqual(filterJobOverviews(jobs, '', 'all', { from: date, to: date }).map(j => j.id), ['end']);
  }
});
