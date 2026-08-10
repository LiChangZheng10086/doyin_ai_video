import assert from "node:assert/strict";
import { test } from "node:test";
import type OpenAI from "openai";
import type { ScriptAsset } from "../types.js";
import {
  PublishingCopyService,
  type AiRuntimeConfig,
} from "./publishing-copy.js";

const AI_CONFIG: AiRuntimeConfig = {
  provider: "custom",
  model: "test-model",
  apiKey: "secret-key-that-must-not-be-logged",
  baseURL: "https://ai.example.test/v1",
};

const CLEANED = Object.freeze({
  title: "让内容生产更稳定",
  summary: "先明确目标，再拆解步骤，最后验证结果。",
  keyPoints: Object.freeze(["明确目标", "拆解步骤", "验证结果"]),
  shortVideoScript: "先明确内容目标，再把工作拆成可执行步骤，逐项验证结果并沉淀方法。",
  cleanScript: "不应优先使用的较长脚本",
  tags: Object.freeze(["内容创作", "效率工具"]),
  rawText: "SENTINEL_FULL_TRANSCRIPT SHOT cameraMotion 9:16 动态图形",
  transcriptText: "SENTINEL_TRANSCRIPT_COPY",
  videoOutline: Object.freeze([{ title: "SHOT", bullets: Object.freeze(["cameraMotion"]) }]),
  enhancedScenes: Object.freeze([{ videoPrompt: "9:16 动态图形" }]),
}) as unknown as ScriptAsset;

const VALID_COPIES = {
  douyin: {
    title: "让内容生产更稳定",
    description: "明确目标，拆解步骤，逐项验证。",
    hashtags: ["内容创作", "效率工具"],
  },
  xiaohongshu: {
    title: "稳定产出内容的三步法",
    description: "从目标到验证，一套可以重复使用的方法。",
    hashtags: ["内容创作", "效率提升"],
  },
  wechat_channels: {
    title: "内容生产的稳定方法",
    description: "明确目标、拆解步骤、验证结果。",
    hashtags: ["内容创作"],
  },
  bilibili: {
    title: "如何建立稳定的内容生产流程",
    description: "用目标、步骤和验证构成可复用的内容生产流程。",
    hashtags: ["内容创作", "工作方法"],
  },
};

class FakeChatClient {
  readonly calls: Array<{ request: Record<string, unknown>; prompt: string }> = [];

  constructor(
    private readonly response: unknown,
    private readonly failure?: unknown,
  ) {}

  readonly chat = {
    completions: {
      create: async (request: Record<string, unknown>) => {
        const messages = request.messages as Array<{ content?: string }>;
        this.calls.push({
          request,
          prompt: messages.map((message) => message.content ?? "").join("\n"),
        });
        if (this.failure) throw this.failure;
        return {
          choices: [{ message: { content: this.response } }],
        };
      },
    },
  };
}

function fixture(options: {
  client?: FakeChatClient;
  resolveAiConfig?: () => Promise<AiRuntimeConfig | null>;
  createClient?: (config: AiRuntimeConfig) => OpenAI;
} = {}) {
  const client = options.client ?? new FakeChatClient(JSON.stringify(VALID_COPIES));
  return {
    client,
    service: new PublishingCopyService({
      resolveAiConfig: options.resolveAiConfig ?? (async () => AI_CONFIG),
      createClient: options.createClient ?? (() => client as unknown as OpenAI),
    }),
  };
}

test("uses one AI request for all selected platforms and sends only concise cleaned fields", async () => {
  const client = new FakeChatClient(JSON.stringify({
    douyin: VALID_COPIES.douyin,
    bilibili: VALID_COPIES.bilibili,
  }));
  const { service } = fixture({ client });
  const before = JSON.stringify(CLEANED);

  const result = await service.previewAll(CLEANED, ["douyin", "bilibili"]);

  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].prompt, /只使用简体中文/);
  assert.match(client.calls[0].prompt, /让内容生产更稳定/);
  assert.match(client.calls[0].prompt, /明确目标/);
  assert.match(client.calls[0].prompt, /先明确内容目标/);
  assert.match(client.calls[0].prompt, /内容创作/);
  assert.doesNotMatch(client.calls[0].prompt, /SENTINEL_FULL_TRANSCRIPT|SENTINEL_TRANSCRIPT_COPY/);
  assert.doesNotMatch(client.calls[0].prompt, /SHOT|cameraMotion|9:16|动态图形/);
  assert.deepEqual(Object.keys(result.copies), ["douyin", "bilibili"]);
  assert.equal(result.warning, undefined);
  assert.equal(JSON.stringify(CLEANED), before);
});

