import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fetchDouyinPageInfo } from "./douyin-page.js";
import type { DouyinPageInfo } from "./douyin-page.js";
import { buildScriptDraft } from "./script-builder.js";
import type { ScriptCleaner } from "./ai-cleaner.js";
import type { MediaService } from "./media.js";
import type { AsrService } from "./asr.js";
import { LocalStorage } from "./storage.js";
import { parseDouyinShare } from "./douyin.js";
import type { HyperframesVideoGenerator } from "./hyperframes-video.js";
import type {
  JobOverview,
  JobPreview,
  JobRecord,
  JobStatus,
  JobStage,
  EnhancedScene,
  PipelineStep,
  PipelineStepState,
  PipelineSteps,
  ScriptAsset,
  ShortVideoShot,
  ShotPacing,
  ShotTransition,
  ShotType,
  ShortVideoVisualLayer,
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
  generate_video_prompts: "生成视频提示词",
  generate_video: "生成视频"
};
const STEP_STAGE: Record<PipelineStep, { running: JobStage; succeeded: JobStage }> = {
  transcribe: { running: "transcribing", succeeded: "transcribed" },
  clean: { running: "cleaning", succeeded: "cleaned" },
  generate_video_prompts: { running: "generating-video-prompts", succeeded: "scripted" },
  generate_video: { running: "generating-video", succeeded: "rendered" }
};
const STEP_PREVIOUS: Partial<Record<PipelineStep, PipelineStep>> = {
  clean: "transcribe",
  generate_video_prompts: "clean",
  generate_video: "generate_video_prompts"
};

type JobsIndex = Record<string, JobRecord>;
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

export class JobStore {
  private readonly runningSteps = new Set<string>();

  constructor(
    private readonly storage: LocalStorage,
    private readonly cleaner: ScriptCleaner,
    private readonly media: MediaService,
    private readonly asr: AsrService,
    private readonly videoGenerator?: HyperframesVideoGenerator
  ) {}

  async init() {
    await this.storage.ensureBaseDirs();
    try {
      await this.storage.readJson<JobsIndex>(JOBS_INDEX);
    } catch {
      await this.storage.writeJson(JOBS_INDEX, {});
    }
    await this.purgeExpiredTrash();
  }

  async create(input: { sourceUrl?: string; shareText?: string; topic?: string }) {
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

  async runStep(id: string, step: PipelineStep) {
    if (this.runningSteps.has(id)) {
      throw new JobStepError("another step is already running for this job", 409);
    }

    this.runningSteps.add(id);
    try {
      const record = await this.getStepRunnableRecord(id, step);
      await this.markStepRunning(record, step);

      let lastError = "";
      for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt += 1) {
        await this.updateStep(id, step, { attempts: attempt });
        try {
          await this.executeStepAction(id, step);
          return await this.markStepSucceeded(id, step);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          await this.updateStep(id, step, { attempts: attempt, lastError });
        }
      }

      const failed = await this.markStepFailed(id, step, lastError || "step failed");
      throw new JobStepError(lastError || "step failed", 500, failed);
    } finally {
      this.runningSteps.delete(id);
    }
  }

