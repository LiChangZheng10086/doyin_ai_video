import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAiScriptCleaner, RuntimeScriptCleaner, validateShortVideoPlan } from "./ai-cleaner.js";
import type { ScriptAsset } from "../types.js";

function draft(): ScriptAsset {
  return {
    sourceUrl: "https://example.com/video",
    topic: "AI 内容生产",
    rawText: "原始转录",
    cleanScript: "原始转录",
    voiceoverScript: "原始转录",
    coverTitle: "AI 内容生产",
    tags: [],
    sceneList: [],
    status: "draft"
  };
}

function cleanInput() {
  return { topic: "AI 内容生产", transcriptText: "原始转录", draft: draft() };
}

function validCleanPayload() {
  return {
    title: "内容生产方法",
    summary: "核心内容",
    hook: "先找准核心问题",
    key_points: ["核心内容", "明确目标", "验证结果"],
    clean_script: "核心内容",
    short_video_script: "核心内容".repeat(46),
    cover_title: "内容生产方法",
    tags: ["内容生产"],
    quality_notes: []
  };
}

function validShots() {
  return Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shot_type: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `要点${index + 1}`,
    caption_lines: ["核心内容"],
    visual_items: [{ label: "输入" }, { label: "输出" }],
    source_key_points: [0],
    transition: "cut",
    pacing: "medium"
  }));
}

function installResponseQueue(
  cleaner: OpenAiScriptCleaner,
  requests: Array<Record<string, unknown>>,
  responses: unknown[]
) {
  (cleaner as any).client = {
    chat: { completions: { create: async (request: Record<string, unknown>) => {
      requests.push(request);
      return responses.shift();
    } } }
  };
}

function cleanerReturningFinishReasonLength(maxOutputTokens?: number) {
  const cleaner = new OpenAiScriptCleaner({
    apiKey: "test",
    model: "model",
    maxOutputTokens
  });
  (cleaner as any).client = {
    chat: { completions: { create: async () => ({
      choices: [{ finish_reason: "length", message: { content: "{\"title\":" } }]
    }) } }
  };
  return cleaner;
}

async function* streamChunks(parts: string[]) {
  for (const part of parts) {
    yield { choices: [{ delta: { content: part }, finish_reason: null }] };
  }
  yield { choices: [{ delta: {}, finish_reason: "stop" }] };
}

test("OpenAiScriptCleaner fails instead of silently returning raw transcript without an API key", async () => {
  const cleaner = new OpenAiScriptCleaner();

  await assert.rejects(
    () => cleaner.clean({ topic: "AI 内容生产", transcriptText: "原始转录", draft: draft() }),
    /AI API Key/
  );
});

test("OpenAiScriptCleaner omits max_tokens in automatic mode", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "model" });
  const requests: Array<Record<string, unknown>> = [];
  installResponseQueue(cleaner, requests, [
    { choices: [{ message: { content: JSON.stringify(validCleanPayload()) } }] },
    { choices: [{ message: { content: JSON.stringify({ target_duration: 60, shots: validShots() }) } }] }
  ]);

  await cleaner.clean(cleanInput());
  await cleaner.planShortVideo!({ ...draft(), keyPoints: ["核心内容"], shortVideoScript: "核心内容" });

  assert.equal(requests[0].max_tokens, undefined);
  assert.equal(requests[1].max_tokens, undefined);
});

test("OpenAiScriptCleaner sends the configured max output tokens", async () => {
  const cleaner = new OpenAiScriptCleaner({
    apiKey: "test",
    model: "model",
    maxOutputTokens: 8192
  });
  const requests: Array<Record<string, unknown>> = [];
  installResponseQueue(cleaner, requests, [
    { choices: [{ message: { content: JSON.stringify(validCleanPayload()) } }] },
    { choices: [{ message: { content: JSON.stringify({ target_duration: 60, shots: validShots() }) } }] }
  ]);

  await cleaner.clean(cleanInput());
  await cleaner.planShortVideo!({ ...draft(), keyPoints: ["核心内容"], shortVideoScript: "核心内容" });

  assert.equal(requests[0].max_tokens, 8192);
  assert.equal(requests[1].max_tokens, 8192);
});

