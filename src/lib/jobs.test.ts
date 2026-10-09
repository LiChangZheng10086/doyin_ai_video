import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ScriptCleaner } from "./ai-cleaner.js";
import type { AsrService } from "./asr.js";
import { JobStore, JobStepError } from "./jobs.js";
import type { MediaService } from "./media.js";
import type { HyperframesVideoGenerator } from "./hyperframes-video.js";
import { LocalStorage } from "./storage.js";
import type { ScriptAsset, JobRecord } from "../types.js";

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
        segments: [{ start: 0, end: 2, text: "轉錄正文，推薦內容" }],
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

async function repairFixture(transcribe: AsrService["transcribe"], cleaner: ScriptCleaner = { async clean(input) { return input.draft; } }) {
  const root = await mkdtemp(path.join(tmpdir(), "jobs-retranscribe-"));
  const storage = new LocalStorage(root);
  const jobs = new JobStore(storage, cleaner,
    { async downloadVideo() { throw new Error("must reuse source"); }, async extractAudio() { throw new Error("must reuse checked audio"); } } as unknown as MediaService,
    { transcribe } as AsrService);
  await jobs.init();
  const id = "repair";
  const record = await jobs.create({ sourceUrl: "https://example.com/video", topic: "repair" });
  // Use a stable identity so the entire old state and disk bytes are independently checkable.
  await storage.writeJson("cache/jobs-index.json", { [id]: { ...record, id,
    status: "done", stage: "rendered", storagePath: "processed/scripts/repair.json",
    videoPath: storage.resolve("raw/videos/repair.mp4"), audioPath: storage.resolve("raw/audio/repair.wav"),
    transcriptPath: "raw/transcripts/repair.json", transcriptModel: "old-model",
    videoProjectPath: "output/videos/repair/hyperframes", videoOutputPath: "output/videos/repair/video.mp4", videoGeneratedAt: "2026-10-08T00:00:00Z",
    steps: {
      transcribe: { status: "succeeded", attempts: 1 }, clean: { status: "succeeded", attempts: 1 },
      generate_video_prompts: { status: "succeeded", attempts: 1 }, generate_video: { status: "succeeded", attempts: 1 }
    }
  } });
  await writeFile(storage.resolve("raw/videos/repair.mp4"), "source video");
  await writeFile(storage.resolve("raw/audio/repair.wav"), "checked wav");
  await storage.writeJson("raw/audio/repair.json", { status: "ready", args: ["pcm_s16le", "16000", "1"], audio: { duration: 20, streams: [{ codec_name: "pcm_s16le", channels: 1, sample_rate: "16000" }] } });
  await storage.writeJson("raw/transcripts/repair.json", { transcript: "旧转录", text: "旧转录", segments: [{ start: 2, end: 1, text: "旧转录" }] });
  await storage.writeJson("processed/scripts/repair.json", { cleanScript: "旧洗稿", videoPrompts: "旧分镜" });
  await storage.writeJson("processed/cleaned/repair.json", { output: { cleanScript: "旧洗稿" } });
  await mkdir(storage.resolve("output/videos/repair"), { recursive: true });
  await writeFile(storage.resolve("output/videos/repair/video.mp4"), "old final video");
  return { storage, jobs, id };
}

const repairedTranscript = { text: "有效的新转录", segments: [{ start: 0, end: 3, text: "有效的新转录" }], duration: 20, model: "ggml-small", provider: "whisper.cpp" };

test("explicit retranscription adopts checked output, archives old text and invalidates all downstream steps", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  await assert.rejects(jobs.runStep(id, "transcribe"), /already succeeded/);
  const result = await jobs.retranscribe(id);
  assert.equal(result.steps?.transcribe.status, "succeeded");
  for (const step of ["clean", "generate_video_prompts", "generate_video"] as const) {
    assert.equal(result.steps?.[step].status, "pending");
    assert.equal(result.steps?.[step].attempts, 0);
  }
  assert.equal(result.videoOutputPath, undefined);
  assert.equal(result.videoProjectPath, undefined);
  assert.equal(result.videoGeneratedAt, undefined);
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "有效的新转录");
  const transcripts = await readdir(storage.resolve("raw/transcripts"));
  const backup = transcripts.find((file) => file !== "repair.json");
  assert.ok(backup);
  assert.equal((await storage.readJson<{ text: string }>(`raw/transcripts/${backup}`)).text, "旧转录");
  for (const folder of ["scripts", "cleaned"]) {
    await assert.rejects(storage.readJson(`processed/${folder}/repair.json`));
    assert.ok((await readdir(storage.resolve(`processed/${folder}`))).length);
  }
  assert.equal(await readFile(storage.resolve("output/videos/repair/video.mp4"), "utf8"), "old final video");
});

