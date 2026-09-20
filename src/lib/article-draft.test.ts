/**
 * 文章内核（平台中立）测试。
 *
 * 这一层的价值就是「同一套链路、不同口径」，所以用例的重点不是重复公众号的行为，
 * 而是证明**换个档案就换口径**：
 * 提示词里的限额数字、标题下限、摘要/作者上限、兜底标题都跟着 `ArticleProfile` 走。
 *
 * 公众号侧的既有 50 个用例是这次抽取的**逐字回归门禁**（行为必须完全不变）；
 * 这里全部用**假 AI 客户端**，零网络。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArticleMessages,
  buildFallbackPlan,
  codePointLength,
  commonArticleRules,
  compressToLimit,
  planArticle,
  validateArticleDraftAgainstProfile,
  type ArticleChatClient,
  type ArticleDraft,
  type ArticleProfile,
} from "./article-draft.js";

/** 头条形状的档案：标题 2~30（下限是本平台独有），没有摘要/作者字段。 */
const TEST_PROFILE: ArticleProfile = {
  label: "今日头条",
  limits: { titleMin: 2, titleMax: 30, bodyChars: 20_000 },
  fieldLabels: { title: "今日头条文章标题", digest: "文章摘要", author: "文章作者" },
  jsonKeys: ["title", "sections", "tags"],
  promptRules: (limits) => [
    "你是中文头条号文章编辑。",
    `标题不少于 ${limits.titleMin} 字、不超过 ${limits.titleMax} 字。`,
    `正文总长度必须少于 ${limits.bodyChars} 字符。`,
    ...commonArticleRules(["title", "sections", "tags"]),
  ],
  userPromptPrefix: "参考数据（来自一条短视频的转录与 AI 洗稿结果）：",
  requestLine: "请据此写一篇今日头条文章。",
  emptySourceNote: "（还没有可用正文素材：请先完成 AI 洗稿。）",
  emptyTitleFallback: "未命名文章",
  fallbackWarning: { code: "test_fallback", message: "AI 成文暂不可用，已使用兜底结构，可编辑后重试。" },
};

const CONTEXT = {
  title: "一条短视频的标题",
  summary: "这是摘要。",
  keyPoints: ["钩子要具体", "别用「大家好」开场"],
};

function draft(overrides: Partial<ArticleDraft> = {}): ArticleDraft {
  return { title: "一篇文章", sections: [{ paragraphs: ["第一段。"] }], ...overrides };
}

function planDeps(reply: unknown, options: { fail?: "throw" | "no-config" } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const client: ArticleChatClient = {
    chat: {
      completions: {
        create: async (args: Record<string, unknown>) => {
          calls.push(args);
          if (options.fail === "throw") throw new Error("网络不可用");
          return { choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }] };
        },
      },
    },
  };
  return {
    calls,
    deps: {
      resolveAiConfig: async () => (options.fail === "no-config" ? null : { apiKey: "k", model: "m" }),
      createClient: () => client,
    },
  };
}

test("提示词里的限额来自传进来的档案，不是写死的数字", async () => {
  const { calls, deps } = planDeps({ title: "标题", sections: [{ paragraphs: ["段落"] }] });
  await planArticle(CONTEXT, deps, TEST_PROFILE);

  const messages = calls[0]!.messages as Array<{ role: string; content: string }>;
  const prompt = messages.map((message) => message.content).join("\n");

  // 换档案就换口径：出现 2/30/20000，且不出现公众号的 32/120。
  assert.ok(prompt.includes("2"), "提示词未包含标题下限");
  assert.ok(prompt.includes(String(TEST_PROFILE.limits.titleMax)), "提示词未包含标题上限");
  assert.ok(prompt.includes(String(TEST_PROFILE.limits.bodyChars)), "提示词未包含正文上限");
  assert.equal(prompt.includes("120"), false, "不同平台的档案不该把别的平台限额带进来");
  assert.ok(prompt.includes("钩子要具体"), "参考要点没进提示词");
  assert.ok(prompt.includes("请据此写一篇今日头条文章。"), "结尾祈使句应来自档案");
  // 共用纪律只写一份。
  assert.ok(prompt.includes("不编造数据"));
});

test("标题必须满足下限：1 字报错、2 字通过（下限来自档案）", () => {
  const tooShort = validateArticleDraftAgainstProfile(draft({ title: "甲" }), TEST_PROFILE);
  assert.equal(tooShort.length, 1);
  assert.equal(tooShort[0]!.field, "title");
  assert.equal(tooShort[0]!.actual, 1);
  assert.equal(tooShort[0]!.limit, 2);
  assert.match(tooShort[0]!.message, /至少 2 字/u);

  assert.deepEqual(validateArticleDraftAgainstProfile(draft({ title: "甲乙" }), TEST_PROFILE), []);
  assert.deepEqual(validateArticleDraftAgainstProfile(draft({ title: "题".repeat(30) }), TEST_PROFILE), []);
  assert.equal(
    validateArticleDraftAgainstProfile(draft({ title: "题".repeat(31) }), TEST_PROFILE)[0]!.limit,
    30,
  );
});

