import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ScriptCleaner } from "./ai-cleaner.js";
import type { AsrService } from "./asr.js";
import { JobStore } from "./jobs.js";
import type { MediaService } from "./media.js";
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
        text: "转录正文",
        model: "ggml-small",
        provider: "whisper.cpp",
        segments: [{ text: "转录正文" }],
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

  assert.equal(extracted, 1);
  assert.equal(transcribedAudioPath, wavPath);
  assert.equal(result.audioPath, wavPath);
  assert.equal(result.steps?.transcribe.status, "succeeded");
});

test("JobStore generates shot-based video prompts while preserving legacy prompt fields", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "jobs-shot-prompts-"));
  const storage = new LocalStorage(storageRoot);
  const cleaner: ScriptCleaner = {
    async clean(input) {
      return input.draft;
    }
  };
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
  assert.ok((script.shortVideoShots?.length ?? 0) >= 6);
  assert.ok(script.shortVideoShots?.every((shot) => shot.subject && shot.action && shot.caption));
  assert.ok(script.shortVideoShots?.every((shot) => shot.visualLayers.length >= 4));
  assert.ok((script.videoPrompts?.length ?? 0) >= 6);
  assert.ok((script.enhancedScenes?.length ?? 0) >= 6);
});
