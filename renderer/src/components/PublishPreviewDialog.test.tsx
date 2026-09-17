import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublishPreviewDialog, type PublishPreviewDialogPreview } from './PublishPreviewDialog.js';

const noop = () => {};

function notePreview(overrides: Partial<PublishPreviewDialogPreview> = {}): PublishPreviewDialogPreview {
  return {
    package: {
      id: 'package-1',
      sourceJobId: 'job-1',
      version: 2,
      state: 'active',
      title: '图文交付包',
      packagePath: '/storage/output/publishing/job-1/v2-package-1',
      contentType: 'note',
      assetHealth: 'healthy',
      createdBy: { userId: 'user-1', displayName: '发布员', role: 'publisher' },
      createdAt: '2026-08-10T08:00:00.000Z',
      updatedAt: '2026-08-10T08:00:00.000Z',
    },
    previewRevision: 'a'.repeat(64),
    imagePaths: ['images/01.png', 'images/02.png', 'images/03.png'],
    noteCopy: { title: '抖音图文标题', description: '抖音图文正文', hashtags: ['内容创作'] },
    copyChecks: [
      {
        platform: 'douyin',
        scope: 'package',
        label: '抖音',
        title: { actual: 6, limit: 20, over: false },
        description: { actual: 6, limit: 1000, over: false },
        hashtags: { actual: 1, limit: 10, over: false },
        violations: [],
      },
    ],
    tasks: [
      { id: 'task-1', platform: 'douyin', status: 'ready', contentRevision: 1, copy: { title: '抖音图文标题', description: '抖音图文正文', hashtags: ['内容创作'] } },
    ],
    ...overrides,
  };
}

function videoPreview(): PublishPreviewDialogPreview {
  return {
    package: {
      id: 'package-v',
      sourceJobId: 'job-v',
      version: 1,
      state: 'active',
      title: '视频交付包',
      packagePath: '/storage/output/publishing/job-v/v1-package-v',
      contentType: 'video',
      assetHealth: 'missing_cover',
      createdBy: { userId: 'user-1', displayName: '发布员', role: 'publisher' },
      createdAt: '2026-08-10T08:00:00.000Z',
      updatedAt: '2026-08-10T08:00:00.000Z',
    },
    previewRevision: 'b'.repeat(64),
    video: { path: '/storage/output/publishing/job-v/v1-package-v/video.mp4', sha256: 'c'.repeat(64), size: 1024, method: 'copy', hasCover: false },
    copyChecks: [
      {
        platform: 'douyin',
        scope: 'task',
        taskId: 'task-v',
        label: '抖音',
        title: { actual: 40, limit: 55, over: false },
        description: { actual: 10, limit: 1000, over: false },
        hashtags: { actual: 2, limit: 10, over: false },
        violations: [],
      },
    ],
    tasks: [
      { id: 'task-v', platform: 'douyin', status: 'ready', contentRevision: 1, copy: { title: '视频标题', description: '视频正文', hashtags: ['a', 'b'] } },
    ],
  };
}

test('preview dialog renders nothing when closed', () => {
  assert.equal(renderToStaticMarkup(<PublishPreviewDialog open={false} preview={notePreview()} onClose={noop} />), '');
});

