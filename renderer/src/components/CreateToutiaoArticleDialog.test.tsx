/**
 * 创建头条文章包向导（展示壳）的静态渲染用例。
 *
 * 断言的是**用户看得见的关键信息**：AI 走兜底时必须显示、封面阻塞原因必须显示、
 * 有阻塞时创建按钮必须禁用、选项默认值必须摊出来。
 * （真正的接口编排走 `utils/toutiaoArticle.test.ts` 的纯逻辑用例。）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToutiaoArticleFormView } from './CreateToutiaoArticleDialog.js';

const LIMITS = { titleMin: 2, titleMax: 30, bodyChars: 20_000 };
const noop = () => undefined;

test('向导默认展示「三件默认关闭」的选项（微头条同步默认不勾）', () => {
  const html = renderToStaticMarkup(
    <ToutiaoArticleFormView
      source="frames"
      articleTitle="头条文章标题"
      articleBody="## 小标题\n\n正文。"
      options={{ firstPublish: false, declarations: [], crossPostWeitoutiao: false }}
      limits={LIMITS}
      onClose={noop}
      onCreate={noop}
    />,
  );

  assert.match(html, /头条首发：否/u);
  assert.match(html, /同时发布微头条：否/u);
  assert.match(html, /声明：（无）/u);
  assert.match(html, /创建文章包/u);
});

test('AI 走兜底时把提示摊在界面上（绝不静默）', () => {
  const html = renderToStaticMarkup(
    <ToutiaoArticleFormView
      source="frames"
      articleTitle="标题甲乙"
      articleBody="正文。"
      options={{ firstPublish: false, declarations: [], crossPostWeitoutiao: false }}
      limits={LIMITS}
      fallbackMessage="AI 成文暂不可用，已按洗稿要点生成可编辑的兜底结构"
      onClose={noop}
      onCreate={noop}
    />,
  );

  assert.match(html, /AI 成文暂不可用/u);
});

test('封面阻塞与字数错误都要显示，且创建按钮禁用', () => {
  const html = renderToStaticMarkup(
    <ToutiaoArticleFormView
      source="frames"
      articleTitle="甲"
      articleBody="正文。"
      options={{ firstPublish: false, declarations: [], crossPostWeitoutiao: false }}
      limits={LIMITS}
      coverBlocker="这个作品还没有场景静帧"
      fieldErrors={['标题至少 2 字，当前 1 字']}
      onClose={noop}
      onCreate={noop}
    />,
  );

  assert.match(html, /还没有场景静帧/u);
  assert.match(html, /至少 2 字/u);
  assert.match(html, /disabled/u);
});

test('建包成功后只给「关闭」，不再给「创建文章包」（避免重复建包）', () => {
  const html = renderToStaticMarkup(
    <ToutiaoArticleFormView
      source="frames"
      articleTitle="标题甲乙"
      articleBody="正文。"
      options={{ firstPublish: false, declarations: [], crossPostWeitoutiao: false }}
      limits={LIMITS}
      created={{ id: 'pkg-1', version: 2 }}
      onClose={noop}
      onCreate={noop}
    />,
  );

  assert.match(html, /已创建头条文章包 v2/u);
  assert.equal(html.includes('>创建文章包<'), false);
});
