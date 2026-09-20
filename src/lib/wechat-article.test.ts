/**
 * 微信兼容 HTML 渲染与文章结构校验测试。
 *
 * 全部是**纯函数**用例：零 IO、零网络、无时间戳、无随机 —— 因此可以断言「同一输入两次渲染逐字节相同」。
 *
 * 规则依据见 spec §4（已逐条核对官方文档）：公众号 `content` **只认内联样式**，
 * `<style>` 块 / `class` / `id` 会失效，**外链图片会被过滤**（`content` 的原文是
 * 「涉及图片 url 必须来源『上传图文消息内的图片获取 URL』接口获取。外部图片 url 将被过滤。」）。
 * 所以「渲染完自己先拦掉非微信托管的图」不是洁癖：等微信去过滤，用户只会看到一篇满是裂图的草稿。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WECHAT_ARTICLE_LIMITS,
  WechatArticleError,
  extractContentImageSources,
  planWechatArticle,
  renderWechatArticleHtml,
  sanitizeWechatHtml,
  substituteWechatImageSlots,
  validateArticleDraft,
  type WechatArticleDraft,
} from "./wechat-article.js";

function draft(overrides: Partial<WechatArticleDraft> = {}): WechatArticleDraft {
  return {
    title: "一篇文章",
    sections: [{ paragraphs: ["第一段。"] }],
    ...overrides,
  };
}

const WECHAT_IMAGE = "https://mmbiz.qpic.cn/mmbiz_jpg/fake/640";

// ── 结构 ──────────────────────────────────────────────────────────────────────

test("段落渲染成 <p> 且带内联样式，顺序保持不变", () => {
  const html = renderWechatArticleHtml(
    draft({ sections: [{ paragraphs: ["甲", "乙", "丙"] }] }),
  );
  assert.match(html, /<p style="[^"]*">甲<\/p>/u);
  assert.match(html, /<p style="[^"]*">乙<\/p>/u);
  assert.match(html, /<p style="[^"]*">丙<\/p>/u);
  assert.ok(html.indexOf("甲") < html.indexOf("乙"));
  assert.ok(html.indexOf("乙") < html.indexOf("丙"));
});

test("heading 渲染成带内联样式的 <h2>，且出现在本段段落之前", () => {
  const html = renderWechatArticleHtml(
    draft({ sections: [{ heading: "小标题", paragraphs: ["正文"] }] }),
  );
  assert.match(html, /<h2 style="[^"]*">小标题<\/h2>/u);
  assert.ok(html.indexOf("小标题") < html.indexOf("正文"));
});

test("没有 heading 的段落不产生空的 <h2>", () => {
  const html = renderWechatArticleHtml(draft({ sections: [{ paragraphs: ["只有正文"] }] }));
  assert.equal(/<h2/u.test(html), false);
});

// ── 清洗 ──────────────────────────────────────────────────────────────────────

test("删掉 <style>/<script>/<svg> 整块与 HTML 注释", () => {
  const html = sanitizeWechatHtml(
    [
      "<style>p{color:red}</style>",
      "<script>alert(1)</script>",
      "<svg><circle r='1'/></svg>",
      "<!-- 这是注释 -->",
      "<p>留下的正文</p>",
    ].join("\n"),
  );
  assert.equal(/<style/iu.test(html), false);
  assert.equal(/<script/iu.test(html), false);
  assert.equal(/<svg/iu.test(html), false);
  assert.equal(/<!--/u.test(html), false);
  assert.match(html, /留下的正文/u);
});

test("渲染结果里不存在任何 <style> 块（微信只认内联样式）", () => {
  const html = renderWechatArticleHtml(
    draft({ sections: [{ heading: "标题", paragraphs: ["<style>p{color:red}</style>正文"] }] }),
  );
  assert.equal(/<style/iu.test(html), false);
  assert.match(html, /style="/u);
});

test("<div> 降级成 <section>", () => {
  const html = sanitizeWechatHtml("<div>内容</div>");
  assert.equal(/<div/iu.test(html), false);
  assert.match(html, /<section[^>]*>内容<\/section>/u);
});

test("删掉 class / id / data-* / on* 属性", () => {
  const html = sanitizeWechatHtml(
    '<p class="a" id="b" data-x="c" onclick="evil()" onmouseover="evil()" style="color:red">正文</p>',
  );
  for (const attribute of ["class=", "id=", "data-x=", "onclick=", "onmouseover="]) {
    assert.equal(html.includes(attribute), false, `不该留下 ${attribute}`);
  }
  // 我们注入的内联样式必须是唯一真源：AI 塞进来的 style 会与排版打架，一并去掉。
  assert.equal(/style="color:red"/u.test(html), false);
  assert.match(html, /正文/u);
});

test("列表改写成 section/p + 内联样式（不用 ul/ol/li）", () => {
  const html = sanitizeWechatHtml("<ul><li>甲</li><li>乙</li></ul><ol><li>丙</li></ol>");
  assert.equal(/<ul|<ol|<li/iu.test(html), false);
  assert.match(html, /甲/u);
  assert.match(html, /乙/u);
  assert.match(html, /丙/u);
  assert.match(html, /<p style="[^"]*"/u);
});

test("白名单外的标签被解开但文字保留（不整段吞掉）", () => {
  const html = sanitizeWechatHtml("<table><tr><td>表格文字</td></tr></table>");
  assert.equal(/<table|<tr|<td/iu.test(html), false);
  assert.match(html, /表格文字/u);
});

test("h1/h3 归一到 h2（公众号正文用统一的小标题层级）", () => {
  const html = sanitizeWechatHtml("<h1>大</h1><h3>小</h3>");
  assert.equal(/<h1|<h3/iu.test(html), false);
  assert.equal((html.match(/<h2/gu) ?? []).length, 2);
});

test("保留 strong/em/blockquote 等行内语义标签", () => {
  const html = sanitizeWechatHtml("<p><strong>粗</strong><em>斜</em></p><blockquote>引用</blockquote>");
  assert.match(html, /<strong>粗<\/strong>/u);
  assert.match(html, /<em>斜<\/em>/u);
  assert.match(html, /<blockquote[^>]*>引用<\/blockquote>/u);
});

test("正文里的公众号文章链接保留，站外链接只留文字", () => {
  const kept = sanitizeWechatHtml('<a href="https://mp.weixin.qq.com/s/abc">公众号文章</a>');
  assert.match(kept, /<a href="https:\/\/mp\.weixin\.qq\.com\/s\/abc"/u);

  // 站外链接在公众号正文里不可点击，留着 href 只会变成一个假的「可点」样式。
  const dropped = sanitizeWechatHtml('<a href="https://evil.example.com/x">站外链接</a>');
  assert.equal(/<a/iu.test(dropped), false);
  assert.match(dropped, /站外链接/u);
});

// ── 图片 ──────────────────────────────────────────────────────────────────────

test("配图按给定顺序插入，并带 max-width:100% 内联样式", () => {
  const html = renderWechatArticleHtml(draft(), {
    images: [
      { url: `${WECHAT_IMAGE}/1` },
      { url: `${WECHAT_IMAGE}/2` },
      { url: `${WECHAT_IMAGE}/3` },
    ],
  });
  assert.match(html, /max-width:100%/u);
  assert.deepEqual(extractContentImageSources(html), [
    `${WECHAT_IMAGE}/1`,
    `${WECHAT_IMAGE}/2`,
    `${WECHAT_IMAGE}/3`,
  ]);
});

test("非微信托管的图片一律丢弃（外链图会被微信过滤成裂图）", () => {
  const html = renderWechatArticleHtml(draft(), {
    images: [
      { url: "https://evil.example.com/a.png" },
      { url: `${WECHAT_IMAGE}/ok` },
      { url: "http://mmbiz.qpic.cn.evil.com/b.png" },
    ],
  });
  // 第三条是「看起来像但其实不是」的域名，必须靠后缀匹配而不是 includes 拦掉。
  assert.deepEqual(extractContentImageSources(html), [`${WECHAT_IMAGE}/ok`]);
});

test("正文里已有的外链 <img> 也会被丢掉，微信托管的保留", () => {
  const html = sanitizeWechatHtml(
    `<p>前<img src="https://evil.example.com/x.png" />后<img src="${WECHAT_IMAGE}/keep" /></p>`,
  );
  assert.deepEqual(extractContentImageSources(html), [`${WECHAT_IMAGE}/keep`]);
});

test("图片带说明时渲染成居中的说明文字", () => {
  const html = renderWechatArticleHtml(draft(), {
    images: [{ url: WECHAT_IMAGE, caption: "图说" }],
  });
  assert.match(html, /图说/u);
  assert.ok(html.indexOf("图说") > html.indexOf("<img"));
});

test("图片多于段落时，余下的按顺序附在文末（不丢图）", () => {
  const html = renderWechatArticleHtml(draft({ sections: [{ paragraphs: ["唯一一段"] }] }), {
    images: [{ url: `${WECHAT_IMAGE}/1` }, { url: `${WECHAT_IMAGE}/2` }],
  });
  assert.deepEqual(extractContentImageSources(html), [`${WECHAT_IMAGE}/1`, `${WECHAT_IMAGE}/2`]);
  assert.ok(html.indexOf("唯一一段") < html.indexOf(`${WECHAT_IMAGE}/1`));
});

test("图片插在对应 section 之后、下一个 section 之前", () => {
  const html = renderWechatArticleHtml(
    draft({
      sections: [
        { heading: "第一节", paragraphs: ["甲"] },
        { heading: "第二节", paragraphs: ["乙"] },
      ],
    }),
    { images: [{ url: `${WECHAT_IMAGE}/1` }, { url: `${WECHAT_IMAGE}/2` }] },
  );
  const first = html.indexOf(`${WECHAT_IMAGE}/1`);
  const second = html.indexOf(`${WECHAT_IMAGE}/2`);
  assert.ok(html.indexOf("甲") < first, "第 1 张图应在第一节之后");
  assert.ok(first < html.indexOf("第二节"), "第 1 张图应在第二节标题之前");
  assert.ok(html.indexOf("乙") < second, "第 2 张图应在第二节之后");
});

// ── 长度校验 ──────────────────────────────────────────────────────────────────

test("WECHAT_ARTICLE_LIMITS 是官方口径的唯一真源", () => {
  assert.equal(WECHAT_ARTICLE_LIMITS.title, 32);
  assert.equal(WECHAT_ARTICLE_LIMITS.author, 16);
  assert.equal(WECHAT_ARTICLE_LIMITS.digest, 120);
  assert.equal(WECHAT_ARTICLE_LIMITS.contentChars, 20_000);
  assert.equal(WECHAT_ARTICLE_LIMITS.coverBytes, 10 * 1024 * 1024);
  assert.equal(WECHAT_ARTICLE_LIMITS.contentImageBytes, 1024 * 1024);
});

test("标题 33 字报错并指明 32 字上限；32 字（边界）通过", () => {
  const tooLong = validateArticleDraft(draft({ title: "题".repeat(33) }));
  assert.equal(tooLong.length, 1);
  assert.equal(tooLong[0].field, "title");
  assert.equal(tooLong[0].actual, 33);
  assert.equal(tooLong[0].limit, 32);
  assert.match(tooLong[0].message, /32/u);

  assert.deepEqual(validateArticleDraft(draft({ title: "题".repeat(32) })), []);
});

test("标题按码点计数（emoji 不会被算成两个字符）", () => {
  assert.deepEqual(validateArticleDraft(draft({ title: "🎉".repeat(32) })), []);
  assert.equal(validateArticleDraft(draft({ title: "🎉".repeat(33) }))[0].actual, 33);
});

test("摘要 121 字报错、120 字通过；作者 17 字报错、16 字通过", () => {
  assert.equal(validateArticleDraft(draft({ digest: "摘".repeat(121) }))[0].field, "digest");
  assert.deepEqual(validateArticleDraft(draft({ digest: "摘".repeat(120) })), []);
  assert.equal(validateArticleDraft(draft({ author: "作".repeat(17) }))[0].field, "author");
  assert.deepEqual(validateArticleDraft(draft({ author: "作".repeat(16) })), []);
});

test("digest 与 author 缺省是合法状态，不报错也不伪造", () => {
  const result = validateArticleDraft(draft());
  assert.deepEqual(result, []);
});

test("标题为空要报错（draft/add 的 title 是必填）", () => {
  const result = validateArticleDraft(draft({ title: "   " }));
  assert.equal(result[0].field, "title");
});

test("正文超 20000 字符时渲染抛错，且指出是第几段超的", () => {
  assert.throws(
    () =>
      renderWechatArticleHtml(
        draft({
          sections: [
            { paragraphs: ["甲".repeat(11_000)] },
            { paragraphs: ["乙".repeat(11_000)] },
          ],
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof WechatArticleError);
      assert.equal(error.code, "wechat_article_too_long");
      assert.match(error.message, /第 2 段/u);
      assert.match(error.message, /20000/u);
      return true;
    },
  );
});

test("正文长度在限额内不抛错（边界附近）", () => {
  const html = renderWechatArticleHtml(draft({ sections: [{ paragraphs: ["甲".repeat(19_000)] }] }));
  assert.ok([...html].length < WECHAT_ARTICLE_LIMITS.contentChars);
});

// ── 输出形态 ─────────────────────────────────────────────────────────────────

test("输出是一个自包含的内联样式片段（不带 html/head/body 外壳）", () => {
  const html = renderWechatArticleHtml(draft());
  assert.equal(/<html|<head|<body|<!doctype/iu.test(html), false);
  assert.match(html, /^<section style="/u);
});

test("渲染是纯函数：同一输入两次结果逐字节相同", () => {
  const input = draft({
    title: "标题",
    digest: "摘要",
    author: "作者",
    sections: [
      { heading: "一", paragraphs: ["甲", "<strong>乙</strong>"] },
      { paragraphs: ["丙"] },
    ],
  });
  const options = { images: [{ url: WECHAT_IMAGE, caption: "图" }] };
  assert.equal(
    renderWechatArticleHtml(input, options),
    renderWechatArticleHtml(input, options),
  );
  // 且不改动入参（纯函数不该有副作用）。
  assert.deepEqual(input.sections[0].paragraphs, ["甲", "<strong>乙</strong>"]);
});

test("空文章（没有任何段落）不抛错，但也不产出空的 <p>", () => {
  const html = renderWechatArticleHtml(draft({ sections: [{ paragraphs: [] }] }));
  assert.equal(/<p style/u.test(html), false);
  assert.match(html, /^<section style="/u);
});

// ── 段内块级标签（肉眼复核抓到的两类粘连） ─────────────────────────────────────

test("段内文本里的列表项不会把文字粘在一起（边界换成换行）", () => {
  const html = renderWechatArticleHtml(
    draft({ sections: [{ paragraphs: ["<ul><li>钩子要具体</li><li>别用「大家好」开场</li></ul>"] }] }),
  );
  assert.equal(html.includes("钩子要具体别用"), false, "两个列表项被粘成了一句");
  assert.match(html, /钩子要具体<br>别用「大家好」开场/u);
  assert.equal(/<ul|<li/iu.test(html), false);
});

test("段内文本不产生嵌套的 <p>（非法结构），但多段之间保留换行", () => {
  const html = renderWechatArticleHtml(draft({ sections: [{ paragraphs: ["<p>甲</p><p>乙</p>"] }] }));
  assert.equal(/<p[^>]*>(?:(?!<\/p>)[\s\S])*<p/iu.test(html), false, "出现了嵌套 <p>");
  assert.match(html, /甲<br>乙/u);
});

test("段内文本首尾不残留多余的 <br>", () => {
  const html = renderWechatArticleHtml(draft({ sections: [{ paragraphs: ["<div></div>正文<div></div>"] }] }));
  assert.match(html, /<p style="[^"]*">正文<\/p>/u);
});

// ── 图片占位符（打包阶段还不知道微信托管 URL） ────────────────────────────────
//
// 微信正文图必须是 `uploadimg` 返回的 mmbiz URL，而那个 URL **只有在提交时才拿得到**。
// 因此包里的 `article.html` 存的是**占位符**，提交时逐张上传再替换 —— 这条是计划没写、
// 执行时补上的关键一环（见计划 Task 5b 的执行记录）。

test("图片可以先用占位符渲染（此时还不知道微信托管的 URL）", () => {
  const html = renderWechatArticleHtml(
    draft({ sections: [{ paragraphs: ["甲"] }, { paragraphs: ["乙"] }] }),
    { images: [{ slot: 1 }, { slot: 2 }] },
  );
  assert.match(html, /src="\{\{wechat-image-1\}\}"/u);
  assert.match(html, /src="\{\{wechat-image-2\}\}"/u);
  // 占位符不是微信托管 URL，所以「正文图来源」这条检查此时理应为空 —— 它检验的是最终产物。
  assert.deepEqual(extractContentImageSources(html), []);
});

test("占位符按序号替换成微信托管 URL，且顺序不变", () => {
  const html = renderWechatArticleHtml(
    draft({ sections: [{ paragraphs: ["甲"] }, { paragraphs: ["乙"] }] }),
    { images: [{ slot: 1 }, { slot: 2 }] },
  );
  const final = substituteWechatImageSlots(
    html,
    new Map([
      [1, `${WECHAT_IMAGE}/1`],
      [2, `${WECHAT_IMAGE}/2`],
    ]),
  );
  assert.deepEqual(extractContentImageSources(final), [`${WECHAT_IMAGE}/1`, `${WECHAT_IMAGE}/2`]);
  assert.equal(/\{\{/u.test(final), false, "占位符必须全部被替换掉");
});

test("占位符没替换完就抛错（绝不把带占位符的正文发出去）", () => {
  const html = renderWechatArticleHtml(draft(), { images: [{ slot: 1 }, { slot: 2 }] });
  assert.throws(
    () => substituteWechatImageSlots(html, new Map([[1, WECHAT_IMAGE]])),
    (error: unknown) => {
      assert.ok(error instanceof WechatArticleError);
      assert.equal(error.code, "wechat_article_image_slot_missing");
      assert.match(error.message, /2/u, "应指出缺的是哪一个序号");
      return true;
    },
  );
});

test("替换时拒绝非微信托管的 URL（外链图会被微信过滤成裂图）", () => {
  const html = renderWechatArticleHtml(draft(), { images: [{ slot: 1 }] });
  assert.throws(
    () => substituteWechatImageSlots(html, new Map([[1, "https://evil.example.com/x.png"]])),
    (error: unknown) => {
      assert.ok(error instanceof WechatArticleError);
      assert.equal(error.code, "wechat_article_image_unsafe");
      return true;
    },
  );
});

test("替换后的正文仍受 2 万字符上限约束", () => {
  // 图片地址也是 content 的一部分：占位符很短、真实 mmbiz URL 很长，
  // 所以「渲染时刚好合规」不代表「替换后还合规」。这里先量出真实开销，再构造临界样本。
  const limit = WECHAT_ARTICLE_LIMITS.contentChars;
  const rendered = (paragraphLength: number): string =>
    renderWechatArticleHtml(draft({ sections: [{ paragraphs: ["甲".repeat(paragraphLength)] }] }), {
      images: [{ slot: 1 }],
    });
  const overhead = [...rendered(0)].length;
  const wrapper = [...rendered(10)].length - overhead - 10;
  const html = rendered(limit - overhead - wrapper - 5);

  assert.ok([...html].length < limit, `渲染阶段应刚好在限额内，实际 ${[...html].length}`);
  assert.throws(
    () => substituteWechatImageSlots(html, new Map([[1, `https://mmbiz.qpic.cn/mmbiz_jpg/${"a".repeat(200)}`]])),
    (error: unknown) => {
      assert.ok(error instanceof WechatArticleError);
      assert.equal(error.code, "wechat_article_too_long");
      return true;
    },
  );
});

test("没有占位符时替换是安全的空操作（纯函数）", () => {
  const html = renderWechatArticleHtml(draft());
  assert.equal(substituteWechatImageSlots(html, new Map()), html);
});

// ── AI 成文与兜底（全程假 AI 客户端，绝不联网） ────────────────────────────────

type ChatHandler = (args: unknown) => unknown | Promise<unknown>;

/** 假 AI 客户端：记录请求、按脚本作答。测试绝不联网。 */
function fakeAi(handler: ChatHandler) {
  const requests: Array<Record<string, any>> = [];
  const client = {
    chat: {
      completions: {
        create: async (args: unknown) => {
          requests.push(args as Record<string, any>);
          return await handler(args);
        },
      },
    },
  };
  return { client, requests };
}

