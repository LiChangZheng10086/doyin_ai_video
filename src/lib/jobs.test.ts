import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ScriptCleaner } from "./ai-cleaner.js";
import type { AsrService } from "./asr.js";
import { JobStore } from "./jobs.js";
import type { MediaService } from "./media.js";
import type { HyperframesVideoGenerator } from "./hyperframes-video.js";
import { LocalStorage } from "./storage.js";
import type { ScriptAsset } from "../types.js";

test("JobStore recovers persisted running steps after restart so they can be retried", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-restart-recovery-"));
  const storage = new LocalStorage(storageRoot);
  await storage.writeJson("cache/jobs-index.json", {
    interrupted: {
      id: "interrupted",
      sourceUrl: "https://example.com/video",
      topic: "restart recovery",
      status: "processing",
      stage: "generating-video-prompts",
      workflowMode: "manual",
      steps: {
        transcribe: { status: "succeeded", attempts: 1 },
        clean: { status: "succeeded", attempts: 1 },
        generate_video_prompts: {
          status: "running",
          attempts: 1,
          startedAt: "2026-08-12T18:00:00.000Z"
        },
        generate_video: { status: "pending", attempts: 0 }
      },
      storagePath: "processed/scripts/interrupted.json",
      createdAt: "2026-08-12T17:00:00.000Z",
      updatedAt: "2026-08-12T18:00:00.000Z"
    }
  });
  await storage.writeJson("processed/scripts/interrupted.json", {
    sourceUrl: "https://example.com/video",
    topic: "restart recovery",
    cleanScript: "可以重新执行的内容",
    status: "ready"
  } satisfies ScriptAsset);

  const jobs = new JobStore(
    storage,
    {
      async clean(input) { return input.draft; },
      async planShortVideo() {
        return {
          planVersion: 2,
          targetDuration: 60,
          shortVideoScript: "恢复后的分镜内容",
          shots: [{
            index: 1,
            duration: 6,
            shotType: "hook",
            subject: "恢复",
            action: "",
            cameraMotion: "",
            visualLayers: [],
            caption: "恢复",
            emphasisWords: [],
            transition: "cut",
            pacing: "fast",
            narration: "恢复"
          }]
        };
      }
    },
    {} as MediaService,
    {} as AsrService
  );

  await jobs.init();

  const recovered = await jobs.get("interrupted");
  assert.equal(recovered?.status, "queued");
  assert.equal(recovered?.steps?.generate_video_prompts.status, "paused");
  assert.match(recovered?.steps?.generate_video_prompts.lastError ?? "", /应用重启.*暂停/);
  assert.ok(recovered?.steps?.generate_video_prompts.finishedAt);

  const retried = await jobs.runStep("interrupted", "generate_video_prompts");
  assert.equal(retried.steps?.generate_video_prompts.status, "succeeded");
});

test("JobStore overview restores cover URLs for legacy collection jobs", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-cover-overview-"));
  const storage = new LocalStorage(storageRoot);
  const jobs = new JobStore(
    storage,
    { async clean(input) { return input.draft; } },
    {} as MediaService,
    {} as AsrService
  );
  await jobs.init();

  await storage.writeJson("cache/jobs-index.json", {
    legacy: {
      id: "legacy",
      sourceUrl: "https://www.douyin.com/video/7665199025906320357",
      topic: "合集视频",
      status: "queued",
      stage: "submitted",
      workflowMode: "manual",
      steps: {
        transcribe: { status: "pending", attempts: 0 },
        clean: { status: "pending", attempts: 0 },
        generate_video_prompts: { status: "pending", attempts: 0 },
        generate_video: { status: "pending", attempts: 0 }
      },
      storagePath: "processed/scripts/legacy.json",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }
  });
  await storage.writeJson("cache/collections-index.json", {
    collection: {
      crawlResult: {
        items: [{
          awemeId: "7665199025906320357",
          coverUrl: "https://cdn.example.com/cover.jpg"
        }]
      }
    }
  });

  const [overview] = await jobs.listOverview();
  assert.equal(overview?.preview.coverUrl, "https://cdn.example.com/cover.jpg");
});

