/**
 * 今日头条文章档案、成文与渲染测试。
 *
 * 与公众号共用 `article-draft.ts` 的骨架，差异只在档案（限额/提示词/文案）与本平台的渲染。
 * 该平台的独有约束（来自参考项目实测 + 平台规则）：
 * - 标题 **2~30 字**（下限是本平台独有）；
 * - **没有摘要与作者字段**，所以不做这两项校验、也不让它们进提示词；
 * - 正文由**结构化草稿**渲染，**不接收任意 HTML** —— 因此这里不做 wechat 那套标签白名单，
 *   而是**全部转义**（比事后清洗更强）。
 *
 * 全程假 AI 客户端，零网络。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOUTIAO_ARTICLE_LIMITS,
  articleBodyToDraft,
  articleDraftToBodyText,
  articleDraftToPlainParagraphs,
  articleHtmlToBodyText,
  htmlToPlainText,
  planToutiaoArticle,
  renderToutiaoArticleHtml,
  ToutiaoArticleError,
  validateToutiaoArticle,
  type ToutiaoArticleDraft,
} from "./toutiao-article.js";

function draft(overrides: Partial<ToutiaoArticleDraft> = {}): ToutiaoArticleDraft {
  return { title: "一篇文章", sections: [{ paragraphs: ["第一段。"] }], ...overrides };
}

function planDeps(payload: unknown, options: { fail?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    deps: {
      resolveAiConfig: async () => (options.fail ? null : { apiKey: "k", model: "m" }),
      createClient: () => ({
        chat: {
          completions: {
            create: async (args: Record<string, unknown>) => {
              calls.push(args);
              return {
                choices: [{ message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) } }],
              };
            },
          },
        },
      }),
    },
  };
}

test("限额是平台硬约束与自定守卫的唯一真源", () => {
  assert.equal(TOUTIAO_ARTICLE_LIMITS.titleMin, 2);
  assert.equal(TOUTIAO_ARTICLE_LIMITS.titleMax, 30);
  assert.equal(TOUTIAO_ARTICLE_LIMITS.bodyChars, 20_000);
  assert.equal(TOUTIAO_ARTICLE_LIMITS.coverWidth, 1280);
  assert.equal(TOUTIAO_ARTICLE_LIMITS.coverHeight, 720);
});

test("标题下限：1 字报错并指明「至少 2 字」，2 字与 30 字通过，31 字报错", () => {
  const tooShort = validateToutiaoArticle(draft({ title: "甲" }));
  assert.equal(tooShort[0]!.field, "title");
  assert.equal(tooShort[0]!.limit, TOUTIAO_ARTICLE_LIMITS.titleMin);
  assert.match(tooShort[0]!.message, /至少 2 字/u);

  assert.deepEqual(validateToutiaoArticle(draft({ title: "甲乙" })), []);
  assert.deepEqual(validateToutiaoArticle(draft({ title: "题".repeat(30) })), []);

  const tooLong = validateToutiaoArticle(draft({ title: "题".repeat(31) }));
  assert.equal(tooLong[0]!.limit, TOUTIAO_ARTICLE_LIMITS.titleMax);
  assert.match(tooLong[0]!.message, /30/u);
});

test("头条没有摘要与作者字段：不校验它们，提示词里也不许出现", async () => {
  assert.deepEqual(
    validateToutiaoArticle(draft({ digest: "摘".repeat(200), author: "作".repeat(50) })),
    [],
  );

  const { calls, deps } = planDeps({ title: "标题", sections: [{ paragraphs: ["段落。"] }] });
  await planToutiaoArticle({ title: "来源标题" }, deps);
  const prompt = (calls[0]!.messages as Array<{ content: string }>).map((m) => m.content).join("\n");

  assert.ok(prompt.includes(String(TOUTIAO_ARTICLE_LIMITS.titleMin)), "提示词未包含标题下限");
  assert.ok(prompt.includes(String(TOUTIAO_ARTICLE_LIMITS.titleMax)), "提示词未包含标题上限");
  assert.ok(prompt.includes(String(TOUTIAO_ARTICLE_LIMITS.bodyChars)), "提示词未包含正文上限");
  assert.equal(prompt.includes("digest"), false, "头条没有摘要字段，不该要求 AI 产出");
  assert.equal(prompt.includes("author"), false, "头条没有作者字段，不该要求 AI 产出");
  assert.ok(prompt.includes("请据此写一篇今日头条文章。"));
});

test("AI 返回坏数据时一律走兜底，且兜底必能通过校验（不变式）", async () => {
  const payloads: Array<[string, unknown, boolean?]> = [
    ["缺 sections", { title: "标题" }, undefined],
    ["空段落", { title: "标题", sections: [{ paragraphs: [" "] }] }, undefined],
    ["坏 JSON", "{不是 JSON", undefined],
    ["null", null, undefined],
    ["无 AI 配置", "", true],
  ];

  for (const [label, payload, fail] of payloads) {
    const { deps } = planDeps(payload, fail ? { fail } : {});
    const plan = await planToutiaoArticle({ title: "来源标题", keyPoints: ["钩子要具体"] }, deps);
    assert.equal(plan.copySource, "fallback", `${label}：应走兜底`);
    assert.equal(plan.warning?.code, "toutiao_article_ai_fallback", `${label}：应给出兜底提示`);
    assert.deepEqual(validateToutiaoArticle(plan.draft), [], `${label}：兜底必须能通过校验`);
  }
});

test("AI 返回超长标题时压到 30 字并带省略号，不整篇降级", async () => {
  const { deps } = planDeps({ title: "题".repeat(40), sections: [{ paragraphs: ["段落。"] }] });
  const plan = await planToutiaoArticle({ title: "来源标题" }, deps);

  assert.equal(plan.copySource, "ai");
  assert.equal([...plan.draft.title].length, TOUTIAO_ARTICLE_LIMITS.titleMax);
  assert.match(plan.draft.title, /…$/u);
  assert.deepEqual(validateToutiaoArticle(plan.draft), []);
});

test("渲染：小标题出 h2、段落出 p，且带内联样式", () => {
  const html = renderToutiaoArticleHtml(
    draft({
      sections: [
        { heading: "小标题", paragraphs: ["第一段。", "第二段。"] },
        { paragraphs: ["第三段。"] },
      ],
    }),
  );

  assert.match(html, /<h2 style="[^"]+">小标题<\/h2>/u);
  assert.equal((html.match(/<p style="[^"]+">/gu) ?? []).length, 3);
  assert.match(html, /第一段。/u);
  // 结构固定、可被编辑器解析：不该出现 markdown 记号。
  assert.equal(html.includes("##"), false);
});

test("渲染全部转义：正文里的标签只能是文本，绝不能变成真标签", () => {
  const html = renderToutiaoArticleHtml(
    draft({
      sections: [{ heading: "<b>h</b>", paragraphs: ["<script>alert(1)</script>", "a & b < c"] }],
    }),
  );

  assert.equal(html.includes("<script"), false, "正文里的 script 不能变成真标签");
  assert.equal(html.includes("<b>"), false, "标题里的标签也要转义");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /a &amp; b &lt; c/u);
});

test("渲染超过正文守卫时抛错，并指出是第几段开始超限", () => {
  const longParagraph = "长".repeat(20_000);
  assert.throws(
    () =>
      renderToutiaoArticleHtml(
        draft({ sections: [{ heading: "一", paragraphs: ["短"] }, { heading: "二", paragraphs: [longParagraph] }] }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoArticleError);
      assert.equal(error.code, "toutiao_article_too_long");
      assert.equal(error.status, 422);
      assert.match(error.message, new RegExp(String(TOUTIAO_ARTICLE_LIMITS.bodyChars), "u"));
      assert.match(error.message, /第 2 段/u);
      return true;
    },
  );
});

test("正文纯文本：小标题带 ## 标记（这样用户编辑后还能还原成 h2）", () => {
  const text = articleDraftToBodyText(
    draft({ sections: [{ heading: "小标题", paragraphs: ["第一段。", "第二段。"] }, { paragraphs: ["第三段。"] }] }),
  );

  assert.equal(text, "## 小标题\n\n第一段。\n\n第二段。\n\n第三段。");
  assert.equal(text.includes("<"), false);
});

test("正文往返无损：纯文本 → 草稿 → 纯文本 逐字相同（每节都有小标题时结构也相同）", () => {
  const original = draft({
    title: "标题",
    sections: [{ heading: "小标题一", paragraphs: ["第一段。"] }, { heading: "小标题二", paragraphs: ["第二段。"] }],
  });
  const text = articleDraftToBodyText(original);
  const restored = articleBodyToDraft("标题", text);

  assert.deepEqual(restored.sections, original.sections);
  assert.equal(articleDraftToBodyText(restored), text);
});

test("没有小标题的相邻两节会被合并，但**渲染结果一致**（往返只保证看得见的东西不变）", () => {
  const original = draft({
    title: "标题",
    sections: [{ paragraphs: ["第一段。"] }, { paragraphs: ["第二段。", "第三段。"] }],
  });
  const restored = articleBodyToDraft("标题", articleDraftToBodyText(original));

  assert.equal(renderToutiaoArticleHtml(restored), renderToutiaoArticleHtml(original));
});

test("用户多敲空行 / 行首尾空格不会改变结构", () => {
  const restored = articleBodyToDraft(
    "标题",
    "  ## 小标题  \n\n\n\n  第一段。  \n\n第二段。\n\n\n",
  );
  // 合并成一节：只有出现新的 ## 才会开新节（渲染结果不受影响）。
  assert.deepEqual(restored.sections, [{ heading: "小标题", paragraphs: ["第一段。", "第二段。"] }]);
});

test("纯文本粘贴兜底不带 ## 标记（粘进编辑器的应该是正文，不是记号）", () => {
  const paragraphs = articleDraftToPlainParagraphs(
    draft({ sections: [{ heading: "小标题", paragraphs: ["第一段。"] }] }),
  );
  assert.deepEqual(paragraphs, ["小标题", "第一段。"]);
});

test("htmlToPlainText 从渲染结果里取回可读正文（包级预览要摊给操作者看）", () => {
  const html = renderToutiaoArticleHtml(
    draft({ sections: [{ heading: "小标题", paragraphs: ["第一段 & 第二段。", "a < b"] }] }),
  );
  const text = htmlToPlainText(html);

  assert.match(text, /小标题/u);
  assert.match(text, /第一段 & 第二段。/u);
  assert.match(text, /a < b/u);
  assert.equal(text.includes("<p"), false);
});

test("空草稿的纯文本给占位说明，不返回空串（界面不能显示一片空白）", () => {
  const text = articleDraftToBodyText({ title: "标题", sections: [] });
  assert.ok(text.trim().length > 0);
});

// 包级预览手上有的是包内 `article.html`（`ArticleCopy` 只存 title + htmlSha256，没有正文文本），
// 所以需要一个 HTML → 正文的还原。**展示形态必须与创建向导一致**（带 `## ` 小标题标记），
// 否则同一个包在向导里和在预览里长得不一样，操作者会以为小标题丢了。
test("articleHtmlToBodyText：渲染结果还原成带 ## 的正文，与 articleDraftToBodyText 逐字相同", () => {
  const source = draft({
    sections: [
      { heading: "小标题", paragraphs: ["第一段 & 第二段。", "a < b"] },
      { paragraphs: ["没有小标题的一节。"] },
    ],
  });

  assert.equal(articleHtmlToBodyText(renderToutiaoArticleHtml(source)), articleDraftToBodyText(source));
});

test("articleHtmlToBodyText：空 HTML 不抛错，返回占位说明（界面不能显示一片空白）", () => {
  assert.ok(articleHtmlToBodyText("").trim().length > 0);
  assert.ok(articleHtmlToBodyText("<section style=\"x\"></section>").trim().length > 0);
});