test("档案没声明摘要/作者上限时不做这两项校验（头条没有这两个字段）", () => {
  const result = validateArticleDraftAgainstProfile(
    draft({ digest: "摘".repeat(500), author: "作".repeat(80) }),
    TEST_PROFILE,
  );
  assert.deepEqual(result, []);
});

test("标题按码点计数，压缩后带省略号（用户看得出被截断过）", () => {
  assert.equal(codePointLength("🎉".repeat(3)), 3);
  assert.equal(compressToLimit("🎉".repeat(31), 30), `${"🎉".repeat(29)}…`);
  assert.equal(compressToLimit("短标题", 30), "短标题");
});

test("共用写作纪律只有一份，JSON 顶层键由平台给", () => {
  const rules = commonArticleRules(["title", "sections", "tags"]);
  assert.equal(rules.length, 3);
  assert.match(rules[1]!, /title、sections、tags/u);
  assert.match(rules[2]!, /不要写 HTML 标签/u);
});

test("AI 返回超长标题时只压缩、不整篇降级成兜底", async () => {
  const { deps } = planDeps({ title: "题".repeat(40), sections: [{ paragraphs: ["段落一。"] }] });
  const plan = await planArticle(CONTEXT, deps, TEST_PROFILE);

  assert.equal(plan.copySource, "ai");
  assert.equal(plan.warning, undefined);
  assert.equal(codePointLength(plan.draft.title), TEST_PROFILE.limits.titleMax);
  assert.deepEqual(validateArticleDraftAgainstProfile(plan.draft, TEST_PROFILE), []);
});

test("无论 AI 返回什么，产出都能通过校验（不变式）", async () => {
  const payloads: Array<[string, unknown, ("throw" | "no-config")?]> = [
    ["合法结构", { title: "标题", sections: [{ paragraphs: ["段落。"] }] }],
    ["缺 sections", { title: "标题" }],
    ["sections 全空段落", { title: "标题", sections: [{ paragraphs: ["  "] }] }],
    ["标题为空", { title: "  ", sections: [{ paragraphs: ["段落。"] }] }],
    ["坏 JSON", "{不是 JSON"],
    ["null", null],
    ["数字", 42],
    ["抛异常", "", "throw"],
    ["无 AI 配置", "", "no-config"],
  ];

  for (const [label, payload, fail] of payloads) {
    const { deps } = planDeps(payload, fail ? { fail } : {});
    const plan = await planArticle(CONTEXT, deps, TEST_PROFILE);
    assert.deepEqual(
      validateArticleDraftAgainstProfile(plan.draft, TEST_PROFILE),
      [],
      `${label}：产出必须能通过校验`,
    );
    assert.ok(plan.draft.sections.length > 0, `${label}：不许产出空正文`);
    if (label !== "合法结构") {
      assert.equal(plan.copySource, "fallback", `${label}：应走兜底`);
      assert.equal(plan.warning?.code, "test_fallback", `${label}：应给出兜底提示`);
    }
  }
});

test("兜底标题会被兜到下限之上（否则兜底自己就过不了校验）", () => {
  const plan = buildFallbackPlan({ title: "甲" }, TEST_PROFILE);
  assert.equal(plan.draft.title, TEST_PROFILE.emptyTitleFallback);
  assert.deepEqual(validateArticleDraftAgainstProfile(plan.draft, TEST_PROFILE), []);
});

test("兜底：没有要点时退回正文切句；一条素材都没有时给可执行的占位说明", () => {
  const fromScript = buildFallbackPlan({ title: "标题", cleanScript: "第一句。第二句。" }, TEST_PROFILE);
  assert.ok(
    fromScript.draft.sections[0]!.paragraphs.some((text) => text.includes("第一句")),
    "没有要点时应用 cleanScript 切句",
  );

  const empty = buildFallbackPlan({ title: "标题" }, TEST_PROFILE);
  assert.deepEqual(empty.draft.sections[0]!.paragraphs, [TEST_PROFILE.emptySourceNote]);
  assert.equal(empty.copySource, "fallback");
});

test("buildArticleMessages 的数据源说明与祈使句都来自档案", () => {
  const messages = buildArticleMessages(CONTEXT, TEST_PROFILE);
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[1]!.role, "user");
  assert.match(messages[1]!.content, /^参考数据（来自一条短视频的转录与 AI 洗稿结果）：/u);
  assert.match(messages[1]!.content, /请据此写一篇今日头条文章。$/u);
});