test("JobStore re-extracts old mp3 audio before bundled Whisper transcription", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-old-mp3-"));
  const storage = new LocalStorage(storageRoot);
  const videoPath = path.join(storageRoot, "raw", "videos", "legacy.mp4");
  const oldAudioPath = path.join(storageRoot, "raw", "audio", "legacy.mp3");
  const wavPath = path.join(storageRoot, "raw", "audio", "legacy.wav");

  let extracted = 0;
  let transcribedAudioPath = "";
  const media = {
    async downloadVideo() {
      throw new Error("video should already exist");
    },
    async extractAudio() {
      extracted += 1;
      await writeFile(wavPath, "wav");
      return {
        audioPath: wavPath,
        manifestPath: path.join(storageRoot, "raw", "audio", "legacy.json"),
        duration: 2
      };
    }
  } as unknown as MediaService;
  const asr = {
    async transcribe(audioPath: string) {
      transcribedAudioPath = audioPath;
      return {
        text: "轉錄正文，推薦內容",
        model: "ggml-small",
        provider: "whisper.cpp",
        segments: [{ text: "轉錄正文，推薦內容" }],
        duration: 2,
        language: "zh"
      };
    }
  } as unknown as AsrService;
  const cleaner: ScriptCleaner = {
    async clean(input) {
      return input.draft;
    }
  };

  const jobs = new JobStore(storage, cleaner, media, asr);
  await jobs.init();
  await mkdir(path.dirname(videoPath), { recursive: true });
  await mkdir(path.dirname(oldAudioPath), { recursive: true });
  await writeFile(videoPath, "video");
  await writeFile(oldAudioPath, "mp3");
  await storage.writeJson("cache/jobs-index.json", {
    legacy: {
      id: "legacy",
      sourceUrl: "https://example.com/video",
      topic: "legacy",
      status: "queued",
      stage: "parsed",
      workflowMode: "manual",
      steps: {
        transcribe: { status: "pending", attempts: 0 },
        clean: { status: "pending", attempts: 0 },
        generate_video_prompts: { status: "pending", attempts: 0 },
        generate_video: { status: "pending", attempts: 0 }
      },
      videoPath,
      audioPath: oldAudioPath,
      storagePath: path.join("processed", "scripts", "legacy.json"),
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }
  });

  const result = await jobs.runStep("legacy", "transcribe");
  const transcript = await storage.readJson<{ transcript: string; segments: Array<{ text: string }> }>("raw/transcripts/legacy.json");

  assert.equal(extracted, 1);
  assert.equal(transcribedAudioPath, wavPath);
  assert.equal(result.audioPath, wavPath);
  assert.equal(result.steps?.transcribe.status, "succeeded");
  assert.equal(transcript.transcript, "转录正文，推荐内容");
  assert.equal(transcript.segments[0]?.text, "转录正文，推荐内容");
});

test("JobStore stores the AI generated Shot V2 plan", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-shot-prompts-"));
  const storage = new LocalStorage(storageRoot);
  const plannedShots = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shotType: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `核心要点${index + 1}`,
    supportingText: "把复杂内容讲清楚",
    captionLines: [`核心内容${index + 1}`, "逐步展开"],
    visualItems: [
      { label: "目标", tone: "primary" },
      { label: "结果", tone: "success" }
    ],
    sourceKeyPoints: [index % 3],
    subject: `核心要点${index + 1}`,
    action: "",
    cameraMotion: "",
    visualLayers: [],
    caption: `核心内容${index + 1}`,
    emphasisWords: ["核心"],
    transition: index === 0 ? "flash" : "cut",
    pacing: index === 0 ? "fast" : "medium",
    narration: `核心内容${index + 1}`
  }));
  const cleaner = {
    async clean(input) {
      return input.draft;
    },
    async planShortVideo() {
      return {
        planVersion: 2,
        targetDuration: 60,
        shortVideoScript: "这是为六十秒视频精编的完整内容。".repeat(10),
        shots: plannedShots
      };
    }
  } as ScriptCleaner;
  const media = {} as MediaService;
  const asr = {} as AsrService;
  const jobs = new JobStore(storage, cleaner, media, asr);
  await jobs.init();
  await storage.writeJson("cache/jobs-index.json", {
    shots: {
      id: "shots",
      sourceUrl: "https://example.com/video",
      topic: "AI 内容生产",
      status: "queued",
      stage: "cleaned",
      workflowMode: "manual",
      steps: {
        transcribe: { status: "succeeded", attempts: 1 },
        clean: { status: "succeeded", attempts: 1 },
        generate_video_prompts: { status: "pending", attempts: 0 },
        generate_video: { status: "pending", attempts: 0 }
      },
      storagePath: path.join("processed", "scripts", "shots.json"),
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }
  });
  await storage.writeJson("processed/scripts/shots.json", {
    sourceUrl: "https://example.com/video",
    topic: "AI 内容生产",
    coverTitle: "AI 内容生产三步法",
    summary: "先明确目标，再拆解步骤，最后验证结果。",
    cleanScript: "AI 内容生产要先明确目标，再拆解步骤，最后验证结果。",
    voiceoverScript: "先明确目标，再拆解步骤，最后验证结果。",
    keyPoints: ["明确目标", "拆解步骤", "验证结果"],
    videoOutline: [
      { title: "为什么要流程化", bullets: ["减少返工", "降低不确定性"], visualPrompt: "流程对比信息图" }
    ],
    status: "ready"
  } satisfies ScriptAsset);

  const result = await jobs.runStep("shots", "generate_video_prompts");
  const script = await storage.readJson<ScriptAsset>("processed/scripts/shots.json");

  assert.equal(result.steps?.generate_video_prompts.status, "succeeded");
  assert.equal(script.planVersion, 2);
  assert.equal(script.targetDuration, 60);
  assert.equal(script.shortVideoShots?.length, 8);
  assert.equal(script.shortVideoShots?.[0]?.layout, "kinetic-title");
  assert.equal(script.shortVideoShots?.[7]?.layout, "summary-stack");
  assert.equal(script.videoPrompts, undefined);
  assert.equal(script.enhancedScenes, undefined);
});