test("failed retranscription keeps old bytes and downstream while blocking reuse, within three attempts", async () => {
  let attempts = 0;
  const { jobs, storage, id } = await repairFixture(async () => { attempts += 1; return { ...repairedTranscript, segments: [{ start: 4, end: 2, text: "无效" }] }; });
  const before = await readFile(storage.resolve("raw/transcripts/repair.json"), "utf8");
  await assert.rejects(jobs.retranscribe(id), /转录.*异常/);
  assert.equal(attempts, 3);
  assert.equal(await readFile(storage.resolve("raw/transcripts/repair.json"), "utf8"), before);
  assert.equal((await jobs.get(id))?.steps?.transcribe.status, "failed");
  assert.equal((await jobs.get(id))?.steps?.clean.status, "succeeded");
  assert.equal((await jobs.get(id))?.videoOutputPath, "output/videos/repair/video.mp4");
  assert.equal((await storage.readJson<{ cleanScript: string }>("processed/scripts/repair.json")).cleanScript, "旧洗稿");
  await assert.rejects(jobs.reclean(id, "补充信息"), /previous step/);
});

test("retranscription holds the same job mutex against repair, steps and reclean", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { jobs, id } = await repairFixture(async () => { entered(); await gate; return repairedTranscript; });
  const run = jobs.retranscribe(id);
  await started;
  for (const action of [() => jobs.retranscribe(id), () => jobs.runStep(id, "clean"), () => jobs.reclean(id, "补充")]) {
    await assert.rejects(action(), (error) => error instanceof JobStepError && error.statusCode === 409);
  }
  release();
  await run;
});

test("historical abnormal transcript cannot reach cleaner even when transcribe says succeeded", async () => {
  let cleaned = false;
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript,
    { async clean(input) { cleaned = true; return input.draft; } });
  // The previous succeeded label alone must not make an invalid transcript usable.
  const record = (await jobs.get(id))!;
  await jobs.update(id, { steps: { ...record.steps!, clean: { status: "pending", attempts: 0 } } });
  await assert.rejects(jobs.runStep(id, "clean"), /转录.*异常/);
  assert.equal(cleaned, false);
  assert.equal((await storage.readJson<{ cleanScript: string }>("processed/scripts/repair.json")).cleanScript, "旧洗稿");
});

test("retranscription rolls back active transcript and downstream if commit storage fails", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const oldWrite = storage.writeJsonAtomic.bind(storage);
  storage.writeJsonAtomic = async (file, data) => {
    if (file === "cache/jobs-index.json" && JSON.stringify(data).includes('"clean":{"status":"pending"')) throw new Error("disk commit failed");
    return oldWrite(file, data);
  };
  await assert.rejects(jobs.retranscribe(id), /disk commit failed/);
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
  assert.equal((await storage.readJson<{ cleanScript: string }>("processed/scripts/repair.json")).cleanScript, "旧洗稿");
  assert.equal((await jobs.get(id))?.steps?.clean.status, "succeeded");
});

test("reclean reserves the mutex before asynchronous validation so an immediate repair cannot race it", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  await storage.writeJson("raw/transcripts/repair.json", { transcript: "正常转录", text: "正常转录", segments: [{ start: 0, end: 2, text: "正常转录" }] });
  const cleaning = jobs.reclean(id, "补充");
  const repairing = jobs.retranscribe(id);
  const [cleanResult, repairResult] = await Promise.allSettled([cleaning, repairing]);
  assert.equal(cleanResult.status, "fulfilled");
  assert.equal(repairResult.status, "rejected");
  if (repairResult.status === "rejected") assert.equal(repairResult.reason.statusCode, 409);
});