test("automatic truncation points to the model or gateway limit", async () => {
  const cleaner = cleanerReturningFinishReasonLength();
  await assert.rejects(
    cleaner.clean(cleanInput()),
    /达到模型或中转服务的输出上限/
  );
});

test("custom truncation reports the configured limit", async () => {
  const cleaner = cleanerReturningFinishReasonLength(8192);
  await assert.rejects(
    cleaner.clean(cleanInput()),
    /当前设置的 8192 Tokens 上限/
  );
});

test("RuntimeScriptCleaner resolves the active AI configuration for every call", async () => {
  let model = "GPT-5.2-a";
  const seen: string[] = [];
  const cleaner = new RuntimeScriptCleaner(
    async () => ({ apiKey: "test", baseURL: "https://gateway.example/v1", model, provider: "openai" }),
    (options) => ({
      async clean(input) {
        seen.push(options.model ?? "");
        return { ...input.draft, title: options.model };
      }
    })
  );

  await cleaner.clean({ topic: "test", draft: draft() });
  model = "GPT-5.2-b";
  await cleaner.clean({ topic: "test", draft: draft() });

  assert.deepEqual(seen, ["GPT-5.2-a", "GPT-5.2-b"]);
});

test("OpenAiScriptCleaner surfaces API and invalid JSON failures", async () => {
  const apiFailure = new OpenAiScriptCleaner({ apiKey: "test" });
  (apiFailure as any).client = {
    chat: { completions: { create: async () => { throw new Error("service unavailable"); } } }
  };
  await assert.rejects(
    () => apiFailure.clean({ topic: "AI 内容生产", transcriptText: "原始转录", draft: draft() }),
    /AI 洗稿失败.*service unavailable/
  );

  const invalidJson = new OpenAiScriptCleaner({ apiKey: "test" });
  (invalidJson as any).client = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "not-json" } }] }) } }
  };
  await assert.rejects(
    () => invalidJson.clean({ topic: "AI 内容生产", transcriptText: "原始转录", draft: draft() }),
    /不是合法 JSON/
  );
});

test("OpenAiScriptCleaner accepts structured content parts from OpenAI-compatible gateways", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "deepseek-v4-flash" });
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shot_type: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `要点${index + 1}`,
    caption_lines: ["核心内容"],
    visual_items: [{ label: "输入" }, { label: "输出" }],
    source_key_points: [0],
    transition: "cut",
    pacing: "medium"
  }));
  (cleaner as any).client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: [{ type: "text", text: JSON.stringify({ target_duration: 60, shots }) }]
            }
          }]
        })
      }
    }
  };

  const result = await cleaner.planShortVideo({ ...draft(), keyPoints: ["核心内容"] });

  assert.equal(result.shots.length, 8);
});

test("OpenAiScriptCleaner preserves custom providers without sending DeepSeek-only options", async () => {
  const cleaner = new OpenAiScriptCleaner({
    apiKey: "test",
    provider: "custom",
    baseURL: "https://gateway.example/v1",
    model: "vendor-model"
  });
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shot_type: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `要点${index + 1}`,
    caption_lines: ["核心内容"],
    visual_items: [{ label: "输入" }, { label: "输出" }],
    source_key_points: [0],
    transition: "cut",
    pacing: "medium"
  }));
  let request: Record<string, unknown> | undefined;
  (cleaner as any).client = {
    chat: {
      completions: {
        create: async (value: Record<string, unknown>) => {
          request = value;
          return { choices: [{ message: { content: JSON.stringify({ target_duration: 60, shots }) } }] };
        }
      }
    }
  };

  const result = await cleaner.planShortVideo({ ...draft(), keyPoints: ["核心内容"] });

  assert.equal(result.shots.length, 8);
  assert.equal(request?.model, "vendor-model");
  assert.equal(request?.max_tokens, undefined);
  assert.equal(request?.extra_body, undefined);
});

