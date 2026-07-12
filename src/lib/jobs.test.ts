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