test("pausing retranscription prevents a late ASR response from changing old artifacts", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { jobs, storage, id } = await repairFixture(async () => { entered(); await gate; return repairedTranscript; });
  const run = jobs.retranscribe(id);
  await started;
  const paused = jobs.pauseStep(id);
  // Wait until cancellation is persisted before allowing the deliberately late response.
  while ((await jobs.get(id))?.steps?.transcribe.status !== "paused") await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  await Promise.all([run, paused]);
  assert.equal((await jobs.get(id))?.steps?.transcribe.status, "paused");
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
  assert.equal((await jobs.get(id))?.steps?.clean.status, "succeeded");
});


test("repair rejects an audio symlink outside storage before ASR and preserves its target", async () => {
  let transcribed = false;
  const { jobs, storage, id } = await repairFixture(async () => { transcribed = true; return repairedTranscript; });
  const outside = path.join(await mkdtemp(path.join(tmpdir(), "repair-outside-")), "private.wav");
  await writeFile(outside, "outside private audio");
  const link = storage.resolve("raw/audio/linked.wav");
  await symlink(outside, link);
  await jobs.update(id, { audioPath: link });
  await assert.rejects(jobs.retranscribe(id), /不可读取|超出/);
  assert.equal(transcribed, false);
  assert.equal(await readFile(outside, "utf8"), "outside private audio");
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
});

test("pause during transcription commit rolls back file changes and retains paused state", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = storage.writeJsonAtomic.bind(storage);
  storage.writeJsonAtomic = async (file, data) => {
    const result = await original(file, data);
    if (file === "raw/transcripts/repair.json") { entered(); await gate; }
    return result;
  };
  const run = jobs.retranscribe(id);
  await started;
  const pausing = jobs.pauseStep(id);
  while ((await jobs.get(id))?.steps?.transcribe.status !== "paused") await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  await Promise.all([run, pausing]);
  assert.equal((await jobs.get(id))?.steps?.transcribe.status, "paused");
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
  assert.equal((await storage.readJson<{ cleanScript: string }>("processed/scripts/repair.json")).cleanScript, "旧洗稿");
});

test("ordinary transcribe retry after failed repair still archives and invalidates downstream", async () => {
  let valid = false;
  const { jobs, storage, id } = await repairFixture(async () => valid ? repairedTranscript : { ...repairedTranscript, segments: [{ start: 5, end: 2, text: "异常" }] });
  await assert.rejects(jobs.retranscribe(id), /转录.*异常/);
  valid = true;
  const result = await jobs.runStep(id, "transcribe");
  assert.equal(result.steps?.clean.status, "pending");
  assert.equal(result.videoOutputPath, undefined);
  assert.ok((await readdir(storage.resolve("raw/transcripts"))).some((file) => file.includes("before-retranscribe")));
});

test("clean rejects an inflated historical duration using the actual audio manifest", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const record = (await jobs.get(id))!;
  await jobs.update(id, { steps: { ...record.steps!, clean: { status: "pending", attempts: 0 } } });
  await storage.writeJson("raw/transcripts/repair.json", { transcript: "错误时间", text: "错误时间", segments: [{ start: 0, end: 600, text: "错误时间" }], duration: 600 });
  await assert.rejects(jobs.runStep(id, "clean"), /超出音频时长/);
  assert.equal((await storage.readJson<{ cleanScript: string }>("processed/scripts/repair.json")).cleanScript, "旧洗稿");
});

test("permanent deletion removes only this job's generated repair files and history backups", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  await jobs.retranscribe(id);
  const uuid = "11111111-1111-4111-8111-111111111111";
  for (const extension of ["wav", "json"]) await writeFile(storage.resolve("raw/audio", `${id}-repair-${uuid}.${extension}`), "repair artifact");
  const unrelated = [`${id}-other-repair-${uuid}.wav`, `${id}-repair-invalid.wav`, `${id}-repair-${uuid}.mp3`];
  for (const file of unrelated) await writeFile(storage.resolve("raw/audio", file), "unrelated");
  await writeFile(storage.resolve("raw/transcripts", `${id}-other.json.before-retranscribe-${uuid}.json`), "other job history");
  await jobs.trash(id);
  assert.equal(await jobs.permanentlyDelete(id), "deleted");
  for (const folder of ["raw/transcripts", "processed/scripts", "processed/cleaned"]) {
    const names = await readdir(storage.resolve(folder));
    assert.ok(!names.some((name) => name.startsWith(`${id}.json.before-retranscribe-`)));
  }
  for (const extension of ["wav", "json"]) await assert.rejects(readFile(storage.resolve("raw/audio", `${id}-repair-${uuid}.${extension}`)));
  for (const file of unrelated) assert.equal(await readFile(storage.resolve("raw/audio", file), "utf8"), "unrelated");
  assert.equal(await readFile(storage.resolve("raw/transcripts", `${id}-other.json.before-retranscribe-${uuid}.json`), "utf8"), "other job history");
});