test("OpenAiScriptCleaner accepts fenced JSON storyboard responses", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "deepseek-v4-flash" });
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shot_type: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `要点${index + 1}`,
    caption_lines: ["核心内容"],
    visual_items: [{ label: "输入" }, { label: "输出" }],
    source_key_points: [0],
    transition: "cut",
    pacing: "medium"
  }));
  (cleaner as any).client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            finish_reason: "stop",
            message: { content: `这是结果：\n\`\`\`json\n${JSON.stringify({ target_duration: 60, shots })}\n\`\`\`` }
          }]
        })
      }
    }
  };

  const result = await cleaner.planShortVideo({ ...draft(), keyPoints: ["核心内容"] });

  assert.equal(result.shots.length, 8);
});

test("OpenAiScriptCleaner reports automatic storyboard output limits clearly", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "deepseek-v4-flash" });
  (cleaner as any).client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ finish_reason: "length", message: { content: '{"shots":[' } }]
        })
      }
    }
  };

  await assert.rejects(
    () => cleaner.planShortVideo({ ...draft(), keyPoints: ["核心内容"] }),
    /达到模型或中转服务的输出上限/
  );
});

test("OpenAiScriptCleaner stores AI content as Simplified Chinese", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test" });
  let prompt = "";
  (cleaner as any).client = {
    chat: {
      completions: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          prompt = messages.map((message) => message.content).join("\n");
          return { choices: [{ message: { content: JSON.stringify({
          title: "推薦內容工作流",
          summary: "這是簡潔摘要",
          hook: "別再重複返工",
          key_points: ["明確目標", "拆解步驟", "驗證結果"],
          clean_script: "先明確目標，再拆解步驟，最後驗證結果。",
          short_video_script: "這是完整短視頻文案內容".repeat(18),
          cover_title: "內容工作流",
          tags: ["內容創作"],
          quality_notes: ["已刪除重複內容"]
          }) } }] };
        }
      }
    }
  };

  const result = await cleaner.clean({ topic: "内容生产", transcriptText: "原始转录", draft: draft() });

  assert.equal(result.title, "推荐内容工作流");
  assert.equal(result.summary, "这是简洁摘要");
  assert.deepEqual(result.keyPoints, ["明确目标", "拆解步骤", "验证结果"]);
  assert.match(result.shortVideoScript ?? "", /这是完整短视频文案内容/);
  assert.match(prompt, /中国大陆规范简体中文/);
});

test("OpenAiScriptCleaner injects supplemental text into the rewrite prompt", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test" });
  let prompt = "";
  (cleaner as any).client = {
    chat: {
      completions: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          prompt = messages.map((message) => message.content).join("\n");
          return { choices: [{ message: { content: JSON.stringify(validCleanPayload()) } }] };
        }
      }
    }
  };

  await cleaner.clean({
    topic: "内容生产",
    transcriptText: "原始转录",
    draft: draft(),
    supplementalText: "补充要点：三步流程"
  });

  assert.match(prompt, /用户补充信息/);
  assert.match(prompt, /补充要点：三步流程/);
});