test("removes production terms even when concise cleaned fields contain them", async () => {
  const contaminated = {
    ...CLEANED,
    title: "SHOT 内容方法",
    summary: "cameraMotion 不属于发布文案",
    keyPoints: ["不要出现 9:16", "不要出现动态图形"],
    shortVideoScript: "保留内容结论，移除 SHOT 和 cameraMotion。",
    tags: ["9:16", "动态图形", "内容创作"],
  } as ScriptAsset;
  const client = new FakeChatClient(JSON.stringify({ douyin: VALID_COPIES.douyin }));

  await fixture({ client }).service.previewAll(contaminated, ["douyin"]);

  assert.doesNotMatch(client.calls[0].prompt, /SHOT|cameraMotion|9:16|动态图形/);
  assert.match(client.calls[0].prompt, /内容方法|保留内容结论|内容创作/);
});

test("regenerates only one platform and requests exactly that JSON key", async () => {
  const client = new FakeChatClient(JSON.stringify({ xiaohongshu: VALID_COPIES.xiaohongshu }));
  const { service } = fixture({ client });

  const result = await service.regenerateOne(CLEANED, "xiaohongshu");

  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].prompt, /仅允许顶层键：xiaohongshu/);
  assert.doesNotMatch(client.calls[0].prompt, /仅允许顶层键：[^\n]*douyin/);
  assert.deepEqual(result, { ...VALID_COPIES.xiaohongshu, copySource: "ai" });
});

test("falls back deterministically when AI config is unavailable", async () => {
  const first = fixture({ resolveAiConfig: async () => null });
  const second = fixture({ resolveAiConfig: async () => null });

  const [result, repeated] = await Promise.all([
    first.service.previewAll(CLEANED, ["douyin"]),
    second.service.previewAll(CLEANED, ["douyin"]),
  ]);

  assert.deepEqual(result, repeated);
  assert.deepEqual(result.copies.douyin, {
    title: CLEANED.title,
    description: CLEANED.summary,
    hashtags: CLEANED.tags,
    copySource: "cleaned_fallback",
  });
  assert.equal(result.warning?.code, "publish_copy_ai_fallback");
  assert.match(result.warning?.message ?? "", /已使用洗稿内容生成可编辑文案/);
  assert.equal(first.client.calls.length, 0);
});

