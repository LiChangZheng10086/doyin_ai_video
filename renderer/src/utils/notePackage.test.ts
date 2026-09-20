import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublishingPreview } from '../types/index.js';
import {
  buildNotePackageInput,
  getNoteImageBlocker,
  noteCopyFieldErrors,
  selectionOrder,
  toggleLibraryImage,
} from './notePackage.js';

const LIMITS = { titleMax: 20, descriptionMax: 1000, hashtagMax: 10 };

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

// ── 素材库多选：顺序就是入包顺序 ──────────────────────────────────

test('toggling a library image appends it in click order and removes it without reordering the rest', () => {
  let selected: string[] = [];
  selected = toggleLibraryImage(selected, 'asset-c', 35);
  selected = toggleLibraryImage(selected, 'asset-a', 35);
  selected = toggleLibraryImage(selected, 'asset-b', 35);
  // 顺序 = 点选顺序（与 id 排序无关）
  assert.deepEqual(selected, ['asset-c', 'asset-a', 'asset-b']);

  // 取消中间一张：剩下的顺序保持不变
  selected = toggleLibraryImage(selected, 'asset-a', 35);
  assert.deepEqual(selected, ['asset-c', 'asset-b']);

  // 再点一次是「选中」而不是「取消另一个」
  selected = toggleLibraryImage(selected, 'asset-a', 35);
  assert.deepEqual(selected, ['asset-c', 'asset-b', 'asset-a']);
});

test('selection order badge numbers follow the click order and are 0 when not selected', () => {
  const selected = ['asset-b', 'asset-a'];

  assert.equal(selectionOrder(selected, 'asset-b'), 1);
  assert.equal(selectionOrder(selected, 'asset-a'), 2);
  assert.equal(selectionOrder(selected, 'asset-c'), 0);
});

test('toggling beyond the image limit keeps the current selection untouched', () => {
  const selected = ['asset-a', 'asset-b'];

  // 已达上限：新点的一张不会被静默塞进去（界面另有「最多 N 张」提示）
  assert.deepEqual(toggleLibraryImage(selected, 'asset-c', 2), ['asset-a', 'asset-b']);
  // 取消仍然可用
  assert.deepEqual(toggleLibraryImage(selected, 'asset-b', 2), ['asset-a']);
});

// ── 提交前的阻塞原因 ────────────────────────────────────────────

test('image blocker explains every reason the package cannot be created yet', () => {
  const base = { framesCount: 11, libraryCount: 3, selectedCount: 2, limit: 35 };

  assert.equal(getNoteImageBlocker({ ...base, source: 'frames' }), null);
  assert.equal(getNoteImageBlocker({ ...base, source: 'library' }), null);

  // 静帧一张都没有：仍然允许建包（② 的口径），但要先说明白
  assert.match(
    getNoteImageBlocker({ ...base, source: 'frames', framesCount: 0 }) ?? '',
    /静帧|生成视频/u,
  );
  // 素材库是空的：引导去上传，而不是让用户对着空网格点
  assert.match(
    getNoteImageBlocker({ ...base, source: 'library', libraryCount: 0 }) ?? '',
    /素材/u,
  );
  // 素材库有图但一张没选：这是「选图」这一步最该被挡住的情况
  assert.match(
    getNoteImageBlocker({ ...base, source: 'library', selectedCount: 0 }) ?? '',
    /至少选择一张/u,
  );
  // 超过平台上限时给出确切的张数与上限
  assert.match(
    getNoteImageBlocker({ ...base, source: 'library', selectedCount: 40, limit: 35 }) ?? '',
    /35/u,
  );
});

// ── 图文口径的本地即时校验（服务端仍会重新校验） ──────────────────

test('note copy field errors mirror the note policy', () => {
  assert.deepEqual(noteCopyFieldErrors({ title: '图文标题', description: '正文', hashtags: ['话题'] }, LIMITS), []);

  assert.match(noteCopyFieldErrors({ title: '   ', description: '正文', hashtags: [] }, LIMITS)[0]!, /标题不能为空/u);

  const tooLongTitle = '这是一个明显超过二十个字上限的抖音图文标题文案';
  assert.ok([...tooLongTitle].length > LIMITS.titleMax, '夹具标题必须真的超过上限');
  const tooLong = noteCopyFieldErrors({ title: tooLongTitle, description: '正文', hashtags: [] }, LIMITS);
  assert.equal(tooLong.length, 1);
  assert.match(tooLong[0]!, /20/u);

  const overTags = noteCopyFieldErrors(
    { title: '标题', description: '正文', hashtags: Array.from({ length: 11 }, (_, index) => `话题${index}`) },
    LIMITS,
  );
  assert.match(overTags[0]!, /话题|10/u);
});

// ── 创建请求体 ──────────────────────────────────────────────────

test('building the create input sends the ordered library ids and the package-level copy', () => {
  const copy = { title: ' 抖音图文标题 ', description: '抖音图文正文', hashtags: ['内容创作', '内容创作', '#效率'] };
  const input = buildNotePackageInput({
    sourceJobId: 'job-1',
    title: '作品标题',
    preview: notePreview(),
    copy,
    source: 'library',
    selectedImageIds: ['asset-b', 'asset-a'],
  });

  assert.equal(input.contentType, 'note');
  assert.equal(input.previewRevision, 'a'.repeat(64));
  // 文案在客户端只做 trim / 去重 / 去 #，字数规则与去重口径由服务端说了算
  assert.deepEqual(input.noteCopy, { title: '抖音图文标题', description: '抖音图文正文', hashtags: ['内容创作', '效率'] });
  assert.deepEqual(input.imageAssetIds, ['asset-b', 'asset-a']);
  assert.equal(input.imageSource, 'library');
  // 图文包的平台任务文案就是包级文案（两处不会漂移）
  assert.deepEqual(input.platforms, [{ platform: 'douyin', copy: input.noteCopy }]);
  // 排期不在这里设置：图文任务先落在「待发布」，由发布中心再改
  assert.equal(input.platforms[0]!.scheduledAt, undefined);
});

test('a frames package never carries library ids and requires a finished preview', () => {
  const frames = buildNotePackageInput({
    sourceJobId: 'job-1',
    title: '作品标题',
    preview: notePreview({ imageSource: 'frames', images: [{ name: 'frame-00-at-3s.png', size: 512 }] }),
    copy: { title: '图文标题', description: '正文', hashtags: [] },
    source: 'frames',
    selectedImageIds: ['asset-a'],
  });

  // 换了来源就不能把上一次的选择带上去（服务端会直接 400）
  assert.equal('imageAssetIds' in frames, false);
  assert.equal(frames.imageSource, 'frames');

  assert.throws(
    () => buildNotePackageInput({
      sourceJobId: 'job-1',
      title: '作品标题',
      preview: undefined,
      copy: { title: '图文标题', description: '正文', hashtags: [] },
      source: 'frames',
      selectedImageIds: [],
    }),
    /预览/u,
  );
});