for (const stage of ["journal-only", "raw-swapped", "downstream-removed", "state-swapped"] as const) {
  test(`restart rolls back incomplete retranscription at ${stage} before exposing mixed generations`, async () => {
    const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
    const oldRecord = (await jobs.get(id))!;
    const transactionId = "22222222-2222-4222-8222-222222222222";
    const files = ["raw/transcripts/repair.json", "processed/scripts/repair.json", "processed/cleaned/repair.json"];
    const backups = [];
    for (const file of files) {
      const backup = `${file}.before-retranscribe-${transactionId}.json`;
      await writeFile(storage.resolve(backup), await readFile(storage.resolve(file)));
      backups.push({ file, backup, existed: true });
    }
    const runningRecord = { ...oldRecord, status: "processing", stage: "transcribing", steps: { ...oldRecord.steps!, transcribe: { status: "running", attempts: 1 } } };
    await storage.writeJsonAtomic("cache/jobs-index.json", { [id]: runningRecord });
    await storage.writeJsonAtomic(`cache/retranscribe/${id}.json`, { version: 1, transactionId, record: runningRecord, backups });
    if (stage !== "journal-only") await storage.writeJsonAtomic(files[0], { text: "尚未完成切换的新转录", segments: repairedTranscript.segments });
    if (stage === "downstream-removed" || stage === "state-swapped") for (const file of files.slice(1)) await rm(storage.resolve(file));
    if (stage === "state-swapped") await storage.writeJsonAtomic("cache/jobs-index.json", { [id]: {
      ...oldRecord, status: "queued", stage: "transcribed", videoOutputPath: undefined, videoProjectPath: undefined,
      steps: { transcribe: { status: "succeeded", attempts: 1 }, clean: { status: "pending", attempts: 0 }, generate_video_prompts: { status: "pending", attempts: 0 }, generate_video: { status: "pending", attempts: 0 } }
    } });
    const restarted = new JobStore(storage, {} as ScriptCleaner, {} as MediaService, {} as AsrService);
    await restarted.init();
    const restored = (await restarted.get(id))!;
    assert.equal((await storage.readJson<{ text: string }>(files[0])).text, "旧转录");
    assert.equal((await storage.readJson<{ cleanScript: string }>(files[1])).cleanScript, "旧洗稿");
    assert.equal(restored.steps?.transcribe.status, "paused");
    assert.equal(restored.steps?.clean.status, "succeeded");
    assert.equal(restored.videoOutputPath, oldRecord.videoOutputPath);
    await assert.rejects(readFile(storage.resolve(`cache/retranscribe/${id}.json`)));
    await restarted.init();
    assert.equal((await restarted.get(id))?.steps?.transcribe.status, "paused");
  });
}

test("ordinary retry archives corrupt transcript bytes and invalidates succeeded downstream", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const record = (await jobs.get(id))!;
  await jobs.update(id, { steps: { ...record.steps!, transcribe: { status: "failed", attempts: 3 } } });
  const corrupt = '{"segments":';
  await writeFile(storage.resolve("raw/transcripts/repair.json"), corrupt);
  const next = await jobs.runStep(id, "transcribe");
  assert.equal(next.steps?.clean.status, "pending");
  const backup = (await readdir(storage.resolve("raw/transcripts"))).find((file) => file.includes("before-retranscribe"));
  assert.ok(backup);
  assert.equal(await readFile(storage.resolve("raw/transcripts", backup), "utf8"), corrupt);
});

