import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { resolveSourceVideo } from "./video-output.js";
import { inspectTranscriptQuality } from "./transcript-quality.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fetchDouyinPageInfo } from "./douyin-page.js";
import type { DouyinPageInfo } from "./douyin-page.js";
import { buildScriptDraft } from "./script-builder.js";
import type { ScriptCleaner } from "./ai-cleaner.js";
import type { MediaService } from "./media.js";
import type { AsrService } from "./asr.js";
import type { TranscriptProofreader } from './transcript-proofreader.js';
import type { TranscriptResult } from "./asr.js";
import { isYouTubeUrl } from "./youtube.js";
import { LocalStorage } from "./storage.js";
import { parseDouyinShare } from "./douyin.js";
import { parseVideoAudioOptions } from './video-audio.js';
import { toSimplifiedChinese } from "./chinese.js";
import { JobStepEventHub } from "./job-step-events.js";
import type { HyperframesVideoGenerator } from "./hyperframes-video.js";
import type {
  VideoAudioOptions,
  JobStepStreamEvent,
  JobOverview,
  JobPreview,
  JobRecord,
  JobStatus,
  JobStage,
  PipelineStep,
  PipelineStepState,
  PipelineSteps,
  ScriptAsset,
  StreamablePipelineStep,
  TranscriptAsset
} from "../types.js";

const JOBS_INDEX = "cache/jobs-index.json";
const TRASH_RETENTION_DAYS = 30;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_STEP_ATTEMPTS = 3;
const PIPELINE_STEPS: PipelineStep[] = [
  "transcribe",
  "clean",
  "generate_video_prompts",
  "generate_video"
];
const STEP_LABELS: Record<PipelineStep, string> = {
  transcribe: "视频转录",
  clean: "AI 洗稿",
  generate_video_prompts: "生成分镜",
  generate_video: "生成视频"
};
const STEP_STAGE: Record<PipelineStep, { running: JobStage; succeeded: JobStage }> = {
  transcribe: { running: "transcribing", succeeded: "transcribed" },
  clean: { running: "cleaning", succeeded: "cleaned" },
  generate_video_prompts: { running: "generating-video-prompts", succeeded: "scripted" },
  generate_video: { running: "generating-video", succeeded: "rendered" }
};
const LEGACY_ACTIVE_STAGE_STEP: Partial<Record<JobStage, PipelineStep>> = {
  downloading: "transcribe",
  extracting: "transcribe",
  transcribing: "transcribe",
  cleaning: "clean",
  "generating-video-prompts": "generate_video_prompts",
  "generating-video": "generate_video"
};
const STEP_PREVIOUS: Partial<Record<PipelineStep, PipelineStep>> = {
  clean: "transcribe",
  generate_video_prompts: "clean",
  generate_video: "generate_video_prompts"
};

type JobsIndex = Record<string, JobRecord>;
type RetranscriptJournal = {
  version: 1;
  transactionId: string;
  record: JobRecord;
  backups: Array<{ file: string; backup: string; existed: boolean }>;
};
type ActiveStepRun = {
  step: PipelineStep;
  controller: AbortController;
  cancelRequested: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
};
type ParsedShare = NonNullable<ReturnType<typeof parseDouyinShare>>;
type PageInfoRecord = DouyinPageInfo & { errorMessage?: string };
type PermanentDeleteResult = "deleted" | "not_found" | "active" | "not_in_trash";

export class JobStepError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly job?: JobRecord) {
    super(message);
    this.name = "JobStepError";
  }
}