/** 让假 AI 回一个 JSON 字符串（就是 `extractAiMessageText` 认的形状）。 */
function replyWith(payload: unknown): ChatHandler {
  return () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] });
}

function planDeps(handler: ChatHandler) {
  const { client, requests } = fakeAi(handler);
  return {
    requests,
    deps: {
      resolveAiConfig: async () => ({ apiKey: "sk-fake", model: "fake-article-model" }),
      createClient: () => client,
    },
  };
}

const CONTEXT = {
  title: "抖音口播：为什么你的视频没人看完",
  summary: "前三秒决定生死",
  keyPoints: ["钩子要具体", "别用「大家好」开场"],
  cleanScript: "观众划走只需要 0.8 秒。",
  tags: ["短视频", "完播率"],
};

const VALID_ARTICLE = {
  title: "为什么没人看完",
  digest: "前三秒决定生死。",
  author: "抖创工坊",
  sections: [
    { heading: "一、前三秒", paragraphs: ["甲段", "乙段"] },
    { paragraphs: ["丙段"] },
  ],
  tags: ["短视频"],
};

test("AI 返回合法文章：copySource 为 ai、无兜底提示、字段完整", async () => {
  const { deps } = planDeps(replyWith(VALID_ARTICLE));
  const plan = await planWechatArticle(CONTEXT, deps);

  assert.equal(plan.copySource, "ai");
  assert.equal(plan.warning, undefined);
  assert.equal(plan.draft.title, "为什么没人看完");
  assert.equal(plan.draft.digest, "前三秒决定生死。");
  assert.equal(plan.draft.author, "抖创工坊");
  assert.equal(plan.draft.sections.length, 2);
  assert.equal(plan.draft.sections[0].heading, "一、前三秒");
  assert.deepEqual(plan.draft.sections[0].paragraphs, ["甲段", "乙段"]);
});