test("OpenAiScriptCleaner streams clean JSON deltas and still validates the final result", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "deepseek-chat" });
  const payload = JSON.stringify({
    title: "内容工作流",
    summary: "简洁摘要",
    hook: "别再重复返工",
    key_points: ["明确目标", "拆解步骤", "验证结果"],
    clean_script: "先明确目标，再拆解步骤，最后验证结果。",
    short_video_script: "这是完整短视频文案内容".repeat(18),
    cover_title: "内容工作流",
    tags: ["内容创作"],
    quality_notes: []
  });
  const split = Math.floor(payload.length / 2);
  let request: Record<string, unknown> | undefined;
  let requestOptions: Record<string, unknown> | undefined;
  const controller = new AbortController();
  (cleaner as any).client = {
    chat: { completions: { create: async (value: Record<string, unknown>, options: Record<string, unknown>) => {
      request = value;
      requestOptions = options;
      return streamChunks([payload.slice(0, split), payload.slice(split)]);
    } } }
  };
  const updates: Array<{ delta: string; text: string; model: string }> = [];

  const result = await cleaner.clean(
    { topic: "内容生产", transcriptText: "原始转录", draft: draft() },
    controller.signal,
    (update) => updates.push(update)
  );

  assert.equal(request?.stream, true);
  assert.equal(request?.signal, undefined);
  assert.equal(requestOptions?.signal, controller.signal);
  assert.equal(updates.length, 2);
  assert.equal(updates[0]?.text, payload.slice(0, split));
  assert.equal(updates[1]?.text, payload);
  assert.equal(updates[1]?.model, "deepseek-chat");
  assert.equal(result.title, "内容工作流");
});

test("OpenAiScriptCleaner streams storyboard JSON before returning validated shots", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "deepseek-chat" });
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shot_type: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `要点${index + 1}`,
    caption_lines: ["核心内容"],
    visual_items: [{ label: "输入" }, { label: "输出" }],
    source_key_points: [0],
    transition: "cut",
    pacing: "medium"
  }));
  const payload = JSON.stringify({ target_duration: 60, shots });
  (cleaner as any).client = {
    chat: { completions: { create: async () => streamChunks([payload.slice(0, 40), payload.slice(40)]) } }
  };
  const previews: string[] = [];

  const result = await cleaner.planShortVideo(
    { ...draft(), keyPoints: ["核心内容"] },
    undefined,
    (update) => previews.push(update.text)
  );

  assert.equal(previews.at(-1), payload);
  assert.equal(result.shots.length, 8);
});

test("OpenAiScriptCleaner falls back to one-shot completion when a gateway rejects streaming", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", provider: "custom", baseURL: "https://gateway.example/v1" });
  const payload = JSON.stringify({
    title: "内容工作流",
    summary: "简洁摘要",
    hook: "别再重复返工",
    key_points: ["明确目标", "拆解步骤", "验证结果"],
    clean_script: "先明确目标，再拆解步骤，最后验证结果。",
    short_video_script: "这是完整短视频文案内容".repeat(18),
    cover_title: "内容工作流",
    tags: [],
    quality_notes: []
  });
  const requests: Array<Record<string, unknown>> = [];
  const updates: string[] = [];
  (cleaner as any).client = {
    chat: { completions: { create: async (request: Record<string, unknown>) => {
      requests.push(request);
      if (request.stream) throw Object.assign(new Error("stream is not supported"), { status: 400 });
      return { choices: [{ message: { content: payload } }] };
    } } }
  };

  const result = await cleaner.clean(
    { topic: "内容生产", transcriptText: "原始转录", draft: draft() },
    undefined,
    (update) => updates.push(update.text)
  );

  assert.deepEqual(requests.map((request) => request.stream), [true, undefined]);
  assert.deepEqual(updates, [payload]);
  assert.equal(result.title, "内容工作流");
});

test("OpenAiScriptCleaner falls back to one-shot completion when streaming is prematurely closed", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "deepseek-v4-flash" });
  const payload = JSON.stringify({
    title: "内容工作流",
    summary: "简洁摘要",
    hook: "别再重复返工",
    key_points: ["明确目标", "拆解步骤", "验证结果"],
    clean_script: "先明确目标，再拆解步骤，最后验证结果。",
    short_video_script: "这是完整短视频文案内容".repeat(18),
    cover_title: "内容工作流",
    tags: [],
    quality_notes: []
  });
  const requests: Array<Record<string, unknown>> = [];
  const updates: string[] = [];
  (cleaner as any).client = {
    chat: { completions: { create: async (request: Record<string, unknown>) => {
      requests.push(request);
      if (request.stream) {
        return (async function* () {
          yield { choices: [{ delta: { content: payload.slice(0, 20) }, finish_reason: null }] };
          throw new Error("Premature close");
        })();
      }
      return { choices: [{ message: { content: payload } }] };
    } } }
  };

  const result = await cleaner.clean(
    { topic: "内容生产", transcriptText: "原始转录", draft: draft() },
    undefined,
    (update) => updates.push(update.text)
  );

  assert.deepEqual(requests.map((request) => request.stream), [true, undefined]);
  assert.equal(result.title, "内容工作流");
  assert.equal(updates.at(-1), payload);
});