test("repair persists complete recovery journal before replacing active transcript", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const original = storage.writeJsonAtomic.bind(storage);
  let sawJournal = false;
  storage.writeJsonAtomic = async (file, data) => {
    if (file === "raw/transcripts/repair.json") {
      const journal = await storage.readJson<{ backups: Array<{ backup: string; existed: boolean }> }>(`cache/retranscribe/${id}.json`);
      assert.equal(journal.backups.length, 3);
      for (const backup of journal.backups) if (backup.existed) assert.ok((await readFile(storage.resolve(backup.backup))).length);
      sawJournal = true;
    }
    return original(file, data);
  };
  await jobs.retranscribe(id);
  assert.equal(sawJournal, true);
  await assert.rejects(readFile(storage.resolve(`cache/retranscribe/${id}.json`)));
});

test("cancellation racing state commit restores old files and retains pause even if state write overtakes pause", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = storage.writeJsonAtomic.bind(storage);
  storage.writeJsonAtomic = async (file, data) => {
    if (file === "cache/jobs-index.json" && JSON.stringify(data).includes('"clean":{"status":"pending"')) { entered(); await gate; }
    return original(file, data);
  };
  const run = jobs.retranscribe(id);
  await started;
  const pausing = jobs.pauseStep(id);
  while ((await jobs.get(id))?.steps?.transcribe.status !== "paused") await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  await Promise.all([run, pausing]);
  assert.equal((await jobs.get(id))?.steps?.transcribe.status, "paused");
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
  assert.equal((await jobs.get(id))?.steps?.clean.status, "succeeded");
});

test("restart rejects a forged recovery target and leaves both storage and outside bytes untouched", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const old = (await jobs.get(id))!;
  const outside = path.join(await mkdtemp(path.join(tmpdir(), "journal-outside-")), "private.json");
  await writeFile(outside, "private bytes");
  await storage.writeJsonAtomic(`cache/retranscribe/${id}.json`, {
    version: 1, transactionId: "22222222-2222-4222-8222-222222222222",
    record: { ...old, steps: { ...old.steps!, transcribe: { status: "running", attempts: 1 } } },
    backups: [{ file: outside, backup: "raw/transcripts/repair.json", existed: true }]
  });
  await assert.rejects(new JobStore(storage, {} as ScriptCleaner, {} as MediaService, {} as AsrService).init(), /恢复文件列表无效/);
  assert.equal(await readFile(outside, "utf8"), "private bytes");
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
  assert.ok(await readFile(storage.resolve(`cache/retranscribe/${id}.json`)));
});

test("unrecovered journal blocks pipeline writes and permanent deletion cleans the journal", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const old = (await jobs.get(id))!;
  await jobs.update(id, { steps: { ...old.steps!, clean: { status: "pending", attempts: 0 } } });
  await storage.writeJsonAtomic(`cache/retranscribe/${id}.json`, { incomplete: true });
  for (const run of [() => jobs.runStep(id, "clean"), () => jobs.retranscribe(id), () => jobs.reclean(id, "补充")]) {
    await assert.rejects(run(), /转录恢复/);
  }
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
  await jobs.trash(id);
  assert.equal(await jobs.permanentlyDelete(id), "deleted");
  await assert.rejects(readFile(storage.resolve(`cache/retranscribe/${id}.json`)));
});

test("restart removes an interrupted atomic journal write and ignores Finder metadata without changing active artifacts", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const original = (await jobs.get(id))!;
  await mkdir(storage.resolve("cache/retranscribe"), { recursive: true });
  const orphan = `cache/retranscribe/${id}.json.next-33333333-3333-4333-8333-333333333333`;
  await writeFile(storage.resolve(orphan), '{"version":');
  await writeFile(storage.resolve("cache/retranscribe/.DS_Store"), "Finder metadata");
  const restarted = new JobStore(storage, {} as ScriptCleaner, {} as MediaService, {} as AsrService);
  await restarted.init();
  assert.deepEqual(await restarted.get(id), original);
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
  assert.equal((await storage.readJson<{ cleanScript: string }>("processed/scripts/repair.json")).cleanScript, "旧洗稿");
  await assert.rejects(readFile(storage.resolve(orphan)));
  assert.equal(await readFile(storage.resolve("cache/retranscribe/.DS_Store"), "utf8"), "Finder metadata");
});