test("JobStore publishes AI clean previews before the completed event", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-clean-stream-"));
  const storage = new LocalStorage(storageRoot);
  const cleaner: ScriptCleaner = {
    async clean(input, _signal, onStream) {
      onStream?.({ delta: "第一段", text: "第一段", model: "deepseek-chat" });
      onStream?.({ delta: "第二段", text: "第一段第二段", model: "deepseek-chat" });
      return { ...input.draft, title: "完成洗稿", cleanScript: "完成内容", status: "ready" };
    }
  };
  const jobs = new JobStore(storage, cleaner, {} as MediaService, {} as AsrService);
  await jobs.init();
  await writeCleanRunnableFixture(storage, "stream-clean");
  const events: Array<{ type: string; text?: string }> = [];
  jobs.subscribeStepEvents("stream-clean", "clean", (event) => events.push({ type: event.type, text: event.text }));

  await jobs.runStep("stream-clean", "clean");

  assert.deepEqual(events.map((event) => event.type), ["started", "preview", "preview", "completed"]);
  assert.equal(events[2]?.text, "第一段第二段");
  const cleaned = await storage.readJson<{ output: ScriptAsset }>("processed/cleaned/stream-clean.json");
  assert.equal(cleaned.output.title, "完成洗稿");
});

test("JobStore emits an error and never writes a partial cleaned artifact when streaming fails", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-clean-stream-failure-"));
  const storage = new LocalStorage(storageRoot);
  const cleaner: ScriptCleaner = {
    async clean(_input, _signal, onStream) {
      onStream?.({ delta: "半截内容", text: "半截内容", model: "deepseek-chat" });
      throw new Error("上游连接中断");
    }
  };
  const jobs = new JobStore(storage, cleaner, {} as MediaService, {} as AsrService);
  await jobs.init();
  await writeCleanRunnableFixture(storage, "stream-failed");
  const eventTypes: string[] = [];
  jobs.subscribeStepEvents("stream-failed", "clean", (event) => eventTypes.push(event.type));

  await assert.rejects(jobs.runStep("stream-failed", "clean"), /上游连接中断/);

  assert.equal(eventTypes[0], "started");
  assert.equal(eventTypes.at(-1), "error");
  await assert.rejects(storage.readJson("processed/cleaned/stream-failed.json"));
});

async function writeCleanRunnableFixture(storage: LocalStorage, id: string) {
  await storage.writeJson("cache/jobs-index.json", {
    [id]: {
      id,
      sourceUrl: "https://example.com/video",
      topic: "AI 内容生产",
      status: "queued",
      stage: "transcribed",
      workflowMode: "manual",
      steps: {
        transcribe: { status: "succeeded", attempts: 1 },
        clean: { status: "pending", attempts: 0 },
        generate_video_prompts: { status: "pending", attempts: 0 },
        generate_video: { status: "pending", attempts: 0 }
      },
      storagePath: `processed/scripts/${id}.json`,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z"
    }
  });
  await storage.writeJson(`raw/transcripts/${id}.json`, {
    transcript: "这是完整的视频转录文本",
    text: "这是完整的视频转录文本"
  });
}

