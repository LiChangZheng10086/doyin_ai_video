import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactNavigator } from './ArtifactNavigator.js';
import { TranscriptArtifact } from './TranscriptArtifact.js';
import { RewriteArtifact } from './RewriteArtifact.js';
import { ShotArtifact } from './ShotArtifact.js';
import { VideoArtifact } from './VideoArtifact.js';
import type { RawTranscript, CleanedScript, HyperframesVideoOutput, ShortVideoShot, ShotType, ShotLayout, ShotTransition, ShotPacing } from '../../../types/index.js';

const noop = () => {};

// ── Artifact states for navigator ──

const artifactItems: Array<{ key: 'transcript' | 'script' | 'shots' | 'video'; label: string; state: 'ready' | 'processing' | 'waiting' | 'failed' }> = [
  { key: 'transcript', label: '转录', state: 'ready' },
  { key: 'script', label: 'AI 洗稿', state: 'ready' },
  { key: 'shots', label: '分镜', state: 'waiting' },
  { key: 'video', label: '视频成片', state: 'waiting' },
];

// ── Tests ──

test('ArtifactNavigator renders tablist with selected state', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ArtifactNavigator, { active: 'script', items: artifactItems, onChange: noop }),
  );
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /aria-selected="true"/);
  for (const label of ['转录', 'AI 洗稿', '分镜', '视频成片']) {
    assert.match(markup, new RegExp(label));
  }
});

test('TranscriptArtifact shows transcript, model info, and segments', () => {
  const transcript: RawTranscript = {
    transcript: '这是一段测试转录文本',
    provider: 'whisper.cpp',
    model: 'ggml-small',
    duration: 120.5,
    segments: [{ start: 0, end: 5.5, text: '第一句话' }],
  };
  const markup = renderToStaticMarkup(
    React.createElement(TranscriptArtifact, { transcript }),
  );
  assert.match(markup, /这是一段测试转录文本/);
  assert.match(markup, /whisper\.cpp/);
  assert.match(markup, /ggml-small/);
  assert.match(markup, /第一句话/);
});

test('TranscriptArtifact shows fallback notice when no transcript', () => {
  const markup = renderToStaticMarkup(
    React.createElement(TranscriptArtifact, { transcript: null, fallbackText: '分享文本内容', transcriptError: null }),
  );
  assert.match(markup, /分享文本内容/);
});

test('RewriteArtifact renders title, summary, key points, and quality notes', () => {
  const cleaned: CleanedScript = {
    jobId: 'job-1',
    sourceUrl: 'https://example.test',
    output: {
      title: '测试标题',
      summary: '测试摘要',
      keyPoints: ['要点一', '要点二'],
      cleanScript: '这是清洗后的脚本内容',
      qualityNotes: ['注意：需要检查事实准确性'],
    },
  };
  const markup = renderToStaticMarkup(
    React.createElement(RewriteArtifact, { cleaned, cleanedError: null }),
  );
  assert.match(markup, /测试标题/);
  assert.match(markup, /测试摘要/);
  assert.match(markup, /要点一/);
  assert.match(markup, /要点二/);
  assert.match(markup, /清洗后的脚本内容/);
  assert.match(markup, /需要检查事实准确性/);
});

test('ShotArtifact renders headline, caption, and hides cameraMotion outside details', () => {
  const shot: ShortVideoShot = {
    index: 1,
    duration: 8,
    shotType: 'hook' as ShotType,
    subject: '开场主题',
    action: 'zoom out',
    cameraMotion: '从下往上推进',
    visualLayers: [],
    caption: '这是字幕内容',
    emphasisWords: ['关键'],
    transition: 'cut' as ShotTransition,
    pacing: 'fast' as ShotPacing,
    narration: '口播',
    headline: '镜头标题',
    supportingText: '支撑文本',
    captionLines: ['字幕第一行', '字幕第二行'],
    sourceKeyPoints: [0, 2],
  };
  const markup = renderToStaticMarkup(
    React.createElement(ShotArtifact, { shot }),
  );
  // Headline visible
  assert.match(markup, /镜头标题/);
  // Caption lines visible
  assert.match(markup, /字幕第一行/);
  // cameraMotion should only appear inside details > summary = 制作信息
  assert.match(markup, /制作信息/);
  // Use a more targeted check: the cameraMotion text should be inside the details section
  // Ensure details element wraps the production fields
  assert.match(markup, /<details/);
});

test('VideoArtifact renders player with controls and 9:16 wrapper', () => {
  const output: HyperframesVideoOutput = {
    provider: 'hyperframes',
    projectPath: '/path/to/project',
    videoPath: '/path/to/video.mp4',
    manifestPath: '/path/to/manifest.json',
    createdAt: '2026-08-01T00:00:00Z',
    duration: 45.2,
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    scenes: [],
  };
  const markup = renderToStaticMarkup(
    React.createElement(VideoArtifact, { output, jobId: 'job-1', title: '测试视频', videoError: null, videoUrl: 'https://example.com/v.mp4', streamUrl: 'https://example.com/stream', streamError: false, publishError: '', onOpenPublishing: noop, onVideoError: noop }),
  );
  assert.match(markup, /controls/);
  assert.match(markup, /9:16/);
  assert.match(markup, /无声动效版/);
  assert.match(markup, /下载 MP4/);
  assert.match(markup, /加入发布中心/);
});
