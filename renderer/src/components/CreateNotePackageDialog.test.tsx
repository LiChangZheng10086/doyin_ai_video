import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotePackageForm, type NotePackageFormProps } from './CreateNotePackageDialog.js';
import type { AssetRecord, PublishingPreview } from '../types/index.js';

const noop = () => {};

const LIMITS = { titleMax: 20, descriptionMax: 1000, hashtagMax: 10 };

function libraryImage(id: string, name: string, bytes = 1024): AssetRecord {
  return {
    id,
    kind: 'image',
    filename: `${id}.png`,
    originalName: name,
    bytes,
    width: 1080,
    height: 1920,
    createdAt: '2026-09-17T04:00:00.000Z',
  };
}

function notePreview(overrides: Partial<PublishingPreview> = {}): PublishingPreview {
  return {
    sourceJobId: 'job-1',
    nextVersion: 2,
    previewRevision: 'a'.repeat(64),
    video: { filename: 'video.mp4', size: 1024, width: 1080, height: 1920, duration: 42, coverAvailable: true },
    copies: {},
    expectedPackagePath: '/storage/output/publishing/job-1/v2-preview',
    contentType: 'note',
    imageSource: 'library',
    images: [
      { name: '素材 B.png', size: 2048, assetId: 'asset-b' },
      { name: '素材 A.png', size: 1024, assetId: 'asset-a' },
    ],
    imageLimit: 35,
    copyLimits: LIMITS,
    noteCopy: { title: '抖音图文标题', description: '抖音图文正文', hashtags: ['内容创作'] },
    ...overrides,
  };
}

function formProps(overrides: Partial<NotePackageFormProps> = {}): NotePackageFormProps {
  return {
    source: 'library',
    onSourceChange: noop,
    preview: notePreview(),
    libraryImages: [
      libraryImage('asset-a', '素材 A.png'),
      libraryImage('asset-b', '素材 B.png'),
      libraryImage('asset-c', '素材 C.png'),
    ],
    libraryUrls: { 'asset-a': 'http://localhost:3100/api/assets/asset-a/raw' },
    libraryError: '',
    previewing: false,
    copy: { title: '抖音图文标题', description: '抖音图文正文', hashtags: ['内容创作'] },
    onCopyChange: noop,
    titleCompressed: false,
    selectedImageIds: ['asset-b', 'asset-a'],
    onToggleImage: noop,
    busy: false,
    error: '',
    onCreate: noop,
    onClose: noop,
    ...overrides,
  };
}

test('the note form shows the library grid with selection order badges and the image count', () => {
  const markup = renderToStaticMarkup(React.createElement(NotePackageForm, formProps()));

  // 图片来源二选一，且当前在「素材库选图」
  assert.match(markup, /自动静帧/u);
  assert.match(markup, /素材库选图/u);
  for (const name of ['素材 A.png', '素材 B.png', '素材 C.png']) {
    assert.match(markup, new RegExp(name.replace('.', '\\.'), 'u'));
  }
  // 按选择顺序编号：B 是第 1 张、A 是第 2 张（选择顺序与网格顺序刻意不同）
  assert.match(markup, /aria-label="第 1 张：素材 B\.png"/u);
  assert.match(markup, /aria-label="第 2 张：素材 A\.png"/u);
  // 未选中的不带序号
  assert.doesNotMatch(markup, /aria-label="第 3 张/u);
  assert.match(markup, /已选 2\/35/u);
  // 缩略图用绝对 URL（相对路径在 Electron 里会打到 Vite 代理）
  assert.match(markup, /src="http:\/\/localhost:3100\/api\/assets\/asset-a\/raw"/u);
});

test('the note form blocks creation with a reason and shows the server-provided copy limits', () => {
  const blocked = renderToStaticMarkup(React.createElement(NotePackageForm, formProps({
    selectedImageIds: [],
    preview: notePreview({ images: [] }),
  })));
  assert.match(blocked, /至少选择一张/u);
  assert.match(blocked, /disabled/u);

  const ready = renderToStaticMarkup(React.createElement(NotePackageForm, formProps()));
  // 字数上限来自服务端（20/1000/10），界面只渲染
  assert.match(ready, /6\/20/u);
  assert.match(ready, /创建图文包/u);
  assert.doesNotMatch(ready, /至少选择一张/u);
});

test('the note form explains an empty library and a compressed title', () => {
  const empty = renderToStaticMarkup(React.createElement(NotePackageForm, formProps({
    libraryImages: [],
    selectedImageIds: [],
    preview: notePreview({ images: [] }),
  })));
  // 素材库为空时给的是「去上传」的指引，而不是一个点不动的空网格
  assert.match(empty, /素材/u);
  assert.match(empty, /上传/u);

  const compressed = renderToStaticMarkup(React.createElement(NotePackageForm, formProps({
    source: 'frames',
    selectedImageIds: [],
    titleCompressed: true,
    preview: notePreview({
      imageSource: 'frames',
      images: [{ name: 'frame-00-at-3s.png', size: 512 }, { name: 'frame-01-at-9s.png', size: 512 }],
    }),
  })));
  // 静帧来源列出场景静帧，并标注标题被压缩过（可编辑）
  assert.match(compressed, /frame-00-at-3s\.png/u);
  assert.match(compressed, /已压缩/u);
});