  private async getStepRunnableRecord(id: string, step: PipelineStep) {
    const record = await this.get(id);
    if (!record) {
      throw new JobStepError("job not found", 404);
    }
    if (record.deletedAt) {
      throw new JobStepError("deleted job cannot run steps", 409, record);
    }
    if (record.workflowMode !== "manual" || !record.steps) {
      throw new JobStepError("manual workflow steps are not available for this job", 409, record);
    }

    const steps = this.ensurePipelineSteps(record.steps);
    const current = steps[step];
    if (current.status === "running") {
      throw new JobStepError("step is already running", 409, record);
    }
    if (current.status === "succeeded") {
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

  private async executeStepAction(id: string, step: PipelineStep) {
    if (step === "transcribe") {
      await this.runTranscribeStep(id);
      return;
    }
    if (step === "clean") {
      await this.runCleanStep(id);
      return;
    }
    if (step === "generate_video_prompts") {
      await this.runGenerateVideoPromptsStep(id);
      return;
    }
    await this.runGenerateVideoStep(id);
  }

  private async runDownloadStep(id: string) {
    const record = await this.requireRecord(id);
    const downloadResult = await this.media.downloadVideo(record.sourceUrl, id);
    await this.update(id, {
      videoPath: downloadResult.videoPath,
      videoMetadataPath: downloadResult.metadataPath,
      downloadErrorMessage: undefined
    });
    await this.writePageInfoBestEffort(id, record.sourceUrl);
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

  private async runTranscribeStep(id: string) {
    let record = await this.requireRecord(id);
    if (!record.videoPath) {
      await this.update(id, { status: "processing", stage: "downloading" });
      await this.runDownloadStep(id);
      record = await this.requireRecord(id);
    }
    if (!(await this.isWhisperReadyAudio(id, record.audioPath))) {
      await this.update(id, { status: "processing", stage: "extracting" });
      await this.runExtractAudioStep(id);
      record = await this.requireRecord(id);
    }
    await this.update(id, { status: "processing", stage: "transcribing" });
    const audioPath = record.audioPath;
    if (!audioPath) {
      throw new Error("audio file is missing; transcription could not extract audio from the source video");
    }

    const transcriptResult = await this.asr.transcribe(audioPath);
    const transcriptText = transcriptResult?.text?.trim();
    if (!transcriptResult || !transcriptText) {
      throw new Error("ASR returned no transcript; check ASR configuration and retry");
    }

    const audioManifest = await this.readOptionalJson<{ duration?: number }>(
      path.join("raw", "audio", `${id}.json`)
    );
    const transcriptPath = path.join("raw", "transcripts", `${id}.json`);
    const transcriptAsset: TranscriptAsset = {
      jobId: id,
      sourceUrl: record.sourceUrl,
      audioPath,
      transcript: transcriptResult.text,
      text: transcriptResult.text,
      segments: transcriptResult.segments,
      words: transcriptResult.words,
      duration: transcriptResult.duration ?? audioManifest?.duration,
      language: transcriptResult.language,
      model: transcriptResult.model,
      provider: transcriptResult.provider,
      createdAt: new Date().toISOString()
    };
    await this.storage.writeJson(transcriptPath, transcriptAsset);
    await this.update(id, {
      transcriptPath,
      transcriptModel: transcriptResult.model,
      transcriptErrorMessage: undefined
    });
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

  private async runCleanStep(id: string) {
    const record = await this.requireRecord(id);
    const parsed = await this.readParsedShare(id);
    const pageInfo = await this.readPageInfo(id);
    const transcript = await this.readTranscript(id);
    const transcriptText = transcript?.transcript?.trim() || transcript?.text?.trim() || "";
    if (!transcriptText) {
      throw new Error("transcript is missing; run ASR transcription first");
    }

    const draft = this.defaultScriptAsset(record.sourceUrl, record.topic, parsed, pageInfo, transcriptText);
    await this.storage.writeJson(record.storagePath, draft);
    const cleaned = await this.cleaner.clean({
      parsed,
      transcriptText,
      topic: record.topic,
      draft,
      pageInfo
    });
    await this.storage.writeJson(path.join("processed", "cleaned", `${id}.json`), {
      jobId: id,
      sourceUrl: record.sourceUrl,
      topic: record.topic,
      createdAt: record.createdAt,
      aiModel: cleaned.aiModel,
      cleaningMode: cleaned.cleaningMode,
      pageInfo,
      parsed,
      transcriptText,
      output: cleaned
    });
    await this.storage.writeJson(record.storagePath, cleaned);
    await this.update(id, { errorMessage: undefined });
  }

  private async runGenerateVideoPromptsStep(id: string) {
    const record = await this.requireRecord(id);
    const script = await this.storage.readJson<ScriptAsset>(record.storagePath);
    if (!script.cleanScript?.trim() && !script.voiceoverScript?.trim()) {
      throw new Error("clean script is missing; run AI rewrite first");
    }
    const shortVideoShots = this.buildShortVideoShots(script);
    const promptScenes = this.buildVideoPromptScenesFromShots(shortVideoShots);
    const enhanced: ScriptAsset = {
      ...script,
      videoPrompts: promptScenes.map((scene) => scene.videoPrompt),
      enhancedScenes: promptScenes,
      shortVideoShots,
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

  private async runGenerateVideoStep(id: string) {
    if (!this.videoGenerator) {
      throw new Error("HyperFrames video generator is not configured");
    }

    const record = await this.requireRecord(id);
    const script = await this.storage.readJson<ScriptAsset>(record.storagePath);
    if (!script.shortVideoShots?.length && !script.videoPrompts?.length && !script.enhancedScenes?.length) {
      throw new Error("video prompts are missing; run generate video prompts first");
    }

    const videoResult = await this.videoGenerator.generate(script, id);
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
        finishedAt: undefined
      },
      {
        status: "processing",
        stage: STEP_STAGE[step].running,
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

  private buildShortVideoShots(script: ScriptAsset): ShortVideoShot[] {
    const candidates: Array<{ caption: string; visual: string; duration?: number }> = [];
    for (const scene of script.sceneList ?? []) {
      candidates.push({
        caption: scene.caption,
        visual: scene.visual,
        duration: scene.duration
      });
    }
    for (const item of script.videoOutline ?? []) {
      candidates.push({
        caption: [item.title, ...item.bullets].join("。"),
        visual: item.visualPrompt || item.bullets.join("，")
      });
    }
    for (const point of script.keyPoints ?? []) {
      candidates.push({
        caption: point,
        visual: "关键词高亮、流程卡片、信息图转场"
      });
    }
    for (const sentence of this.splitSentences(script.voiceoverScript || script.cleanScript || script.rawText)) {
      candidates.push({
        caption: sentence,
        visual: "竖屏解释视频字幕卡、重点词放大、抽象信息图"
      });
    }

    const title = firstText(script.coverTitle, script.title, script.topic) || "视频成片";
    const summary = firstText(script.summary, script.cleanScript, script.voiceoverScript) || title;
    const unique = this.dedupePromptCandidates([
      { caption: title, visual: "开场标题卡、主题关键词、强对比排版", duration: 4 },
      { caption: summary, visual: "核心摘要卡、三段式信息图、节奏化字幕", duration: 6 },
      ...candidates
    ]);

    while (unique.length < 6) {
      unique.push({
        caption: `${title} - 补充视角 ${unique.length + 1}`,
        visual: "竖屏科技感动态图形、图标矩阵、重点词描边",
        duration: 5
      });
    }

    const shotTypes: ShotType[] = ["hook", "problem", "explain", "process", "contrast", "proof", "summary", "cta"];
    const transitions: ShotTransition[] = ["flash", "push", "wipe", "zoom", "match-cut", "cut"];
    const camera = ["slow push-in", "vertical slide", "soft zoom", "panel reveal", "parallax drift"];
    const actions = [
      "关键词从背景中弹出并形成主视觉",
      "信息卡片依次翻入，建立问题和答案的关系",
      "抽象流程线从左到右连接关键步骤",
      "主体图形放大，旁侧浮现解释标签",
      "对比面板左右切换，突出前后差异",
      "总结卡片收束成一个清晰结论"
    ];

    return unique.slice(0, 10).map((item, index) => ({
      index: index + 1,
      duration: this.normalizeShotDuration(item.duration, item.caption),
      shotType: shotTypes[Math.min(index, shotTypes.length - 1)],
      subject: this.buildShotSubject(item.caption, title, index),
      action: actions[index % actions.length],
      cameraMotion: camera[index % camera.length],
      visualLayers: this.buildVisualLayers(item, index),
      caption: this.cleanText(item.caption).slice(0, 56),
      emphasisWords: this.extractEmphasisWords(item.caption, script.keyPoints),
      transition: transitions[index % transitions.length],
      pacing: this.inferPacing(index, item.caption),
      narration: this.cleanText(item.caption).slice(0, 140)
    }));
  }

  private buildVideoPromptScenesFromShots(shots: ShortVideoShot[]): EnhancedScene[] {
    return shots.map((shot) => ({
      scene: shot.index,
      originalVisual: shot.subject,
      videoPrompt: [
        `9:16 竖屏中文动态图形短视频，第 ${shot.index} 镜。`,
        `主体：${shot.subject}。`,
        `动作：${shot.action}。`,
        `字幕：${shot.caption}。`,
        `视觉层：${shot.visualLayers.map((layer) => `${layer.type}:${layer.content}`).join("；")}。`,
        `节奏：${shot.pacing}，转场：${shot.transition}，无真人无数字人。`
      ].join(""),
      cameraMovement: shot.cameraMotion,
      motionEffect: shot.action,
      lightingStyle: shot.visualLayers.find((layer) => layer.type === "background")?.style
    }));
  }

  private buildVisualLayers(
    item: { caption: string; visual: string; duration?: number },
    index: number
  ): ShortVideoVisualLayer[] {
    const visual = this.cleanText(item.visual);
    const caption = this.cleanText(item.caption);
    return [
      {
        type: "background",
        content: index % 2 === 0 ? "深色渐变空间与缓慢移动网格" : "柔和径向光斑与纵向速度线",
        motion: "slow parallax drift",
        style: "dark tech canvas"
      },
      {
        type: "subject",
        content: visual || caption.slice(0, 32) || "核心概念",
        motion: index % 2 === 0 ? "scale in with slight rotation" : "slide up and settle",
        style: "glass card / neon outline"
      },
      {
        type: "graphic",
        content: "流程线、标签卡片、图标节点围绕主体展开",
        motion: "draw line then pop nodes",
        style: "compact infographic"
      },
      {
        type: "caption",
        content: caption.slice(0, 56),
        motion: "word-by-word reveal",
        style: "large kinetic Chinese subtitle"
      },
      {
        type: "emphasis",
        content: this.extractEmphasisWords(caption).join(" / "),
        motion: "bounce and highlight sweep",
        style: "accent pills"
      },
      {
        type: "decoration",
        content: "粒子、扫描线、角标进度",
        motion: "looping ambient motion",
        style: "subtle"
      }
    ];
  }

  private buildShotSubject(caption: string, fallback: string, index: number) {
    const text = this.cleanText(caption);
    if (!text) {
      return fallback;
    }
    const subject = text.split(/[，,。:：]/).map((part) => part.trim()).find((part) => part.length >= 3);
    return (subject || fallback || `镜头 ${index + 1}`).slice(0, 24);
  }

  private normalizeShotDuration(duration: number | undefined, caption: string) {
    if (Number.isFinite(duration)) {
      return Math.max(3, Math.min(8, Math.round(duration as number)));
    }
    return Math.max(4, Math.min(7, Math.ceil(this.cleanText(caption).length / 28) + 3));
  }

  private inferPacing(index: number, caption: string): ShotPacing {
    if (index === 0 || this.cleanText(caption).length <= 28) {
      return "fast";
    }
    if (this.cleanText(caption).length >= 72) {
      return "slow";
    }
    return "medium";
  }

  private extractEmphasisWords(text: string, keyPoints: string[] = []) {
    const source = [text, ...keyPoints].join(" ");
    const words = source
      .split(/[，,。！？!?；;、\s]+/)
      .map((word) => this.cleanText(word).replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
      .filter((word) => word.length >= 2 && word.length <= 8);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const word of words) {
      if (seen.has(word)) {
        continue;
      }
      seen.add(word);
      result.push(word);
      if (result.length >= 3) {
        break;
      }
    }
    return result.length ? result : ["重点", "节奏", "结果"];
  }

  private dedupePromptCandidates(items: Array<{ caption: string; visual: string; duration?: number }>) {
    const seen = new Set<string>();
    return items.filter((item) => {
      const caption = this.cleanText(item.caption);
      const visual = this.cleanText(item.visual);
      if (!caption && !visual) {
        return false;
      }
      const key = `${caption}:${visual}`.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      item.caption = caption;
      item.visual = visual;
      return true;
    });
  }

  private splitSentences(text?: string) {
    return (text ?? "")
      .split(/[。！？!?；;\n]+/)
      .map((sentence) => this.cleanText(sentence))
      .filter((sentence) => sentence.length >= 8)
      .slice(0, 8);
  }

  private cleanText(value?: string) {
    return (value ?? "").replace(/\s+/g, " ").trim();
  }

  private async buildPreview(record: JobRecord): Promise<JobPreview> {
    const [pageInfo, cleaned, transcript] = await Promise.all([
      this.readPageInfo(record.id),
      this.readOptionalJson<{
        output?: Partial<ScriptAsset>;
        pageInfo?: PageInfoRecord | null;
        transcriptText?: string;
      }>(path.join("processed", "cleaned", `${record.id}.json`)),
      this.readTranscript(record.id)
    ]);
    const output = cleaned?.output;
    const displayTitle =
      firstText(output?.title, output?.coverTitle, output?.pageTitle, pageInfo?.pageTitle, record.topic) ||
      "未命名作品";
    const authorName = firstText(pageInfo?.authorName, output?.authorName);
    const summary = firstText(output?.summary, pageInfo?.pageDescription, output?.rawText)?.slice(0, 140);
    const subtitle = firstText(authorName, pageInfo?.pageDescription, record.sourceUrl) || "等待内容生成";
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
      coverTitle: firstText(output?.coverTitle, output?.title, pageInfo?.pageTitle, record.topic),
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
    await this.storage.writeJson(JOBS_INDEX, index);
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
    return record.status === "processing" ||
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