test("known harmless journal-directory files do not hide a malformed real recovery record", async () => {
  const { storage, id } = await repairFixture(async () => repairedTranscript);
  await storage.writeJsonAtomic(`cache/retranscribe/${id}.json`, { version: 1 });
  await writeFile(storage.resolve("cache/retranscribe/.DS_Store"), "Finder metadata");
  const restarted = new JobStore(storage, {} as ScriptCleaner, {} as MediaService, {} as AsrService);
  await assert.rejects(restarted.init(), /转录恢复记录无效/);
  assert.deepEqual(await storage.readJson(`cache/retranscribe/${id}.json`), { version: 1 });
});

test("restart preserves and rejects unexpected temporary names rather than deleting arbitrary directory entries", async () => {
  const { storage } = await repairFixture(async () => repairedTranscript);
  await mkdir(storage.resolve("cache/retranscribe"), { recursive: true });
  const unknown = "cache/retranscribe/repair.json.next-not-a-uuid";
  await writeFile(storage.resolve(unknown), "unknown file");
  await assert.rejects(new JobStore(storage, {} as ScriptCleaner, {} as MediaService, {} as AsrService).init(), /文件名无效/);
  assert.equal(await readFile(storage.resolve(unknown), "utf8"), "unknown file");
});

test("startup transaction recovery preserves a deletion made after journal capture and other job edits", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const old = (await jobs.get(id))!;
  const transactionId = "44444444-4444-4444-8444-444444444444";
  const files = ["raw/transcripts/repair.json", "processed/scripts/repair.json", "processed/cleaned/repair.json"];
  const backups = [];
  for (const file of files) {
    const backup = `${file}.before-retranscribe-${transactionId}.json`;
    await writeFile(storage.resolve(backup), await readFile(storage.resolve(file)));
    backups.push({ file, backup, existed: true });
  }
  const running = (await jobs.update(id, { status: "processing", stage: "transcribing", steps: { ...old.steps!, transcribe: { status: "running", attempts: 1 } } }))!;
  await storage.writeJsonAtomic(`cache/retranscribe/${id}.json`, { version: 1, transactionId, record: running, backups });
  const trashed = (await jobs.trash(id))!;
  const other = await jobs.create({ sourceUrl: "https://example.com/another-video", topic: "用户新增的作品" });
  await jobs.update(other.id, { topic: "事务之后更新的标题" });
  await storage.writeJsonAtomic(files[0], { text: "未提交的新转录" });
  const restarted = new JobStore(storage, {} as ScriptCleaner, {} as MediaService, {} as AsrService);
  await restarted.init();
  const restored = (await restarted.get(id))!;
  assert.equal(restored.deletedAt, trashed.deletedAt);
  assert.equal(restored.trashExpiresAt, trashed.trashExpiresAt);
  assert.equal(restored.steps?.transcribe.status, "paused");
  assert.equal((await storage.readJson<{ text: string }>(files[0])).text, "旧转录");
  assert.equal((await restarted.get(other.id))?.topic, "事务之后更新的标题");
  assert.ok((await restarted.listTrash()).some((job) => job.id === id));
});

test("failed transaction rollback preserves a concurrent user deletion and unrelated job changes", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  const other = await jobs.create({ sourceUrl: "https://example.com/another-video", topic: "其它作品" });
  let trashed: Awaited<ReturnType<JobStore["trash"]>>;
  const original = storage.writeJsonAtomic.bind(storage);
  storage.writeJsonAtomic = async (file, data) => {
    if (file === "cache/jobs-index.json" && (data as Record<string, JobRecord>)[id]?.steps?.clean.status === "pending") throw new Error("transaction commit failed");
    const result = await original(file, data);
    if (file === "raw/transcripts/repair.json" && !trashed) {
      trashed = await jobs.trash(id);
      await jobs.update(other.id, { topic: "并发编辑的标题" });
    }
    return result;
  };
  await assert.rejects(jobs.retranscribe(id), /transaction commit failed/);
  const restored = (await jobs.get(id))!;
  assert.ok(trashed?.deletedAt);
  assert.equal(restored.deletedAt, trashed.deletedAt);
  assert.equal(restored.trashExpiresAt, trashed.trashExpiresAt);
  assert.equal(restored.steps?.transcribe.status, "failed");
  assert.equal((await jobs.get(other.id))?.topic, "并发编辑的标题");
  assert.equal((await storage.readJson<{ text: string }>("raw/transcripts/repair.json")).text, "旧转录");
});

