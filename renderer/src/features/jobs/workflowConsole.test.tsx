import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkflowConsole } from './WorkflowConsole.js';
import { WorkflowStepper } from './WorkflowStepper.js';
import { buildWorkflowSteps } from './jobPresentation.js';
import type { Job, PipelineStep } from '../../types/index.js';

const noop = () => {};

// ── Fixtures ──

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    sourceUrl: 'https://example.test/video/123',
    status: 'queued',
    stage: 'submitted',
    workflowMode: 'manual',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T01:00:00Z',
    ...overrides,
  };
}

const blockedJob = makeJob({
  steps: {
    transcribe: { status: 'succeeded', attempts: 1 },
    clean: { status: 'pending', attempts: 0 },
    generate_video_prompts: { status: 'pending', attempts: 0 },
    generate_video: { status: 'pending', attempts: 0 },
  },
});

const failedJob = makeJob({
  steps: {
    transcribe: { status: 'succeeded', attempts: 1 },
    clean: { status: 'failed', attempts: 3, lastError: 'AI 域名无法解析' },
    generate_video_prompts: { status: 'pending', attempts: 0 },
    generate_video: { status: 'pending', attempts: 0 },
  },
});

const runningJob = makeJob({
  status: 'processing',
  steps: {
    transcribe: { status: 'succeeded', attempts: 1 },
    clean: { status: 'succeeded', attempts: 1 },
    generate_video_prompts: { status: 'running', attempts: 1, progress: 42 },
    generate_video: { status: 'pending', attempts: 0 },
  },
});

// ── Tests ──

test('WorkflowStepper renders four step labels once each', () => {
  const steps = buildWorkflowSteps(blockedJob, null);
  const markup = renderToStaticMarkup(
    React.createElement(WorkflowStepper, { steps }),
  );
  for (const label of ['视频转录', 'AI 洗稿', '生成分镜', '生成视频']) {
    assert.match(markup, new RegExp(label));
  }
  // All four step keys are represented
  assert.equal(steps.length, 4);
});

test('WorkflowConsole shows retry action and error for failed step', () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkflowConsole, {
      job: failedJob,
      runningStep: null,
      actionError: null,
      onRunStep: noop,
    }),
  );
  assert.match(markup, /重试 AI 洗稿/);
  assert.match(markup, /AI 域名无法解析/);
  // Only one primary action button
  const primaryActions = (markup.match(/data-primary-action/g) ?? []).length;
  assert.equal(primaryActions, 1);
});

test('WorkflowConsole shows disabled blocked step', () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkflowConsole, {
      job: blockedJob,
      runningStep: null,
      actionError: null,
      onRunStep: noop,
    }),
  );
  assert.match(markup, /等待 AI 洗稿完成/);
  assert.match(markup, /disabled/);
});

test('WorkflowConsole shows running progress when available', () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkflowConsole, {
      job: runningJob,
      runningStep: null,
      actionError: null,
      onRunStep: noop,
    }),
  );
  assert.match(markup, /42%/);
});