test("请求参数：必须走 JSON 模式，且提示词里的限额来自唯一真源", async () => {
  const { deps, requests } = planDeps(replyWith(VALID_ARTICLE));
  await planWechatArticle(CONTEXT, deps);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "fake-article-model");
  assert.equal(requests[0].response_format.type, "json_object");
  const prompt = JSON.stringify(requests[0].messages);
  // 限额必须由 WECHAT_ARTICLE_LIMITS 生成，而不是在提示词里另写一份数字。
  assert.ok(prompt.includes(String(WECHAT_ARTICLE_LIMITS.title)), "提示词未包含标题上限");
  assert.ok(prompt.includes(String(WECHAT_ARTICLE_LIMITS.digest)), "提示词未包含摘要上限");
  assert.ok(prompt.includes(String(WECHAT_ARTICLE_LIMITS.contentChars)), "提示词未包含正文上限");
  // 参考数据要真的喂进去。
  assert.ok(prompt.includes("钩子要具体"), "参考要点没进提示词");
});

test("AI 标题超 32 字时压缩到上限（不抛错，留给用户编辑）", async () => {
  const { deps } = planDeps(replyWith({ ...VALID_ARTICLE, title: "题".repeat(40) }));
  const plan = await planWechatArticle(CONTEXT, deps);

  assert.equal(plan.copySource, "ai", "超限只压缩，不该整篇降级成兜底");
  assert.equal([...plan.draft.title].length, WECHAT_ARTICLE_LIMITS.title);
  assert.ok(plan.draft.title.endsWith("…"));
  assert.deepEqual(validateArticleDraft(plan.draft), []);
});