test("permanent deletion stays blocked until repair releases its lock after final state commit", async () => {
  const { jobs, storage, id } = await repairFixture(async () => repairedTranscript);
  let entered!: () => void;
  let release!: () => void;
  let held = false;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = storage.writeJsonAtomic.bind(storage);
  storage.writeJsonAtomic = async (file, data) => {
    const result = await original(file, data);
    if (!held && file === "cache/jobs-index.json" && (data as Record<string, JobRecord>)[id]?.steps?.clean.status === "pending") {
      held = true;
      entered();
      await gate;
    }
    return result;
  };
  const run = jobs.retranscribe(id);
  await started;
  try {
    assert.equal((await jobs.get(id))?.status, "queued");
    await jobs.trash(id);
    assert.equal(await jobs.permanentlyDelete(id), "active");
    assert.ok(await readFile(storage.resolve(`cache/retranscribe/${id}.json`)));
    const backups = (await readdir(storage.resolve("raw/transcripts"))).filter((file) => file.includes("before-retranscribe"));
    assert.equal(backups.length, 1);
    assert.equal((await storage.readJson<{ text: string }>(`raw/transcripts/${backups[0]}`)).text, "旧转录");
  } finally {
    release();
    await run.catch(() => undefined);
  }
  assert.equal((await jobs.get(id))?.steps?.transcribe.status, "succeeded");
  assert.equal(await jobs.permanentlyDelete(id), "deleted");
  await assert.rejects(readFile(storage.resolve("raw/transcripts/repair.json")));
});


test("video audio persists across retries, explicit regeneration preserves old artifacts on failure and concurrent work stays locked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jobs-video-audio-'));
  const storage = new LocalStorage(root);
  const options = { voiceover: true, rate: 210, backgroundVolume: .12 };
  let calls = 0;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const videoGenerator = { async generate(_script: ScriptAsset, _id: string, _progress: unknown, _signal: unknown, audio: unknown) {
    assert.deepEqual(audio, options); calls++;
    if (calls === 1) { entered!(); await wait; }
    throw new Error('local audio render failed');
  } } as unknown as HyperframesVideoGenerator;
  const jobs = new JobStore(storage, { async clean(input) { return input.draft; } }, {} as MediaService, {} as AsrService, videoGenerator);
  await jobs.init();
  const initial = await jobs.create({ sourceUrl: 'https://example.com/video', topic: 'audio retry' });
  const record: JobRecord = { ...initial, status: 'done', stage: 'rendered', videoOutputPath: 'output/videos/old.mp4', steps: {
    transcribe: { status: 'succeeded', attempts: 1 }, clean: { status: 'succeeded', attempts: 1 },
    generate_video_prompts: { status: 'succeeded', attempts: 1 }, generate_video: { status: 'succeeded', attempts: 1 }
  } };
  await storage.writeJson('cache/jobs-index.json', { [record.id]: record });
  const script = { sourceUrl: record.sourceUrl, topic: record.topic, rawText: '中文', status: 'rendered', videoPrompts: ['旧分镜'], hyperframesVideo: { videoPath: 'old.mp4' } };
  await storage.writeJson(record.storagePath, script);
  await assert.rejects(jobs.runStep(record.id, 'generate_video'), /already succeeded/);
  await assert.rejects(jobs.runStep(record.id, 'generate_video', { rate: 999 }), (error: unknown) => error instanceof JobStepError && error.statusCode === 400);
  await assert.rejects(jobs.runStep(record.id, 'clean', options), (error: unknown) => error instanceof JobStepError && error.statusCode === 400);
  const rendering = assert.rejects(jobs.runStep(record.id, 'generate_video', options), /local audio render failed/);
  await started;
  await assert.rejects(jobs.runStep(record.id, 'generate_video', options), /running|正在执行/i);
  release!(); await rendering;
  assert.deepEqual((await jobs.get(record.id))?.videoAudio, options);
  assert.equal((await jobs.get(record.id))?.videoOutputPath, record.videoOutputPath);
  assert.deepEqual(await storage.readJson(record.storagePath), script);
  await assert.rejects(jobs.runStep(record.id, 'generate_video'), /local audio render failed/);
  assert.equal(calls, 2);
  await rm(root, { recursive: true, force: true });
});
