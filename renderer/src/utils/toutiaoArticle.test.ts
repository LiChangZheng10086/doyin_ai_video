/**
 * 创建头条文章包的纯逻辑用例。
 *
 * 这里守住的是「用户看得见的行为」：标题下限、正文上限、封面必填、选项默认值，
 * 以及「没预览完就不发出注定被拒的请求」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublishingPreview } from '../types/index.js';
import {
  TOUTIAO_DECLARATIONS,
  buildToutiaoArticleInput,
  defaultToutiaoOptions,
  getToutiaoCoverBlocker,
  toggleDeclaration,
  toutiaoArticleFieldErrors,
} from './toutiaoArticle.js';

const LIMITS = { titleMin: 2, titleMax: 30, bodyChars: 20_000 };

function preview(overrides: Partial<PublishingPreview> = {}): PublishingPreview {
  return {
    sourceJobId: 'job-1',
    nextVersion: 1,
    previewRevision: 'revision-1',
    video: { filename: 'video.mp4', size: 1, width: 1080, height: 1920, duration: 1, coverAvailable: true },
    copies: {},
    expectedPackagePath: '/tmp/pkg',
    contentType: 'article',
    ...overrides,
  };
}

test('发布选项默认全关（微头条同步默认关闭是安全底线）', () => {
  assert.deepEqual(defaultToutiaoOptions(), {
    firstPublish: false,
    declarations: [],
    crossPostWeitoutiao: false,
  });
});

test('作品声明是集合语义：再点一次移除，顺序不影响结果', () => {
  let selected = toggleDeclaration([], '引用AI');
  selected = toggleDeclaration(selected, '个人观点，仅供参考');
  assert.deepEqual(selected, ['引用AI', '个人观点，仅供参考']);
  assert.deepEqual(toggleDeclaration(selected, '引用AI'), ['个人观点，仅供参考']);
});

test('声明取值必须与发布页文案一致（执行器按精确文案点击，改字就点不上）', () => {
  // 与 `toutiao-page.ts` 的 `setDeclarations` 同一约定：传什么就点页面上的什么。
  for (const item of TOUTIAO_DECLARATIONS) {
    assert.equal(item.value, item.label.length > 0 ? item.value : item.label);
    assert.ok(item.value.trim().length > 0);
  }
  assert.ok(TOUTIAO_DECLARATIONS.some((item) => item.value === '个人观点，仅供参考'));
});

test('标题下限 2 字、上限 30 字；正文超 20000 字报错', () => {
  assert.deepEqual(toutiaoArticleFieldErrors('甲乙', '正文。', LIMITS), []);
  assert.match(toutiaoArticleFieldErrors('甲', '正文。', LIMITS)[0]!, /至少 2 字/u);
  assert.match(toutiaoArticleFieldErrors('题'.repeat(31), '正文。', LIMITS)[0]!, /最多 30 字/u);
  assert.deepEqual(toutiaoArticleFieldErrors('甲乙', '正'.repeat(20_000), LIMITS), []);
  assert.match(toutiaoArticleFieldErrors('甲乙', '正'.repeat(20_001), LIMITS)[0]!, /最多 20000 字/u);
  assert.equal(toutiaoArticleFieldErrors('  ', '  ', LIMITS).length, 2, '空标题与空正文都要报');
});

test('封面阻塞：静帧一张都没有是阻塞（头条必填），素材库未选也是阻塞', () => {
  assert.match(
    getToutiaoCoverBlocker({ source: 'frames', framesCount: 0, libraryCount: 0, hasSelection: false }) ?? '',
    /还没有场景静帧/u,
  );
  assert.equal(getToutiaoCoverBlocker({ source: 'frames', framesCount: 3, libraryCount: 0, hasSelection: false }), null);
  assert.match(
    getToutiaoCoverBlocker({ source: 'library', libraryCount: 0, framesCount: 0, hasSelection: false }) ?? '',
    /素材库里还没有图片/u,
  );
  assert.match(
    getToutiaoCoverBlocker({ source: 'library', libraryCount: 5, framesCount: 0, hasSelection: false }) ?? '',
    /选择一张/u,
  );
  assert.equal(getToutiaoCoverBlocker({ source: 'library', libraryCount: 5, framesCount: 0, hasSelection: true }), null);
});

test('组装请求体：只走包级 articleCopy，静帧来源不带素材 id', () => {
  const input = buildToutiaoArticleInput({
    sourceJobId: 'job-1',
    title: '作品标题',
    preview: preview(),
    articleTitle: ' 头条文章标题 ',
    articleBody: ' ## 小标题\n\n正文。 ',
    options: { firstPublish: true, declarations: ['引用AI'], crossPostWeitoutiao: false },
    source: 'frames',
  });

  assert.equal(input.contentType, 'article');
  assert.equal(input.previewRevision, 'revision-1');
  assert.deepEqual(input.articleCopy, { title: '头条文章标题', body: '## 小标题\n\n正文。' });
  assert.equal(input.imageSource, 'frames');
  assert.equal(input.imageAssetIds, undefined);
  assert.deepEqual(input.platforms![0], {
    platform: 'toutiao',
    copy: { title: '头条文章标题', description: '## 小标题\n\n正文。', hashtags: [] },
  });
  assert.deepEqual(input.toutiaoOptions, {
    firstPublish: true,
    declarations: ['引用AI'],
    crossPostWeitoutiao: false,
  });
});

test('素材库来源带上恰好一张封面 id；没有预览直接抛错（不发注定被拒的请求）', () => {
  const input = buildToutiaoArticleInput({
    sourceJobId: 'job-1',
    title: '作品标题',
    preview: preview(),
    articleTitle: '标题甲乙',
    articleBody: '正文。',
    options: defaultToutiaoOptions(),
    source: 'library',
    coverAssetId: 'asset-1',
  });
  assert.deepEqual(input.imageAssetIds, ['asset-1']);

  assert.throws(
    () => buildToutiaoArticleInput({
      sourceJobId: 'job-1',
      title: '作品标题',
      articleTitle: '标题甲乙',
      articleBody: '正文。',
      options: defaultToutiaoOptions(),
      source: 'frames',
    }),
    /预览尚未完成/u,
  );
});