test("OpenAiScriptCleaner asks the model to repair a short video script once", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "gpt-5.5" });
  const prompts: string[] = [];
  let calls = 0;
  (cleaner as any).client = {
    chat: {
      completions: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          calls += 1;
          prompts.push(messages.at(-1)?.content ?? "");
          const script = calls === 1 ? "内容太短".repeat(20) : "这是完整短视频文案内容".repeat(18);
          return { choices: [{ message: { content: JSON.stringify({
            title: "内容工作流",
            summary: "简洁摘要",
            hook: "别再重复返工",
            key_points: ["明确目标", "拆解步骤", "验证结果"],
            clean_script: "先明确目标，再拆解步骤，最后验证结果。",
            short_video_script: script,
            cover_title: "内容工作流",
            tags: ["内容创作"],
            quality_notes: []
          }) } }] };
        }
      }
    }
  };

  const result = await cleaner.clean({ topic: "内容生产", transcriptText: "原始转录", draft: draft() });

  assert.equal(calls, 2);
  assert.match(prompts[1], /上一次输出未通过校验/);
  assert.match(prompts[1], /180 到 260/);
  assert.ok((result.shortVideoScript ?? "").length >= 180);
});

test("OpenAiScriptCleaner retries an invalid storyboard once with validation feedback", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test" });
  const prompts: string[] = [];
  const fullPrompts: string[] = [];
  (cleaner as any).client = {
    chat: {
      completions: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          prompts.push(messages.at(-1)?.content ?? "");
          fullPrompts.push(messages.map((message) => message.content).join("\n"));
          return { choices: [{ message: { content: JSON.stringify({ shots: [] }) } }] };
        }
      }
    }
  };

  await assert.rejects(() => cleaner.planShortVideo(draft()), /AI 分镜生成失败/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /上一次输出未通过校验/);
  assert.match(fullPrompts[0], /中国大陆规范简体中文/);
});

test("validateShortVideoPlan accepts a complete 50 to 60 second Shot V2 plan", () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shotType: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `要点${index + 1}`,
    supportingText: "清晰解释核心内容",
    captionLines: ["讲清核心内容", `这是第${index + 1}点`],
    visualItems: [{ label: "问题" }, { label: "方法" }],
    sourceKeyPoints: [index % 3],
    transition: index === 0 ? "flash" : "cut",
    pacing: index === 0 ? "fast" : "medium"
  }));

  const result = validateShortVideoPlan({ target_duration: 60, shots }, 3);

  assert.equal(result.targetDuration, 60);
  assert.equal(result.shots.length, 8);
  assert.equal(result.shots[0]?.layout, "kinetic-title");
});

test("validateShortVideoPlan keeps all six selected skill topics covered", () => {
  const skillNames = ["需求分析", "内容检索", "文案重写", "画面规划", "质量检查", "复盘优化"];
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shotType: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: index < 6 ? skillNames[index] : `完整流程${index + 1}`,
    captionLines: [index < 6 ? skillNames[index] : "六项能力形成闭环"],
    visualItems: [{ label: "输入" }, { label: "输出" }],
    sourceKeyPoints: index < 6 ? [index] : [0, 5],
    transition: "cut",
    pacing: "medium"
  }));

  const result = validateShortVideoPlan({ shots }, 6);
  const covered = new Set(result.shots.flatMap((shot) => shot.sourceKeyPoints));

  assert.deepEqual([...covered].sort(), [0, 1, 2, 3, 4, 5]);
});