test("AI 摘要/作者超限时同样压到上限", async () => {
  const { deps } = planDeps(
    replyWith({ ...VALID_ARTICLE, digest: "摘".repeat(200), author: "作".repeat(30) }),
  );
  const plan = await planWechatArticle(CONTEXT, deps);

  assert.equal([...(plan.draft.digest ?? "")].length, WECHAT_ARTICLE_LIMITS.digest);
  assert.equal([...(plan.draft.author ?? "")].length, WECHAT_ARTICLE_LIMITS.author);
  assert.deepEqual(validateArticleDraft(plan.draft), []);
});

test("AI 返回繁体时转成简体（与洗稿/文案同一口径）", async () => {
  const { deps } = planDeps(
    replyWith({ title: "這是一個測試", sections: [{ paragraphs: ["測試內容"] }] }),
  );
  const plan = await planWechatArticle(CONTEXT, deps);
  assert.equal(plan.draft.title, "这是一个测试");
  assert.equal(plan.draft.sections[0].paragraphs[0], "测试内容");
});

test("AI 返回坏 JSON、抛异常、或配置不可用时都走兜底（且不抛出）", async () => {
  const badJson = planDeps(() => ({ choices: [{ message: { content: "这不是 JSON" } }] }));
  const thrown = planDeps(() => {
    throw new Error("upstream 500");
  });
  const noConfig = planDeps(replyWith(VALID_ARTICLE));
  noConfig.deps.resolveAiConfig = async () => null;

  for (const [label, { deps }] of [
    ["坏 JSON", badJson],
    ["抛异常", thrown],
    ["无 AI 配置", noConfig],
  ] as const) {
    const plan = await planWechatArticle(CONTEXT, deps);
    assert.equal(plan.copySource, "fallback", `${label} 应走兜底`);
    assert.equal(plan.warning?.code, "wechat_article_ai_fallback", `${label} 应给出兜底提示`);
  }
});