test('preview dialog plays the finished video from the resolved absolute URL', () => {
  // 页面负责把成片流解析成绝对 URL 再传进来：相对路径在 Electron 里会打到 Vite 的开发代理 → 黑屏
  const videoUrl = 'http://localhost:60946/api/jobs/job-v/video/stream';
  const html = renderToStaticMarkup(
    <PublishPreviewDialog open preview={videoPreview()} onClose={noop} videoUrl={videoUrl} />,
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /<video/);
  assert.ok(html.includes(videoUrl), '应使用传入的绝对 URL，而不是相对路径');
  assert.doesNotMatch(html, /src="\/api\//, '不能出现以 /api 开头的相对 src');
  // 视频包不渲染图片轮播
  assert.doesNotMatch(html, /\/images\/0/);
});

test('preview dialog shows the note copy text, not just the counters', () => {
  const html = renderToStaticMarkup(<PublishPreviewDialog open preview={notePreview()} onClose={noop} />);

  // spec §14.1：预览的意义就是「看得见将要发出去的内容」，只给字数等于没预览
  assert.match(html, /抖音图文标题/);
  assert.match(html, /抖音图文正文/);
  assert.match(html, /#内容创作/);
});

test('preview dialog shows the per-platform task copy for a video package', () => {
  const html = renderToStaticMarkup(<PublishPreviewDialog open preview={videoPreview()} onClose={noop} />);

  assert.match(html, /视频标题/);
  assert.match(html, /视频正文/);
  assert.match(html, /#a #b/);
});

test('preview dialog marks the whole copy block red when that field is over the limit', () => {
  const over = notePreview({
    noteCopy: { title: '这是一个明显超过二十个字上限的标题示例文案', description: '正文', hashtags: [] },
    copyChecks: [
      {
        platform: 'douyin',
        scope: 'package',
        label: '抖音',
        title: { actual: 21, limit: 20, over: true },
        description: { actual: 2, limit: 1000, over: false },
        hashtags: { actual: 0, limit: 10, over: false },
        violations: [{ platform: 'douyin', field: 'title', actual: 21, limit: 20, message: '抖音标题当前 21 字，最多 20 字' }],
      },
    ],
  });
  const html = renderToStaticMarkup(<PublishPreviewDialog open preview={over} onClose={noop} />);

  // 超限的标题正文本身也要标红（不只是计数）
  assert.match(html, /font-medium text-red-600"[^>]*>这是一个明显超过二十个字上限的标题示例文案/u);
  assert.match(html, /（无）/, '空话题要有占位，不能渲染成空白');
});

test('preview dialog renders every note image slot in order with a position indicator', () => {
  const html = renderToStaticMarkup(<PublishPreviewDialog open preview={notePreview()} onClose={noop} />);

  // 静态渲染拿不到 blob（图片要带会话头单独取），所以这里断言 N 个**有序**占位；
  // 「图真的加载出来了」由 Task 7 的浏览器复核负责（断言 img.naturalWidth > 0）。
  for (const index of [1, 2, 3]) {
    assert.match(html, new RegExp(`第 ${index} / 3 张`));
  }
  assert.match(html, /1\/3/);
  assert.equal((html.match(/第 \d \/ 3 张/g) ?? []).length, 3);
  // 图文包不渲染播放器
  assert.doesNotMatch(html, /<video/);
});

test('preview dialog shows character counts and marks over limit copy in red', () => {
  const ok = renderToStaticMarkup(<PublishPreviewDialog open preview={notePreview()} onClose={noop} />);
  assert.match(ok, /标题 6\/20/);
  assert.match(ok, /正文 6\/1000/);
  assert.doesNotMatch(ok, /text-red-/);

  const over = notePreview({
    noteCopy: { title: '这是一个明显超过二十个字上限的标题示例文案', description: '正文', hashtags: [] },
    copyChecks: [
      {
        platform: 'douyin',
        scope: 'package',
        label: '抖音',
        title: { actual: 21, limit: 20, over: true },
        description: { actual: 2, limit: 1000, over: false },
        hashtags: { actual: 0, limit: 10, over: false },
        violations: [{ platform: 'douyin', field: 'title', actual: 21, limit: 20, message: '抖音标题当前 21 字，最多 20 字' }],
      },
    ],
  });
  const overHtml = renderToStaticMarkup(<PublishPreviewDialog open preview={over} onClose={noop} />);

  assert.match(overHtml, /标题 21\/20/);
  assert.match(overHtml, /text-red-/);
  assert.match(overHtml, /最多 20 字/);
});

test('preview dialog surfaces unhealthy assets prominently and shows the common fields', () => {
  const html = renderToStaticMarkup(
    <PublishPreviewDialog
      open
      preview={notePreview({
        package: { ...notePreview().package, assetHealth: 'missing_images' },
        imagePaths: [],
      })}
      onClose={noop}
      onConfirm={noop}
    />,
  );

  assert.match(html, /缺少图片/);
  assert.match(html, /v2/);
  assert.match(html, /发布员/);
  assert.match(html, /v2-package-1/);
  assert.match(html, /包内没有图片/);
  // 缺图时不给「确认发布」（注意别被 Tailwind 的 `disabled:` 类名骗过去，要断言真的属性）
  assert.match(html, /disabled=""/);
});

test('preview dialog exposes a confirm action that submits the previewed revision', () => {
  const html = renderToStaticMarkup(
    <PublishPreviewDialog open preview={notePreview()} onClose={noop} onConfirm={noop} confirmLabel="确认发布" busy={false} />,
  );

  assert.match(html, /确认发布/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('preview dialog disables the confirm action while submitting', () => {
  const html = renderToStaticMarkup(
    <PublishPreviewDialog open preview={notePreview()} onClose={noop} onConfirm={noop} confirmLabel="确认发布" busy />,
  );

  assert.match(html, /disabled=""/);
});

test('preview dialog tells the operator what is happening while a submission runs', () => {
  const html = renderToStaticMarkup(
    <PublishPreviewDialog open preview={notePreview()} onClose={noop} onConfirm={noop} confirmLabel="确认发布到抖音" busy />,
  );

  // 同步请求要跑 1–3 分钟；没有提示的话界面就是个不动的转圈（用户实测反馈过）
  assert.match(html, /正在提交到抖音/);
  assert.match(html, /不要关闭窗口/);
  assert.match(html, /已用 0 秒/);
  assert.match(html, /role="status"/);
});

test('preview dialog shows no progress note when it is not submitting', () => {
  const html = renderToStaticMarkup(
    <PublishPreviewDialog open preview={notePreview()} onClose={noop} onConfirm={noop} />,
  );

  assert.doesNotMatch(html, /正在提交到抖音/);
});
