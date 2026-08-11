import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentPreview } from './ContentPreview.js';
import { ActiveJobStrip } from './ActiveJobStrip.js';
import { JobListToolbar } from './JobListToolbar.js';
import { JobListView } from './JobListView.js';
import { JobCardView } from './JobCardView.js';
import type { JobOverview, PipelineStep } from '../../types/index.js';

const noop = () => {};

// ── Fixtures ──

function makeOverview(overrides: Partial<JobOverview> = {}): JobOverview {
  return {
    id: 'job-1',
    sourceUrl: 'https://example.test/video/123',
    status: 'processing',
    stage: 'generating-video-prompts',
    workflowMode: 'manual',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T01:00:00Z',
    steps: {
      transcribe: { status: 'succeeded', attempts: 1 },
      clean: { status: 'succeeded', attempts: 1 },
      generate_video_prompts: { status: 'running', attempts: 1, progress: 68 },
      generate_video: { status: 'pending', attempts: 0 },
    },
    preview: {
      displayTitle: '测试作品',
      subtitle: '测试来源',
      sourcePlatform: '抖音',
      summary: '这是一个测试摘要',
      coverTitle: '封面标题',
      coverUrl: undefined,
      hasTranscript: true,
      hasRewrite: true,
      hasVideoPrompts: false,
      hasVideo: false,
      currentStep: 'generate_video_prompts' as PipelineStep,
      nextActionLabel: '执行 生成分镜',
    },
    ...overrides,
  } as JobOverview;
}

// ── Tests ──

test('ContentPreview renders title and optional image', () => {
  const withImage = renderToStaticMarkup(
    React.createElement(ContentPreview, { title: '测试标题', imageUrl: 'https://example.com/thumb.jpg' }),
  );
  assert.match(withImage, /<img/);
  assert.match(withImage, /测试标题/);

  const withoutImage = renderToStaticMarkup(
    React.createElement(ContentPreview, { title: '无图作品' }),
  );
  assert.match(withoutImage, /无图作品/);
  // Should not contain generic decorative English labels
  assert.doesNotMatch(withoutImage, /Creative workspace|Video/);
});

test('ActiveJobStrip shows current step, progress percentage, and primary action', () => {
  const running = makeOverview();
  const markup = renderToStaticMarkup(
    React.createElement(ActiveJobStrip, { job: running, onOpen: noop }),
  );
  assert.match(markup, /当前创作/);
  assert.match(markup, /生成分镜/);
  assert.match(markup, /68%/);
  assert.match(markup, /继续创作/);
});

test('ActiveJobStrip shows indeterminate progress bar when progress is absent', () => {
  const noProgress = makeOverview({
    steps: {
      transcribe: { status: 'succeeded', attempts: 1 },
      clean: { status: 'succeeded', attempts: 1 },
      generate_video_prompts: { status: 'running', attempts: 1 },
      generate_video: { status: 'pending', attempts: 0 },
    },
  });
  const markup = renderToStaticMarkup(
    React.createElement(ActiveJobStrip, { job: noProgress, onOpen: noop }),
  );
  // Should still render the strip but without a numeric percentage
  assert.doesNotMatch(markup, /\d+%/);
  assert.match(markup, /继续创作/);
});

test('JobListToolbar renders search, filter pills, and view toggle buttons', () => {
  const markup = renderToStaticMarkup(
    React.createElement(JobListToolbar, {
      query: '',
      filter: 'all',
      viewMode: 'list',
      polling: false,
      onQueryChange: noop,
      onFilterChange: noop,
      onViewModeChange: noop,
    }),
  );
  assert.match(markup, /placeholder="搜索/);
  for (const label of ['全部', '处理中', '失败', '已完成', '待执行']) {
    assert.match(markup, new RegExp(`>${label}<`));
  }
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /aria-label="列表视图"/);
  assert.match(markup, /aria-label="卡片视图"/);
});

test('JobListView renders desktop column headings and no leaked internals', () => {
  const running = makeOverview();
  const markup = renderToStaticMarkup(
    React.createElement(JobListView, { jobs: [running], deletingId: null, onOpen: noop, onRequestDelete: noop }),
  );
  for (const heading of ['作品', '更新时间', '状态', '下一步', '操作']) {
    assert.match(markup, new RegExp(`>${heading}<`));
  }
  assert.doesNotMatch(markup, /Task ID|localhost|后端服务运行中/);
});

test('JobCardView renders cards with title, platform, and artifact row', () => {
  const running = makeOverview();
  const markup = renderToStaticMarkup(
    React.createElement(JobCardView, { jobs: [running], deletingId: null, onOpen: noop, onRequestDelete: noop }),
  );
  assert.match(markup, /测试作品/);
  assert.match(markup, /抖音/);
  assert.match(markup, /测试来源/);
});