test("兜底提示是面向用户可读的，不会被静默吞掉", async () => {
  const { deps } = planDeps(() => {
    throw new Error("boom");
  });
  const plan = await planWechatArticle(CONTEXT, deps);
  assert.match(plan.warning?.message ?? "", /兜底|可编辑|重试/u);
});

test("兜底草稿：标题取任务标题并压缩、正文由要点逐条成段", async () => {
  const { deps } = planDeps(() => {
    throw new Error("boom");
  });
  const plan = await planWechatArticle(CONTEXT, deps);

  assert.equal([...plan.draft.title].length <= WECHAT_ARTICLE_LIMITS.title, true);
  const paragraphs = plan.draft.sections.flatMap((section) => section.paragraphs);
  assert.ok(paragraphs.some((text) => text.includes("钩子要具体")), "兜底没用到 keyPoints");
  assert.ok(paragraphs.some((text) => text.includes("别用「大家好」开场")));
});

test("兜底结果能通过校验并渲染成功（端到端串起来）", async () => {
  const { deps } = planDeps(() => {
    throw new Error("boom");
  });
  const plan = await planWechatArticle(CONTEXT, deps);

  assert.deepEqual(validateArticleDraft(plan.draft), []);
  const html = renderWechatArticleHtml(plan.draft, { images: [{ url: WECHAT_IMAGE }] });
  assert.match(html, /^<section style="/u);
  assert.deepEqual(extractContentImageSources(html), [WECHAT_IMAGE]);
});

test("AI 返回结构不完整（无 sections / 全空段落）时走兜底，不产出空文章", async () => {
  const cases = [
    { title: "有标题没正文" },
    { title: "空段落", sections: [{ paragraphs: ["", "   "] }] },
    { title: "段落不是字符串", sections: [{ paragraphs: [123, null] }] },
  ];
  for (const payload of cases) {
    const { deps } = planDeps(replyWith(payload));
    const plan = await planWechatArticle(CONTEXT, deps);
    assert.equal(plan.copySource, "fallback", `${JSON.stringify(payload)} 应走兜底`);
    assert.ok(plan.draft.sections.some((section) => section.paragraphs.length > 0));
  }
});

test("任务标题为空时兜底也要给出可用的标题（否则 draft/add 必失败）", async () => {
  const { deps } = planDeps(() => {
    throw new Error("boom");
  });
  const plan = await planWechatArticle({ ...CONTEXT, title: "   " }, deps);
  assert.ok(plan.draft.title.trim().length > 0);
  assert.deepEqual(validateArticleDraft(plan.draft), []);
});

test("无论 AI 返回什么，产出都能通过校验并渲染（不变式）", async () => {
  const payloads: unknown[] = [
    VALID_ARTICLE,
    { ...VALID_ARTICLE, title: "题".repeat(99), digest: "摘".repeat(999), author: "作".repeat(99) },
    { title: "只有标题" },
    { sections: [{ paragraphs: ["没有标题"] }] },
    {},
    "纯字符串",
    42,
    null,
  ];
  for (const payload of payloads) {
    const { deps } = planDeps(replyWith(payload));
    const plan = await planWechatArticle(CONTEXT, deps);
    assert.deepEqual(
      validateArticleDraft(plan.draft),
      [],
      `payload ${JSON.stringify(payload)} 的产出未通过校验`,
    );
    assert.doesNotThrow(() => renderWechatArticleHtml(plan.draft, { images: [{ url: WECHAT_IMAGE }] }));
  }
});