function firstText(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const text = value.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function isStreamableStep(step: PipelineStep): step is StreamablePipelineStep {
  return step === "clean" || step === "generate_video_prompts";
}

export class JobStore {
  private readonly runningSteps = new Set<string>();
  private readonly activeRuns = new Map<string, ActiveStepRun>();
  private readonly stepEvents = new JobStepEventHub();

  constructor(
    private readonly storage: LocalStorage,
    private readonly cleaner: ScriptCleaner,
    private readonly media: MediaService,
    private readonly asr: AsrService,
    private readonly videoGenerator?: HyperframesVideoGenerator,
    private readonly proofreader?: Pick<TranscriptProofreader, 'proofread'>
  ) {}

  async init() {
    await this.storage.ensureBaseDirs();
    let index: JobsIndex;
    try {
      index = await this.storage.readJson<JobsIndex>(JOBS_INDEX);
    } catch {
      index = {};
      await this.storage.writeJsonAtomic(JOBS_INDEX, index);
    }
    await this.recoverRetranscriptTransactions(index);
    if (this.recoverInterruptedSteps(index)) {
      await this.storage.writeJsonAtomic(JOBS_INDEX, index);
    }
    await this.purgeExpiredTrash();
  }

  private async storedFileExists(relativePath: string) {
    try {
      await stat(this.storage.resolve(relativePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async recoverRetranscriptTransactions(index: JobsIndex) {
    const directory = "cache/retranscribe";
    const entries = await readdir(this.storage.resolve(directory)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry === ".DS_Store") continue;
      if (/^[a-z0-9-]+\.json\.next-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry)) {
        await rm(this.storage.resolve(directory, entry), { force: true });
        continue;
      }
      if (!/^[a-z0-9-]+\.json$/i.test(entry)) throw new Error("转录恢复记录文件名无效，请保留历史副本并检查本地存储");
      const id = entry.slice(0, -5);
      const journalPath = path.join(directory, entry);
      const journal = await this.storage.readJson<RetranscriptJournal>(journalPath);
      const record = journal.record;
      if (journal.version !== 1 || typeof journal.transactionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(journal.transactionId) ||
        !record || record.id !== id || typeof record.storagePath !== "string" || record.steps?.transcribe.status !== "running" ||
        !index[id] || record.createdAt !== index[id].createdAt || !Array.isArray(journal.backups)) {
        throw new Error("转录恢复记录无效，请保留历史副本并检查本地存储");
      }
      const files = [path.join("raw", "transcripts", `${id}.json`), record.storagePath, path.join("processed", "cleaned", `${id}.json`)];
      if (journal.backups.length !== files.length || journal.backups.some((backup, position) =>
        !backup || backup.file !== files[position] || typeof backup.existed !== "boolean" ||
        backup.backup !== path.join(path.dirname(files[position]), `${id}.json.before-retranscribe-${journal.transactionId}.json`))) {
        throw new Error("转录恢复文件列表无效，请保留历史副本并检查本地存储");
      }
      await this.restoreRetranscriptFiles(journal.backups);
      index[id] = { ...record, deletedAt: index[id].deletedAt, trashExpiresAt: index[id].trashExpiresAt };
      await this.storage.writeJsonAtomic(JOBS_INDEX, index);
      await rm(this.storage.resolve(journalPath));
    }
  }

  private async restoreRetranscriptFiles(backups: RetranscriptJournal["backups"]) {
    const root = await realpath(this.storage.resolve());
    for (const { file, backup, existed } of backups) {
      const destination = this.toStorageFilePath(file);
      if (!destination) throw new Error("转录恢复路径超出本地存储范围");
      const parent = await realpath(path.dirname(destination));
      const relative = path.relative(root, parent);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("转录恢复目录超出本地存储范围");
      if (existed) {
        const restoring = `${destination}.restore-${randomUUID()}`;
        try {
          await this.copyStoredSnapshot(this.storage.resolve(backup), restoring);
          await rename(restoring, destination);
        } finally { await rm(restoring, { force: true }); }
      } else await rm(destination, { force: true });
    }
  }

  private recoverInterruptedSteps(index: JobsIndex) {
    let changed = false;
    const now = new Date().toISOString();
    const message = "应用重启时中断了正在执行的步骤，已暂停，请重新执行";

    for (const record of Object.values(index)) {
      if (record.status !== "processing" && !record.steps) {
        continue;
      }

      const steps = this.ensurePipelineSteps(record.steps);
      const interrupted = PIPELINE_STEPS.filter((step) => steps[step].status === "running");
      const inferredStep = interrupted[0] ?? LEGACY_ACTIVE_STAGE_STEP[record.stage];
      const isActiveRecord = record.status === "processing";
      if (!isActiveRecord && interrupted.length === 0) continue;

      const stepsToPause = new Set(interrupted);
      if (inferredStep && steps[inferredStep].status !== "succeeded") {
        stepsToPause.add(inferredStep);
      }
      for (const step of stepsToPause) {
        steps[step] = {
          ...steps[step],
          status: "paused",
          lastError: message,
          finishedAt: now
        };
      }

      index[record.id] = {
        ...record,
        workflowMode: "manual",
        status: "queued",
        errorMessage: stepsToPause.size > 0 ? message : "应用重启后未找到正在执行的步骤，已暂停，请检查并重试",
        updatedAt: now,
        steps
      };
      changed = true;
    }

    return changed;
  }

  async create(input: { sourceUrl?: string; shareText?: string; topic?: string; coverUrl?: string }) {
    const now = new Date().toISOString();
    const shareText = input.shareText?.trim() ?? "";
    const parsed = shareText ? parseDouyinShare({ shareText, sourceUrl: input.sourceUrl }) : null;
    const sourceUrl = input.sourceUrl ?? parsed?.sourceUrl ?? "";
    if (!sourceUrl) {
      throw new Error("sourceUrl or shareText with url is required");
    }
    const topic = input.topic ?? parsed?.topicCandidate ?? "skills分享";
    const id = randomUUID();
    const storagePath = path.join("processed", "scripts", `${id}.json`);
    const record: JobRecord = {
      id,
      sourceUrl,
      topic,
      coverUrl: input.coverUrl?.trim() || undefined,
      status: "queued",
      stage: parsed ? "parsed" : "submitted",
      workflowMode: "manual",
      steps: this.createInitialSteps(),
      createdAt: now,
      updatedAt: now,
      storagePath
    };
    const index = await this.readIndex();
    index[id] = record;
    await this.writeIndex(index);
    if (parsed) {
      await this.storage.writeJson(path.join("raw", "text", `${id}.json`), parsed);
    }

    return record;
  }

  async runStep(id: string, step: PipelineStep, audio?: unknown) {
    let options: VideoAudioOptions | undefined;
    if (audio !== undefined) {
      if (step !== 'generate_video') throw new JobStepError('音频选项只用于生成视频', 400);
      try { options = parseVideoAudioOptions(audio); }
      catch (error) { throw new JobStepError(error instanceof Error ? error.message : '音频选项无效', 400); }
    }
    return this.runStepInternal(id, step, false, options);
  }

  async retranscribe(id: string): Promise<JobRecord> {
    return this.runStepInternal(id, "transcribe", true);
  }

  private async runStepInternal(id: string, step: PipelineStep, retranscribe = false, audio?: VideoAudioOptions) {
    if (this.runningSteps.has(id)) {
      throw new JobStepError("another step is already running for this job", 409);
    }

    this.runningSteps.add(id);
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const activeRun: ActiveStepRun = {
      step,
      controller: new AbortController(),
      cancelRequested: false,
      settled,
      resolveSettled
    };
    this.activeRuns.set(id, activeRun);
    try {
      const record = await this.getStepRunnableRecord(id, step, retranscribe, audio !== undefined);
      if (audio) record.videoAudio = audio;
      // A failed repair retried through the ordinary step must preserve the same history contract.
      retranscribe ||= step === "transcribe" && await this.storedFileExists(path.join("raw", "transcripts", `${id}.json`));
      await this.markStepRunning(record, step);
      if (isStreamableStep(step)) {
        this.stepEvents.publish(id, step, { type: "started" });
      }

      let lastError = "";
      const maxAttempts = step === "generate_video" ? 1 : MAX_STEP_ATTEMPTS;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (activeRun.cancelRequested) {
          return (await this.get(id)) ?? record;
        }
        await this.updateStep(id, step, { attempts: attempt });
        try {
          const committed = await this.executeStepAction(id, step, activeRun.controller.signal, retranscribe);
          if (activeRun.cancelRequested) {
            return (await this.get(id)) ?? record;
          }
          const succeeded = committed ?? await this.markStepSucceeded(id, step);
          if (isStreamableStep(step)) {
            this.stepEvents.publish(id, step, { type: "completed" });
          }
          return succeeded;
        } catch (error) {
          if (activeRun.cancelRequested) {
            return (await this.get(id)) ?? record;
          }
          lastError = error instanceof Error ? error.message : String(error);
          await this.updateStep(id, step, { attempts: attempt, lastError });
        }
      }

      const failed = await this.markStepFailed(id, step, lastError || "step failed");
      if (isStreamableStep(step)) {
        this.stepEvents.publish(id, step, { type: "error", message: lastError || "step failed" });
      }
      throw new JobStepError(lastError || "step failed", 500, failed);
    } finally {
      this.runningSteps.delete(id);
      this.activeRuns.delete(id);
      activeRun.resolveSettled();
    }
  }

  async pauseStep(id: string) {
    const record = await this.get(id);
    if (!record) {
      throw new JobStepError("job not found", 404);
    }
    if (record.deletedAt) {
      throw new JobStepError("deleted job cannot pause steps", 409, record);
    }
    if (record.workflowMode !== "manual" || !record.steps) {
      throw new JobStepError("manual workflow steps are not available for this job", 409, record);
    }

    const steps = this.ensurePipelineSteps(record.steps);
    const step = PIPELINE_STEPS.find((candidate) => steps[candidate].status === "running");
    if (!step) {
      throw new JobStepError("no step is currently running", 409, record);
    }

    const activeRun = this.activeRuns.get(id);
    if (activeRun) {
      activeRun.cancelRequested = true;
      activeRun.controller.abort();
    }

    const paused = await this.updateStep(
      id,
      step,
      {
        status: "paused",
        lastError: "用户已暂停当前步骤，可重新执行",
        finishedAt: new Date().toISOString()
      },
      {
        status: "queued",
        errorMessage: "用户已暂停当前步骤，可重新执行"
      }
    );
    if (isStreamableStep(step)) {
      this.stepEvents.publish(id, step, { type: "paused", message: "用户已暂停当前步骤，可重新执行" });
    }

    if (activeRun) {
      await activeRun.settled;
      return (await this.get(id)) ?? paused;
    }
    return paused;
  }

  async reclean(id: string, supplementalText: string) {
    const text = supplementalText?.trim() ?? "";
    if (!text) {
      throw new JobStepError("补充内容不能为空", 400);
    }
    if (this.runningSteps.has(id)) {
      throw new JobStepError("another step is already running for this job", 409);
    }

    this.runningSteps.add(id);
    try {
      const record = await this.get(id);
      if (!record) {
        throw new JobStepError("job not found", 404);
      }
      if (record.deletedAt) {
        throw new JobStepError("deleted job cannot run steps", 409, record);
      }
      if (await this.storedFileExists(path.join("cache", "retranscribe", `${id}.json`))) {
        throw new JobStepError("有未完成的转录恢复，请重启应用恢复历史成果后重试", 409, record);
      }
      if (record.workflowMode !== "manual" || !record.steps) {
        throw new JobStepError("manual workflow steps are not available for this job", 409, record);
      }
      const steps = this.ensurePipelineSteps(record.steps);
      if (steps.clean.status === "running") {
        throw new JobStepError("step is already running", 409, record);
      }
      if (steps.transcribe.status !== "succeeded") {
        throw new JobStepError("previous step has not succeeded", 409, record);
      }

      try {
        await this.markStepRunning(record, "clean");
        this.stepEvents.publish(id, "clean", { type: "started" });

        const context = await this.buildCleanContext(id);
        await this.storage.writeJson(context.record.storagePath, context.draft);
        const cleaned = await this.cleaner.clean({
          parsed: context.parsed,
          transcriptText: context.transcriptText,
          topic: context.record.topic,
          draft: context.draft,
          pageInfo: context.pageInfo,
          supplementalText: text
        }, undefined, (update) => {
          this.stepEvents.publish(id, "clean", { type: "preview", ...update });
        });
        await this.persistCleaned(id, context, text, cleaned);

        await this.resetDownstreamAfterReclean(id);
        const succeeded = await this.markStepSucceeded(id, "clean");
        this.stepEvents.publish(id, "clean", { type: "completed" });
        return succeeded;
      } catch (error) {
        const message = error instanceof Error ? error.message : "reclean failed";
        const failed = await this.markStepFailed(id, "clean", message);
        this.stepEvents.publish(id, "clean", { type: "error", message });
        throw new JobStepError(message, 500, failed);
      }
    } finally {
      this.runningSteps.delete(id);
    }
  }

  private async resetDownstreamAfterReclean(id: string) {
    for (const step of ["generate_video_prompts", "generate_video"] as const) {
      await this.updateStep(id, step, {
        status: "pending",
        attempts: 0,
        lastError: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        phase: undefined,
        progress: undefined
      });
    }
    await this.update(id, {
      videoProjectPath: undefined,
      videoOutputPath: undefined,
      videoGeneratedAt: undefined
    });
  }

  subscribeStepEvents(
    id: string,
    step: StreamablePipelineStep,
    listener: (event: JobStepStreamEvent) => void,
    afterId = 0
  ) {
    return this.stepEvents.subscribe(id, step, listener, afterId);
  }

  private async getStepRunnableRecord(id: string, step: PipelineStep, retranscribe = false, explicitVideoOptions = false) {
    const record = await this.get(id);
    if (!record) {
      throw new JobStepError("job not found", 404);
    }
    if (record.deletedAt) {
      throw new JobStepError("deleted job cannot run steps", 409, record);
    }
    if (await this.storedFileExists(path.join("cache", "retranscribe", `${id}.json`))) {
      throw new JobStepError("有未完成的转录恢复，请重启应用恢复历史成果后重试", 409, record);
    }
    if (record.workflowMode !== "manual" || !record.steps) {
      throw new JobStepError("manual workflow steps are not available for this job", 409, record);
    }

    const steps = this.ensurePipelineSteps(record.steps);
    const current = steps[step];
    if (current.status === "running") {
      throw new JobStepError("step is already running", 409, record);
    }
    if (current.status === "succeeded" && !retranscribe && !(step === "generate_video" && explicitVideoOptions)) {
      throw new JobStepError("step has already succeeded", 409, record);
    }
    const previous = STEP_PREVIOUS[step];
    if (previous && steps[previous].status !== "succeeded") {
      throw new JobStepError("previous step has not succeeded", 409, record);
    }
    if (PIPELINE_STEPS.some((candidate) => steps[candidate].status === "running")) {
      throw new JobStepError("another step is already running for this job", 409, record);
    }

    return {
      ...record,
      steps
    };
  }

  private async executeStepAction(id: string, step: PipelineStep, signal?: AbortSignal, retranscribe = false): Promise<JobRecord | void> {
    if (step === "transcribe") {
      if (retranscribe) return this.runRetranscribeAction(id, signal);
      await this.runTranscribeStep(id, signal);
      return;
    }
    if (step === "clean") {
      await this.runCleanStep(id, signal);
      return;
    }
    if (step === "generate_video_prompts") {
      await this.runGenerateVideoPromptsStep(id, signal);
      return;
    }
    await this.runGenerateVideoStep(id, signal);
  }

  private async runDownloadStep(id: string) {
    const record = await this.requireRecord(id);
    const downloadResult = await this.media.downloadVideo(record.sourceUrl, id);
    await this.update(id, {
      videoPath: downloadResult.videoPath,
      videoMetadataPath: downloadResult.metadataPath,
      downloadErrorMessage: undefined
    });
    if (isYouTubeUrl(record.sourceUrl)) {
      await this.storage.writeJson(path.join("raw", "page", `${id}.json`), {
        requestedUrl: record.sourceUrl, finalUrl: record.sourceUrl, canonicalUrl: record.sourceUrl,
        pageTitle: downloadResult.metadata.title, pageDescription: downloadResult.metadata.description,
        authorName: downloadResult.metadata.uploader, isChallengePage: false, redirectChain: []
      });
    } else await this.writePageInfoBestEffort(id, record.sourceUrl);
  }

  private async runExtractAudioStep(id: string) {
    const record = await this.requireRecord(id);
    if (!record.videoPath) {
      throw new Error("video file is missing; transcription could not download the source video");
    }

    const audioResult = await this.media.extractAudio(record.videoPath, id);
    await this.update(id, {
      audioPath: audioResult.audioPath,
      audioManifestPath: audioResult.manifestPath,
      audioErrorMessage: undefined
    });
  }

  private async runTranscribeStep(id: string, signal?: AbortSignal) {
    let record = await this.requireRecord(id);
    if (!record.videoPath) {
      await this.update(id, { status: "processing", stage: "downloading" });
      await this.runDownloadStep(id);
      record = await this.requireRecord(id);
    }
    const captions = await this.readYouTubeCaptions(record);
    if (!captions && !(await this.isWhisperReadyAudio(id, record.audioPath))) {
      await this.update(id, { status: "processing", stage: "extracting" });
      await this.runExtractAudioStep(id);
      record = await this.requireRecord(id);
    }
    await this.update(id, { status: "processing", stage: "transcribing" });
    const audioPath = record.audioPath;
    if (!audioPath && !captions) {
      throw new Error("audio file is missing; transcription could not extract audio from the source video");
    }

    const transcriptAsset = await this.createTranscriptAsset(id, audioPath ?? "", undefined, captions ?? undefined, signal);
    signal?.throwIfAborted();
    const transcriptPath = path.join("raw", "transcripts", `${id}.json`);
    await this.storage.writeJsonAtomic(transcriptPath, transcriptAsset);
    await this.update(id, {
      transcriptPath,
      transcriptModel: transcriptAsset.model,
      transcriptErrorMessage: undefined
    });
  }

  private async readYouTubeCaptions(record: JobRecord) {
    if (!isYouTubeUrl(record.sourceUrl) || !this.media.readYouTubeCaptions) return null;
    const metadata = await this.readOptionalJson<{ duration?: number }>(path.join("raw", "videos", `${record.id}.info.json`));
    return this.media.readYouTubeCaptions(record.id, metadata?.duration);
  }

  private async createTranscriptAsset(id: string, audioPath: string, duration?: number, captions?: TranscriptResult, signal?: AbortSignal): Promise<TranscriptAsset> {
    const record = await this.requireRecord(id);
    const youtube = isYouTubeUrl(record.sourceUrl);
    const result = captions ?? await this.asr.transcribe(audioPath, youtube ? "auto" : "zh");
    const normalize = (text: string) => youtube ? text : toSimplifiedChinese(text);
    const text = result?.text ? normalize(result.text).trim() : "";
    if (!result || !text) throw new Error("ASR returned no transcript; check ASR configuration and retry");
    const manifest = await this.readOptionalJson<{ duration?: number; audio?: { duration?: number }; source?: { duration?: number } }>(path.join("raw", "audio", `${id}.json`));
    const actualDuration = duration ?? (captions ? captions.duration : undefined) ?? manifest?.audio?.duration ?? manifest?.source?.duration ?? manifest?.duration ?? result.duration;
    const segments = result.segments.map((segment) => ({ ...segment, text: normalize(segment.text) }));
    const issues = inspectTranscriptQuality({ segments, text, duration: actualDuration });
    if (issues.length) throw new Error(`转录异常：${issues.join("；")}`);
    const asset: TranscriptAsset = {
      jobId: id, sourceUrl: record.sourceUrl, audioPath,
      transcript: text, text, segments,
      words: result.words?.map((word) => ({ ...word, word: normalize(word.word) })),
      duration: actualDuration, language: result.language, model: result.model, provider: result.provider,
      createdAt: new Date().toISOString()
    };
    signal?.throwIfAborted();
    return this.proofreader ? this.proofreader.proofread(asset, signal) : asset;
  }

  private async runRetranscribeAction(id: string, signal?: AbortSignal): Promise<JobRecord> {
    const record = await this.requireRecord(id);
    const workDir = await mkdtemp(path.join(tmpdir(), "douyin-retranscribe-"));
    let source: Awaited<ReturnType<typeof resolveSourceVideo>> | undefined;
    const extractionId = `${id}-repair-${randomUUID()}`;
    let extracted: Awaited<ReturnType<MediaService["extractAudio"]>> | undefined;
    let committed = false;
    try {
      source = await resolveSourceVideo(this.storage.resolve(), record);
      const captions = await this.readYouTubeCaptions(record);
      let audioPath: string;
      if (captions) audioPath = record.audioPath ?? "";
      else if (await this.isWhisperReadyAudio(id, record.audioPath)) {
        audioPath = path.join(workDir, "audio.wav");
        await this.copyStoredSnapshot(record.audioPath!, audioPath);
      } else {
        const videoSnapshot = path.join(workDir, "source.mp4");
        const before = await source.handle.stat();
        await pipeline(source.handle.createReadStream({ autoClose: false }), createWriteStream(videoSnapshot));
        const after = await source.handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("原视频在读取期间发生变化");
        extracted = await this.media.extractAudio(videoSnapshot, extractionId);
        audioPath = extracted.audioPath;
      }
      const transcript = await this.createTranscriptAsset(id, audioPath, extracted?.duration, captions ?? undefined, signal);
      transcript.audioPath = extracted?.audioPath ?? record.audioPath ?? "";
      signal?.throwIfAborted();
      const next = await this.commitRetranscript(record, transcript, extracted, signal);
      committed = true;
      return next;
    } finally {
      await source?.close();
      await rm(workDir, { recursive: true, force: true });
      if (!committed) {
        await Promise.all(["wav", "json"].map((extension) => rm(this.storage.resolve("raw/audio", `${extractionId}.${extension}`), { force: true })));
      }
    }
  }

  private async copyStoredSnapshot(candidatePath: string, snapshotPath: string) {
    const storageRoot = path.resolve(this.storage.resolve());
    const canonicalRoot = await realpath(storageRoot);
    const candidate = path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(storageRoot, candidatePath);
    const inside = (root: string, file: string) => {
      const relative = path.relative(root, file);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    if (!inside(storageRoot, candidate) && !inside(canonicalRoot, candidate)) throw new Error("文件路径超出本地存储范围");
    const handle = await open(candidate, "r");
    try {
      const canonical = await realpath(candidate);
      const info = await handle.stat();
      const current = await stat(candidate);
      if (!inside(canonicalRoot, canonical) || !info.isFile() || info.ino !== current.ino || info.dev !== current.dev) throw new Error("文件不可读取或已变化");
      await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(snapshotPath, { flags: "wx" }));
      const after = await handle.stat();
      if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error("文件在读取期间发生变化");
    } finally { await handle.close(); }
  }

  private async commitRetranscript(record: JobRecord, transcript: TranscriptAsset, extracted?: Awaited<ReturnType<MediaService["extractAudio"]>>, signal?: AbortSignal) {
    const transcriptPath = path.join("raw", "transcripts", `${record.id}.json`);
    const files = [transcriptPath, record.storagePath, path.join("processed", "cleaned", `${record.id}.json`)];
    const backups: Array<{ file: string; backup: string; existed: boolean }> = [];
    const transactionId = randomUUID();
    const journalPath = path.join("cache", "retranscribe", `${record.id}.json`);
    if (await this.storedFileExists(journalPath)) throw new Error("有未完成的转录恢复，请重启应用恢复历史成果后重试");
    const suffix = `.before-retranscribe-${transactionId}.json`;
    for (const file of files) {
      const relative = path.relative(this.storage.resolve(), this.storage.resolve(file));
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("历史成果路径超出本地存储范围");
      const backup = path.join(path.dirname(file), `${record.id}.json${suffix}`);
      try {
        await this.copyStoredSnapshot(this.storage.resolve(file), this.storage.resolve(backup));
        backups.push({ file, backup, existed: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        backups.push({ file, backup, existed: false });
      }
    }
    const journal: RetranscriptJournal = { version: 1, transactionId, record, backups };
    await this.storage.writeJsonAtomic(journalPath, journal);
    let changed = false;
    try {
      signal?.throwIfAborted();
      await this.storage.writeJsonAtomic(transcriptPath, transcript);
      changed = true;
      for (const file of files.slice(1)) await rm(this.storage.resolve(file), { force: true });
      signal?.throwIfAborted();
      const index = await this.readIndex();
      const current = index[record.id];
      if (!current) throw new Error("job not found");
      const steps = this.ensurePipelineSteps(current.steps);
      for (const step of PIPELINE_STEPS.slice(1)) steps[step] = { status: "pending", attempts: 0 };
      steps.transcribe = { ...steps.transcribe, status: "succeeded", lastError: undefined, finishedAt: new Date().toISOString() };
      const next: JobRecord = {
        ...current, steps, status: "queued", stage: "transcribed", transcriptPath, transcriptModel: transcript.model,
        transcriptErrorMessage: undefined, errorMessage: undefined, videoProjectPath: undefined, videoOutputPath: undefined, videoGeneratedAt: undefined,
        ...(extracted ? { audioPath: extracted.audioPath, audioManifestPath: extracted.manifestPath, audioErrorMessage: undefined } : {}),
        updatedAt: new Date().toISOString()
      };
      index[record.id] = next;
      await this.storage.writeJsonAtomic(JOBS_INDEX, index);
      signal?.throwIfAborted();
      await rm(this.storage.resolve(journalPath));
      return next;
    } catch (error) {
      if (changed) {
        await this.restoreRetranscriptFiles(backups);
        const index = await this.readIndex();
        const paused = index[record.id];
        const restored = { ...record, deletedAt: paused?.deletedAt, trashExpiresAt: paused?.trashExpiresAt };
        index[record.id] = signal?.aborted
          ? { ...restored, status: "queued", errorMessage: "用户已暂停当前步骤，可重新执行", steps: { ...record.steps!, transcribe:
            paused?.steps?.transcribe.status === "paused" ? paused.steps.transcribe : {
              ...record.steps!.transcribe, status: "paused", lastError: "用户已暂停当前步骤，可重新执行", finishedAt: new Date().toISOString()
            } } }
          : restored;
        await this.storage.writeJsonAtomic(JOBS_INDEX, index);
      }
      await rm(this.storage.resolve(journalPath), { force: true });
      throw error;
    }
  }

  private async isWhisperReadyAudio(id: string, audioPath?: string) {
    if (!audioPath || path.extname(audioPath).toLowerCase() !== ".wav") {
      return false;
    }

    const manifest = await this.readOptionalJson<{
      status?: string;
      args?: string[];
      audio?: {
        streams?: Array<{
          codec_name?: unknown;
          channels?: unknown;
          sample_rate?: unknown;
        }>;
      };
    }>(path.join("raw", "audio", `${id}.json`));
    if (!manifest || manifest.status !== "ready") {
      return false;
    }

    const args = manifest.args ?? [];
    const stream = manifest.audio?.streams?.find((candidate) => candidate.codec_name || candidate.sample_rate);
    return (
      args.includes("pcm_s16le") &&
      args.includes("16000") &&
      args.includes("1") &&
      (!stream ||
        (stream.codec_name === "pcm_s16le" &&
          Number(stream.channels) === 1 &&
          String(stream.sample_rate) === "16000"))
    );
  }

  private async runCleanStep(id: string, signal?: AbortSignal) {
    const context = await this.buildCleanContext(id);
    await this.storage.writeJson(context.record.storagePath, context.draft);
    const cleaned = await this.cleaner.clean({
      parsed: context.parsed,
      transcriptText: context.transcriptText,
      topic: context.record.topic,
      draft: context.draft,
      pageInfo: context.pageInfo
    }, signal, (update) => {
      this.stepEvents.publish(id, "clean", { type: "preview", ...update });
    });
    await this.persistCleaned(id, context, undefined, cleaned);
    await this.update(id, { errorMessage: undefined });
  }

  private async buildCleanContext(id: string) {
    const record = await this.requireRecord(id);
    const parsed = await this.readParsedShare(id);
    const pageInfo = await this.readPageInfo(id);
    const transcript = await this.readTranscript(id);
    const transcriptText = transcript?.transcript?.trim() || transcript?.text?.trim() || "";
    if (!transcriptText) {
      throw new Error("transcript is missing; run ASR transcription first");
    }
    const manifest = await this.readOptionalJson<{ audio?: { duration?: number }; source?: { duration?: number }; duration?: number }>(path.join("raw", "audio", `${id}.json`));
    const duration = manifest?.audio?.duration ?? manifest?.source?.duration ?? manifest?.duration ?? transcript?.duration;
    const issues = inspectTranscriptQuality({ segments: transcript?.segments ?? [], text: transcriptText, duration });
    if (issues.length) throw new Error(`转录异常：${issues.join("；")}`);
    const draft = this.defaultScriptAsset(record.sourceUrl, record.topic, parsed, pageInfo, transcriptText);
    return { record, parsed, pageInfo, transcriptText, draft };
  }

  private async persistCleaned(
    id: string,
    context: {
      record: JobRecord;
      parsed: ParsedShare | null;
      pageInfo: PageInfoRecord | null;
      transcriptText: string;
    },
    supplementalText: string | undefined,
    cleaned: ScriptAsset
  ) {
    await this.storage.writeJson(context.record.storagePath, cleaned);
    await this.storage.writeJson(path.join("processed", "cleaned", `${id}.json`), {
      jobId: id,
      sourceUrl: context.record.sourceUrl,
      topic: context.record.topic,
      createdAt: context.record.createdAt,
      aiModel: cleaned.aiModel,
      cleaningMode: cleaned.cleaningMode,
      pageInfo: context.pageInfo,
      parsed: context.parsed,
      transcriptText: context.transcriptText,
      ...(supplementalText?.trim() ? { supplementalText: supplementalText.trim() } : {}),
      output: cleaned
    });
  }

  private async runGenerateVideoPromptsStep(id: string, signal?: AbortSignal) {
    const record = await this.requireRecord(id);
    const script = await this.storage.readJson<ScriptAsset>(record.storagePath);
    if (!script.cleanScript?.trim() && !script.voiceoverScript?.trim()) {
      throw new Error("clean script is missing; run AI rewrite first");
    }
    if (!this.cleaner.planShortVideo) {
      throw new Error("AI 分镜服务不可用");
    }
    const plan = await this.cleaner.planShortVideo(script, signal, (update) => {
      this.stepEvents.publish(id, "generate_video_prompts", { type: "preview", ...update });
    });
    const enhanced: ScriptAsset = {
      ...script,
      planVersion: plan.planVersion,
      targetDuration: plan.targetDuration,
      shortVideoScript: plan.shortVideoScript,
      shortVideoShots: plan.shots,
      videoEnhancedAt: new Date().toISOString()
    };

    await this.storage.writeJson(record.storagePath, enhanced);
    const cleanedPath = path.join("processed", "cleaned", `${id}.json`);
    const cleaned = await this.readOptionalJson<Record<string, unknown>>(cleanedPath);
    if (cleaned) {
      await this.storage.writeJson(cleanedPath, {
        ...cleaned,
        output: enhanced
      });
    }
    await this.update(id, { errorMessage: undefined });
  }

  private async runGenerateVideoStep(id: string, signal?: AbortSignal) {
    if (!this.videoGenerator) {
      throw new Error("HyperFrames video generator is not configured");
    }

    const record = await this.requireRecord(id);
    const script = await this.storage.readJson<ScriptAsset>(record.storagePath);
    if (!script.shortVideoShots?.length && !script.videoPrompts?.length && !script.enhancedScenes?.length) {
      throw new Error("分镜尚未生成，请先执行生成分镜");
    }

    const videoResult = await this.videoGenerator.generate(script, id, async ({ phase, progress }) => {
      await this.updateStep(id, "generate_video", { phase, progress });
    }, signal, record.videoAudio);
    const enhanced: ScriptAsset = {
      ...script,
      hyperframesVideo: videoResult,
      status: "rendered"
    };

    await this.storage.writeJson(record.storagePath, enhanced);
    const cleanedPath = path.join("processed", "cleaned", `${id}.json`);
    const cleaned = await this.readOptionalJson<Record<string, unknown>>(cleanedPath);
    if (cleaned) {
      await this.storage.writeJson(cleanedPath, {
        ...cleaned,
        output: enhanced
      });
    }
    await this.update(id, {
      videoProjectPath: videoResult.projectPath,
      videoOutputPath: videoResult.videoPath,
      videoGeneratedAt: videoResult.createdAt,
      errorMessage: undefined
    });
  }

  private createInitialSteps(): PipelineSteps {
    return PIPELINE_STEPS.reduce((steps, step) => {
      steps[step] = {
        status: "pending",
        attempts: 0
      };
      return steps;
    }, {} as PipelineSteps);
  }

  private ensurePipelineSteps(steps?: Partial<PipelineSteps>): PipelineSteps {
    const initial = this.createInitialSteps();
    for (const step of PIPELINE_STEPS) {
      initial[step] = {
        ...initial[step],
        ...(steps?.[step] ?? {})
      };
    }
    return initial;
  }

  private async updateStep(
    id: string,
    step: PipelineStep,
    patch: Partial<PipelineStepState>,
    recordPatch: Partial<Omit<JobRecord, "id" | "createdAt" | "steps">> = {}
  ) {
    const index = await this.readIndex();
    const current = index[id];
    if (!current) {
      throw new JobStepError("job not found", 404);
    }

    const steps = this.ensurePipelineSteps(current.steps);
    steps[step] = {
      ...steps[step],
      ...patch
    };

    const next: JobRecord = {
      ...current,
      ...recordPatch,
      steps,
      updatedAt: new Date().toISOString()
    };
    index[id] = next;
    await this.writeIndex(index);
    return next;
  }

  private async markStepRunning(record: JobRecord, step: PipelineStep) {
    const now = new Date().toISOString();
    await this.updateStep(
      record.id,
      step,
      {
        status: "running",
        attempts: 0,
        lastError: undefined,
        startedAt: now,
        finishedAt: undefined,
        phase: undefined,
        progress: step === "generate_video" ? 0 : undefined
      },
      {
        status: "processing",
        stage: STEP_STAGE[step].running,
        ...(step === 'generate_video' && record.videoAudio ? { videoAudio: record.videoAudio } : {}),
        errorMessage: undefined
      }
    );
  }

  private async markStepSucceeded(id: string, step: PipelineStep) {
    const now = new Date().toISOString();
    return this.updateStep(
      id,
      step,
      {
        status: "succeeded",
        lastError: undefined,
        finishedAt: now
      },
      {
        status: step === "generate_video" ? "done" : "queued",
        stage: STEP_STAGE[step].succeeded,
        errorMessage: undefined
      }
    );
  }

  private async markStepFailed(id: string, step: PipelineStep, message: string) {
    const now = new Date().toISOString();
    return this.updateStep(
      id,
      step,
      {
        status: "failed",
        lastError: message,
        finishedAt: now
      },
      {
        status: "failed",
        stage: "failed",
        ...this.stepErrorPatch(step, message)
      }
    );
  }

  private stepErrorPatch(step: PipelineStep, message: string): Partial<JobRecord> {
    if (step === "transcribe") {
      return { transcriptErrorMessage: message };
    }
    return { errorMessage: message };
  }

  private async requireRecord(id: string) {
    const record = await this.get(id);
    if (!record) {
      throw new Error("job not found");
    }
    return record;
  }

  private async writePageInfoBestEffort(id: string, sourceUrl: string) {
    let pageInfo: PageInfoRecord;
    try {
      pageInfo = await fetchDouyinPageInfo(sourceUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "page extraction failed";
      pageInfo = {
        requestedUrl: sourceUrl,
        finalUrl: sourceUrl,
        canonicalUrl: sourceUrl,
        videoId: undefined,
        pageTitle: undefined,
        pageDescription: undefined,
        authorName: undefined,
        publishTime: undefined,
        isChallengePage: false,
        redirectChain: [],
        errorMessage: message
      };
    }
    await this.storage.writeJson(path.join("raw", "page", `${id}.json`), pageInfo);
  }

  private async readParsedShare(id: string) {
    return this.readOptionalJson<ParsedShare>(path.join("raw", "text", `${id}.json`));
  }

  private async readPageInfo(id: string) {
    return this.readOptionalJson<PageInfoRecord>(path.join("raw", "page", `${id}.json`));
  }

  private async readCollectionCoverUrl(record: JobRecord) {
    const collections = await this.readOptionalJson<Record<string, {
      crawlResult?: { items?: Array<{ awemeId?: string; coverUrl?: string }> };
    }>>("cache/collections-index.json");
    if (!collections) {
      return undefined;
    }

    const matchedItem = Object.values(collections)
      .flatMap((collection) => collection.crawlResult?.items ?? [])
      .find((item) => item.awemeId && record.sourceUrl.includes(item.awemeId));
    return matchedItem?.coverUrl;
  }

  private async readTranscript(id: string) {
    return this.readOptionalJson<TranscriptAsset>(path.join("raw", "transcripts", `${id}.json`));
  }

  private async readOptionalJson<T>(relativePath: string) {
    try {
      return await this.storage.readJson<T>(relativePath);
    } catch {
      return null;
    }
  }

  private async buildPreview(record: JobRecord): Promise<JobPreview> {
    const [pageInfo, cleaned, transcript, collectionCoverUrl] = await Promise.all([
      this.readPageInfo(record.id),
      this.readOptionalJson<{
        output?: Partial<ScriptAsset>;
        pageInfo?: PageInfoRecord | null;
        transcriptText?: string;
      }>(path.join("processed", "cleaned", `${record.id}.json`)),
      this.readTranscript(record.id),
      this.readCollectionCoverUrl(record)
    ]);
    const output = cleaned?.output;
    const displayTitle = toSimplifiedChinese(
      firstText(output?.title, output?.coverTitle, output?.pageTitle, pageInfo?.pageTitle, record.topic) ||
      "未命名作品"
    );
    const authorName = firstText(pageInfo?.authorName, output?.authorName);
    const summaryValue = firstText(output?.summary, pageInfo?.pageDescription, output?.rawText)?.slice(0, 140);
    const summary = summaryValue ? toSimplifiedChinese(summaryValue) : undefined;
    const subtitle = toSimplifiedChinese(firstText(authorName, pageInfo?.pageDescription, record.sourceUrl) || "等待内容生成");
    const coverTitleValue = firstText(output?.coverTitle, output?.title, pageInfo?.pageTitle, record.topic);
    const coverUrl = firstText(record.coverUrl, output?.coverUrl, pageInfo?.coverUrl, collectionCoverUrl);
    const hasTranscript = Boolean(transcript?.transcript?.trim() || cleaned?.transcriptText?.trim());
    const hasRewrite = Boolean(output?.cleanScript?.trim() || output?.voiceoverScript?.trim());
    const hasVideoPrompts = Boolean(output?.shortVideoShots?.length || output?.videoPrompts?.length || output?.enhancedScenes?.length);
    const hasVideo = Boolean(output?.hyperframesVideo?.videoPath || record.videoOutputPath);
    const currentStep = this.getCurrentStep(record);
    const nextStep = this.getNextStep(record);

    return {
      displayTitle,
      subtitle,
      sourcePlatform: this.getSourcePlatform(record.sourceUrl),
      authorName,
      summary,
      coverTitle: coverTitleValue ? toSimplifiedChinese(coverTitleValue) : undefined,
      coverUrl,
      hasTranscript,
      hasRewrite,
      hasVideoPrompts,
      hasVideo,
      currentStep,
      nextStep,
      nextActionLabel: this.getNextActionLabel(record, currentStep, nextStep)
    };
  }

  private getCurrentStep(record: JobRecord) {
    const steps = record.steps ? this.ensurePipelineSteps(record.steps) : null;
    return steps ? PIPELINE_STEPS.find((step) => steps[step].status === "running") : undefined;
  }

  private getNextStep(record: JobRecord) {
    const steps = record.steps ? this.ensurePipelineSteps(record.steps) : null;
    if (!steps) {
      return undefined;
    }
    const failed = PIPELINE_STEPS.find((step) => steps[step].status === "failed");
    if (failed) {
      return failed;
    }
    return PIPELINE_STEPS.find((step) => steps[step].status !== "succeeded");
  }

  private getNextActionLabel(record: JobRecord, currentStep?: PipelineStep, nextStep?: PipelineStep) {
    if (record.deletedAt) {
      return "已移入垃圾桶";
    }
    if (currentStep) {
      return `正在${STEP_LABELS[currentStep]}`;
    }
    if (record.status === "done") {
      return "查看成果";
    }
    if (record.status === "failed" && nextStep) {
      return `重试${STEP_LABELS[nextStep]}`;
    }
    if (nextStep && record.steps?.[nextStep]?.status === "paused") {
      return `重新执行${STEP_LABELS[nextStep]}`;
    }
    if (nextStep) {
      return `开始${STEP_LABELS[nextStep]}`;
    }
    return "查看详情";
  }

  private getSourcePlatform(sourceUrl: string) {
    if (/douyin\.com|iesdouyin\.com/i.test(sourceUrl)) {
      return "抖音";
    }
    return "视频链接";
  }

  async get(id: string) {
    await this.purgeExpiredTrash();
    const index = await this.readIndex();
    return index[id] ?? null;
  }

  async list() {
    await this.purgeExpiredTrash();
    const index = await this.readIndex();
    return Object.values(index).filter((job) => !job.deletedAt).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async listOverview(): Promise<JobOverview[]> {
    const records = await this.list();
    return Promise.all(records.map(async (record) => ({
      ...record,
      preview: await this.buildPreview(record)
    })));
  }

  async listTrash() {
    await this.purgeExpiredTrash();
    const index = await this.readIndex();
    return Object.values(index).filter((job) => job.deletedAt).sort((a, b) =>
      new Date(b.deletedAt ?? b.updatedAt).getTime() - new Date(a.deletedAt ?? a.updatedAt).getTime()
    );
  }

  async trash(id: string) {
    await this.purgeExpiredTrash();
    const index = await this.readIndex();
    const current = index[id];
    if (!current) {
      return null;
    }
    if (current.deletedAt) {
      return current;
    }

    const deletedAt = new Date();
    const next: JobRecord = {
      ...current,
      deletedAt: deletedAt.toISOString(),
      trashExpiresAt: new Date(deletedAt.getTime() + TRASH_RETENTION_MS).toISOString(),
      updatedAt: deletedAt.toISOString()
    };
    index[id] = next;
    await this.writeIndex(index);
    return next;
  }

  async restore(id: string) {
    await this.purgeExpiredTrash();
    const index = await this.readIndex();
    const current = index[id];
    if (!current) {
      return null;
    }

    const next: JobRecord = {
      ...current,
      deletedAt: undefined,
      trashExpiresAt: undefined,
      updatedAt: new Date().toISOString()
    };
    index[id] = next;
    await this.writeIndex(index);
    return next;
  }

  async permanentlyDelete(id: string): Promise<PermanentDeleteResult> {
    await this.purgeExpiredTrash();
    const index = await this.readIndex();
    const current = index[id];
    if (!current) {
      return "not_found";
    }
    if (!current.deletedAt) {
      return "not_in_trash";
    }
    if (this.isActive(current)) {
      return "active";
    }

    await this.removeJobArtifacts(current);
    delete index[id];
    await this.writeIndex(index);
    return "deleted";
  }

  async update(id: string, patch: Partial<Omit<JobRecord, "id" | "createdAt">>) {
    const index = await this.readIndex();
    const current = index[id];
    if (!current) {
      return null;
    }
    const next: JobRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    index[id] = next;
    await this.writeIndex(index);
    return next;
  }

  async setStage(id: string, stage: JobStage, status?: JobStatus) {
    return this.update(id, {
      stage,
      status: status ?? "processing"
    });
  }

  async fail(id: string, message: string) {
    return this.update(id, {
      status: "failed",
      stage: "failed",
      errorMessage: message
    });
  }

  private async readIndex() {
    return this.storage.readJson<JobsIndex>(JOBS_INDEX);
  }

  private async writeIndex(index: JobsIndex) {
    await this.storage.writeJsonAtomic(JOBS_INDEX, index);
  }

  private defaultScriptAsset(
    sourceUrl: string,
    topic: string,
    parsed: ReturnType<typeof parseDouyinShare> | null,
    pageInfo: PageInfoRecord | null,
    transcriptText: string | null
  ): ScriptAsset {
    if (parsed) {
      const draft = buildScriptDraft(parsed, topic, pageInfo);
      if (transcriptText?.trim()) {
        const summary = transcriptText.trim().slice(0, 160);
        const keyPoints = this.buildTranscriptKeyPoints(transcriptText);
        return {
          ...draft,
          rawText: transcriptText,
          transcriptText: transcriptText.trim(),
          cleanScript: transcriptText.trim(),
          voiceoverScript: transcriptText.trim(),
          summary,
          keyPoints,
          videoOutline: this.buildFallbackVideoOutline(draft.coverTitle, keyPoints)
        };
      }
      return draft;
    }

    if (transcriptText) {
      const coverTitle = pageInfo?.pageTitle?.slice(0, 24) ?? transcriptText.slice(0, 24) ?? "AI 技术分享";
      const summary = transcriptText.slice(0, 160);
      const keyPoints = this.buildTranscriptKeyPoints(transcriptText);
      return {
        sourceUrl,
        videoId: pageInfo?.videoId,
        title: pageInfo?.pageTitle ?? topic,
        pageTitle: pageInfo?.pageTitle,
        pageDescription: pageInfo?.pageDescription,
        authorName: pageInfo?.authorName,
        publishTime: pageInfo?.publishTime,
        topic,
        rawText: transcriptText,
        transcriptText,
        cleanScript: transcriptText,
        voiceoverScript: transcriptText,
        coverTitle,
        tags: ["AI", "技术分享"],
        summary,
        keyPoints,
        videoOutline: this.buildFallbackVideoOutline(coverTitle, keyPoints),
        sceneList: [
          {
            scene: 1,
            duration: 5,
            caption: transcriptText.slice(0, 80) || "视频转写内容",
            visual: "视频转写原文"
          }
        ],
        status: "draft"
      };
    }

    return {
      sourceUrl,
      videoId: pageInfo?.videoId,
      title: pageInfo?.pageTitle,
      pageTitle: pageInfo?.pageTitle,
      pageDescription: pageInfo?.pageDescription,
      authorName: pageInfo?.authorName,
      publishTime: pageInfo?.publishTime,
      rawShareText: undefined,
      normalizedShareText: undefined,
      introText: undefined,
      hashtags: [],
      contentType: undefined,
      topic,
      rawText: "",
      transcriptText: undefined,
      cleanScript: "",
      voiceoverScript: "",
      coverTitle: "",
      tags: [],
      sceneList: [],
      status: "draft"
    };
  }

  private isActive(record: JobRecord) {
    return this.runningSteps.has(record.id) || record.status === "processing" ||
      Boolean(record.steps && PIPELINE_STEPS.some((step) => record.steps?.[step]?.status === "running"));
  }

  private async purgeExpiredTrash() {
    const index = await this.readIndex();
    const now = Date.now();
    let changed = false;

    for (const [id, record] of Object.entries(index)) {
      if (!record.deletedAt || !record.trashExpiresAt || this.isActive(record)) {
        continue;
      }
      if (new Date(record.trashExpiresAt).getTime() > now) {
        continue;
      }

      await this.removeJobArtifacts(record);
      delete index[id];
      changed = true;
    }

    if (changed) {
      await this.writeIndex(index);
    }
  }

  private async removeJobArtifacts(record: JobRecord) {
    const candidates = new Set<string>();
    const addPath = (value?: string) => {
      if (!value) return;
      const fullPath = this.toStorageFilePath(value);
      if (fullPath) {
        candidates.add(fullPath);
      }
    };
    const addRelative = (...segments: string[]) => addPath(path.join(...segments));

    addPath(record.storagePath);
    addPath(record.videoPath);
    addPath(record.videoMetadataPath);
    addPath(record.audioPath);
    addPath(record.audioManifestPath);
    addPath(record.transcriptPath);
    addPath(record.videoProjectPath);
    addPath(record.videoOutputPath);

    addRelative("cache", "retranscribe", `${record.id}.json`);
    addRelative("raw", "text", `${record.id}.json`);
    addRelative("raw", "page", `${record.id}.json`);
    addRelative("raw", "transcripts", `${record.id}.json`);
    addRelative("raw", "videos", `${record.id}.mp4`);
    addRelative("raw", "videos", `${record.id}.page.json`);
    addRelative("raw", "audio", `${record.id}.mp3`);
    addRelative("raw", "audio", `${record.id}.wav`);
    addRelative("raw", "audio", `${record.id}.json`);
    addRelative("processed", "scripts", `${record.id}.json`);
    addRelative("processed", "cleaned", `${record.id}.json`);
    addRelative("processed", "scenes", `${record.id}.json`);
    addRelative("processed", "subtitles", `${record.id}.srt`);
    addRelative("output", "videos", record.id);

    const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    for (const directory of ["raw/audio", "raw/transcripts", "processed/scripts", "processed/cleaned"]) {
      const entries = await readdir(this.storage.resolve(directory)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (directory === "raw/transcripts" && entry.startsWith(`${record.id}.captions.`) && /^[a-zA-Z0-9-]+\.json3$/.test(entry.slice(`${record.id}.captions.`.length))) addRelative(directory, entry);
        const suffix = directory === "raw/audio"
          ? entry.startsWith(`${record.id}-repair-`) ? entry.slice(`${record.id}-repair-`.length) : ""
          : entry.startsWith(`${record.id}.json.before-retranscribe-`) ? entry.slice(`${record.id}.json.before-retranscribe-`.length) : "";
        const pattern = directory === "raw/audio" ? `^${uuidPattern}\\.(?:wav|json)$` : `^${uuidPattern}\\.json$`;
        if (new RegExp(pattern, "i").test(suffix)) addRelative(directory, entry);
      }
    }

    const script = await this.readScriptForDeletion(record);
    addPath(script?.hyperframesVideo?.projectPath);
    addPath(script?.hyperframesVideo?.videoPath);
    addPath(script?.hyperframesVideo?.manifestPath);

    for (const filePath of candidates) {
      await this.removeFileIfExists(filePath);
    }
  }

  private async readScriptForDeletion(record: JobRecord) {
    const scriptPaths = [record.storagePath, path.join("processed", "scripts", `${record.id}.json`)].filter(Boolean);
    for (const scriptPath of scriptPaths) {
      try {
        return await this.storage.readJson<ScriptAsset>(scriptPath);
      } catch {
        // Best effort: script may not exist for failed or partially processed jobs.
      }
    }
    return null;
  }

  private toStorageFilePath(filePath: string) {
    const storageRoot = path.resolve(this.storage.resolve(""));
    const normalized = filePath.replace(/^storage[\\/]/, "");
    const absolutePath = path.isAbsolute(normalized)
      ? path.resolve(normalized)
      : path.resolve(storageRoot, normalized);
    const relative = path.relative(storageRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return absolutePath;
  }

  private async removeFileIfExists(filePath: string) {
    try {
      await rm(filePath, { force: true, recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to remove job artifact ${filePath}: ${message}`);
    }
  }

  private buildTranscriptKeyPoints(text: string) {
    return text
      .split(/[。！？!?；;\n]+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((sentence) => sentence.slice(0, 80));
  }

  private buildFallbackVideoOutline(title: string, keyPoints: string[]) {
    return [
      {
        title: "开场钩子",
        bullets: [title].filter(Boolean),
        visualPrompt: "竖屏标题卡、主题关键词放大、强对比字幕"
      },
      {
        title: "核心要点",
        bullets: keyPoints.length ? keyPoints : ["内容清洗", "要点提炼"],
        visualPrompt: "要点卡片依次入场、关键词高亮、信息图标"
      },
      {
        title: "总结",
        bullets: keyPoints.slice(-3).length ? keyPoints.slice(-3) : ["回顾重点", "行动建议"],
        visualPrompt: "总结卡、行动建议、字幕扫光动效"
      }
    ];
  }
}