test("JobStore attempts video rendering only once and preserves the failure phase", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-video-once-"));
  const storage = new LocalStorage(storageRoot);
  let generateCalls = 0;
  const videoGenerator = {
    async generate(_script: ScriptAsset, _jobId: string, onProgress?: (state: { phase: string; progress: number }) => void) {
      generateCalls += 1;
      await onProgress?.({ phase: "validating", progress: 35 });
      throw new Error("inspect failed: clipped text");
    }
  } as unknown as HyperframesVideoGenerator;
  const jobs = new JobStore(
    storage,
    { async clean(input) { return input.draft; } },
    {} as MediaService,
    {} as AsrService,
    videoGenerator
  );
  await jobs.init();
  await storage.writeJson("cache/jobs-index.json", {
    video: {
      id: "video",
      sourceUrl: "https://example.com/video",
      topic: "video",
      status: "queued",
      stage: "scripted",
      workflowMode: "manual",
      steps: {
        transcribe: { status: "succeeded", attempts: 1 },
        clean: { status: "succeeded", attempts: 1 },
        generate_video_prompts: { status: "succeeded", attempts: 1 },
        generate_video: { status: "pending", attempts: 0 }
      },
      storagePath: "processed/scripts/video.json",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }
  });
  await storage.writeJson("processed/scripts/video.json", {
    sourceUrl: "https://example.com/video",
    topic: "video",
    rawText: "content",
    shortVideoShots: [{ index: 1, duration: 6, shotType: "hook", subject: "hook", action: "", cameraMotion: "", visualLayers: [], caption: "hook", emphasisWords: [], transition: "cut", pacing: "fast", narration: "hook" }],
    status: "ready"
  } satisfies ScriptAsset);

  await assert.rejects(jobs.runStep("video", "generate_video"), /inspect failed/);
  const result = await jobs.get("video");

  assert.equal(generateCalls, 1);
  assert.equal(result?.steps?.generate_video.attempts, 1);
  assert.equal(result?.steps?.generate_video.phase, "validating");
  assert.equal(result?.steps?.generate_video.progress, 35);
});

test("JobStore reclean resets downstream steps and persists supplemental text for a done job", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-reclean-done-"));
  const storage = new LocalStorage(storageRoot);
  let capturedSupplemental = "";
  const cleaner: ScriptCleaner = {
    async clean(input) {
      capturedSupplemental = input.supplementalText ?? "";
      return { ...input.draft, title: "补充后洗稿", cleanScript: "补充后的内容", status: "ready" };
    }
  };
  const jobs = new JobStore(storage, cleaner, {} as MediaService, {} as AsrService);
  await jobs.init();
  await storage.writeJson("cache/jobs-index.json", {
    done: {
      id: "done",
      sourceUrl: "https://example.com/video",
      topic: "AI 内容生产",
      status: "done",
      stage: "rendered",
      workflowMode: "manual",
      steps: {
        transcribe: { status: "succeeded", attempts: 1 },
        clean: { status: "succeeded", attempts: 1 },
        generate_video_prompts: { status: "succeeded", attempts: 1 },
        generate_video: { status: "succeeded", attempts: 1 }
      },
      storagePath: "processed/scripts/done.json",
      videoProjectPath: "output/videos/done/hyperframes",
      videoOutputPath: "output/videos/done/hyperframes/renders/video.mp4",
      videoGeneratedAt: "2026-08-12T18:00:00.000Z",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T18:00:00.000Z"
    }
  });
  await storage.writeJson("raw/transcripts/done.json", {
    transcript: "这是完整的视频转录文本",
    text: "这是完整的视频转录文本"
  });

  const result = await jobs.reclean("done", "补充要点：三步流程");

  assert.equal(capturedSupplemental, "补充要点：三步流程");
  assert.equal(result.steps?.clean.status, "succeeded");
  assert.equal(result.steps?.generate_video_prompts.status, "pending");
  assert.equal(result.steps?.generate_video.status, "pending");
  assert.equal(result.videoProjectPath, undefined);
  assert.equal(result.videoOutputPath, undefined);
  assert.equal(result.videoGeneratedAt, undefined);

  const cleaned = await storage.readJson<{ supplementalText?: string; output: ScriptAsset }>("processed/cleaned/done.json");
  assert.equal(cleaned.supplementalText, "补充要点：三步流程");
  assert.equal(cleaned.output.title, "补充后洗稿");
});