test("falls back for config resolution and client creation failures without exposing secrets", async () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: unknown[][] = [];
  console.warn = (...args: unknown[]) => logs.push(args);
  console.error = (...args: unknown[]) => logs.push(args);

  try {
    const configFailure = fixture({
      resolveAiConfig: async () => {
        throw new Error(`配置读取失败 ${AI_CONFIG.apiKey}`);
      },
    });
    const clientFailure = fixture({
      createClient: () => {
        throw new Error(`客户端初始化失败 ${AI_CONFIG.apiKey}`);
      },
    });

    const emptyKey = fixture({
      resolveAiConfig: async () => ({ ...AI_CONFIG, apiKey: "" }),
    });
    const emptyModel = fixture({
      resolveAiConfig: async () => ({ ...AI_CONFIG, model: "" }),
    });

    for (const service of [configFailure.service, clientFailure.service, emptyKey.service, emptyModel.service]) {
      const result = await service.previewAll(CLEANED, ["douyin"]);
      assert.equal(result.copies.douyin?.copySource, "cleaned_fallback");
      assert.equal(result.warning?.code, "publish_copy_ai_fallback");
    }
    assert.doesNotMatch(JSON.stringify(logs), /secret-key-that-must-not-be-logged/);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test("falls back for network, HTTP status and empty completion failures", async () => {
  const failures = [
    new Error("network unavailable"),
    Object.assign(new Error("upstream unavailable"), { status: 503 }),
  ];

  for (const failure of failures) {
    const client = new FakeChatClient("", failure);
    const result = await fixture({ client }).service.previewAll(CLEANED, ["douyin"]);
    assert.equal(result.copies.douyin?.copySource, "cleaned_fallback");
    assert.equal(result.warning?.code, "publish_copy_ai_fallback");
  }

  const empty = await fixture({ client: new FakeChatClient("") }).service.previewAll(CLEANED, ["douyin"]);
  assert.equal(empty.copies.douyin?.copySource, "cleaned_fallback");
  assert.equal(empty.warning?.code, "publish_copy_ai_fallback");
});

test("falls back for malformed JSON and invalid response shapes", async () => {
  const invalidResponses = [
    "not-json",
    JSON.stringify([]),
    JSON.stringify({ douyin: { title: "标题", description: "正文", hashtags: "标签" } }),
    JSON.stringify({ douyin: { title: "标题", description: "正文", hashtags: [], extra: true } }),
  ];

  for (const response of invalidResponses) {
    const result = await fixture({ client: new FakeChatClient(response) }).service.previewAll(CLEANED, ["douyin"]);
    assert.equal(result.copies.douyin?.copySource, "cleaned_fallback");
    assert.equal(result.warning?.code, "publish_copy_ai_fallback");
  }
});

test("requires exactly the requested platform keys", async () => {
  const invalidResponses = [
    JSON.stringify({}),
    JSON.stringify({ douyin: VALID_COPIES.douyin, bilibili: VALID_COPIES.bilibili }),
    JSON.stringify({ xiaohongshu: VALID_COPIES.xiaohongshu }),
  ];

  for (const response of invalidResponses) {
    const result = await fixture({ client: new FakeChatClient(response) }).service.previewAll(CLEANED, ["douyin"]);
    assert.deepEqual(Object.keys(result.copies), ["douyin"]);
    assert.equal(result.copies.douyin?.copySource, "cleaned_fallback");
    assert.equal(result.warning?.code, "publish_copy_ai_fallback");
  }
});

test("falls back when generated copy violates platform limits", async () => {
  const response = JSON.stringify({
    xiaohongshu: {
      title: "超".repeat(21),
      description: "正文",
      hashtags: [],
    },
  });

  const result = await fixture({ client: new FakeChatClient(response) }).service.previewAll(CLEANED, ["xiaohongshu"]);

  assert.equal(result.copies.xiaohongshu?.copySource, "cleaned_fallback");
  assert.equal(result.warning?.code, "publish_copy_ai_fallback");
});

test("normalizes AI output to Simplified Chinese before platform validation", async () => {
  const response = JSON.stringify({
    douyin: {
      title: "讓內容生產更穩定",
      description: "明確目標並驗證結果。",
      hashtags: ["內容創作"],
    },
  });

  const result = await fixture({ client: new FakeChatClient(response) }).service.previewAll(CLEANED, ["douyin"]);

  assert.deepEqual(result.copies.douyin, {
    title: "让内容生产更稳定",
    description: "明确目标并验证结果。",
    hashtags: ["内容创作"],
    copySource: "ai",
  });
});

test("returns an empty preview without calling AI when no platform is selected", async () => {
  const { client, service } = fixture();

  const result = await service.previewAll(CLEANED, []);

  assert.deepEqual(result, { copies: {} });
  assert.equal(client.calls.length, 0);
});

test("marks single-platform regeneration fallback with a safe warning", async () => {
  const client = new FakeChatClient("not-json");
  const result = await fixture({ client }).service.regenerateOne(CLEANED, "xiaohongshu");

  assert.equal(result.copySource, "cleaned_fallback");
  assert.equal(result.warning?.code, "publish_copy_ai_fallback");
  assert.doesNotMatch(result.warning?.message ?? "", /not-json|secret-key/);
});