test("validateShortVideoPlan rejects production text, overflow and missing key point coverage", () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shotType: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: index === 2 ? "panel reveal" : `要点${index + 1}`,
    captionLines: [index === 3 ? "这一行字幕明显超过十六个中文字符限制" : "核心内容"],
    visualItems: [{ label: "问题" }, { label: "方法" }],
    sourceKeyPoints: [0],
    transition: "cut",
    pacing: "medium"
  }));

  assert.throws(
    () => validateShortVideoPlan({ target_duration: 60, shots }, 3),
    /制作术语|字幕|核心要点/
  );
});

test("validateShortVideoPlan rejects invalid storyboard enum values", () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shotType: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `有效标题${index + 1}`,
    captionLines: ["有效字幕"],
    visualItems: [{ label: "输入" }, { label: "输出" }],
    sourceKeyPoints: [0],
    transition: index === 3 ? "teleport" : "cut",
    pacing: "medium"
  }));

  assert.throws(() => validateShortVideoPlan({ shots }, 1), /transition 无效/);
});

test("validateShortVideoPlan normalizes storyboard audience text to Simplified Chinese", () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shotType: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: index === 0 ? "推薦內容方法" : `有效标题${index + 1}`,
    captionLines: [index === 0 ? "這是觀眾字幕" : "有效字幕"],
    visualItems: [{ label: index === 0 ? "明確目標" : "输入" }, { label: "输出" }],
    sourceKeyPoints: [0],
    transition: "cut",
    pacing: "medium"
  }));

  const result = validateShortVideoPlan({ shots }, 1);

  assert.equal(result.shots[0]?.headline, "推荐内容方法");
  assert.equal(result.shots[0]?.captionLines?.[0], "这是观众字幕");
  assert.equal(result.shots[0]?.visualItems?.[0]?.label, "明确目标");
});

test("validateShortVideoPlan normalizes common model aliases and removes ungrounded metrics", () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shot_type: index === 0 ? "hook" : index === 7 ? "总结" : "explanation",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : index === 2 ? "metric" : "cards",
    headline: index === 2 ? "提升效率" : `有效标题${index + 1}`,
    caption_lines: ["有效字幕"],
    visual_items: index === 2
      ? [{ label: "效率", value: "99%" }, { label: "方法" }]
      : [{ label: "输入" }, { label: "输出" }],
    source_key_points: [0],
    transition: index === 1 ? "dissolve" : "cut",
    pacing: "medium"
  }));

  const result = validateShortVideoPlan({ shots }, 1, "原文只介绍提升效率的方法");

  assert.equal(result.shots[1]?.shotType, "explain");
  assert.equal(result.shots[1]?.layout, "concept-map");
  assert.equal(result.shots[1]?.transition, "cut");
  assert.equal(result.shots[2]?.shotType, "explain");
  assert.equal(result.shots[2]?.layout, "concept-map");
  assert.equal(result.shots[2]?.visualItems?.[0]?.value, undefined);
});

test("validateShortVideoPlan normalizes pacing aliases and casing instead of rejecting them", () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shotType: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `有效标题${index + 1}`,
    captionLines: ["有效字幕"],
    visualItems: [{ label: "输入" }, { label: "输出" }],
    sourceKeyPoints: [0],
    transition: "cut",
    pacing: index === 0 ? "Fast" : index === 1 ? "快速" : index === 2 ? "normal" : "medium"
  }));

  const result = validateShortVideoPlan({ shots }, 1);

  assert.equal(result.shots[0]?.pacing, "fast");
  assert.equal(result.shots[1]?.pacing, "fast");
  assert.equal(result.shots[2]?.pacing, "medium");
  assert.equal(result.shots[3]?.pacing, "medium");
});
