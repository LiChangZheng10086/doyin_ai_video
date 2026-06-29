import { randomUUID } from "node:crypto";
import path from "node:path";
import { fetchDouyinPageInfo } from "./douyin-page.js";
import type { DouyinPageInfo } from "./douyin-page.js";
import { buildScriptDraft } from "./script-builder.js";
import type { ScriptCleaner } from "./ai-cleaner.js";
import type { DownloadResult, MediaService } from "./media.js";
import type { AsrService } from "./asr.js";
import { LocalStorage } from "./storage.js";
import { parseDouyinShare } from "./douyin.js";
import { createVideoEnhancer } from "./video-enhancer.js";
import { createPPTGenerator } from "./ppt-generator.js";
import type { JobRecord, JobStatus, JobStage, ScriptAsset } from "../types.js";

const JOBS_INDEX = "cache/jobs-index.json";

type JobsIndex = Record<string, JobRecord>;
type PageInfoRecord = DouyinPageInfo & { errorMessage?: string };

export class JobStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly cleaner: ScriptCleaner,
    private readonly media: MediaService,
    private readonly asr: AsrService
  ) {}

  async init() {
    await this.storage.ensureBaseDirs();
    try {
      await this.storage.readJson<JobsIndex>(JOBS_INDEX);
    } catch {
      await this.storage.writeJson(JOBS_INDEX, {});
    }
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
      stage: "submitted",
      createdAt: now,
      updatedAt: now,
      storagePath
    };
    const index = await this.readIndex();
    index[id] = record;
    await this.writeIndex(index);

    // 🔥 异步处理任务，不阻塞响应
    this.processJob(id, parsed, sourceUrl, topic, now).catch((error) => {
      console.error(`Job ${id} processing failed:`, error);
      this.setStage(id, "failed", "failed").catch(console.error);
    });

    return record;
  }


  private async processJob(
    id: string,
    parsed: ReturnType<typeof parseDouyinShare> | null,
    sourceUrl: string,
    topic: string,
    createdAt: string
  ) {
    const storagePath = path.join("processed", "scripts", `${id}.json`);

    try {
      if (parsed) {
        await this.setStage(id, "parsed");
        await this.storage.writeJson(path.join("raw", "text", `${id}.json`), parsed);
      }

      await this.setStage(id, "downloading");
      let downloadResult: DownloadResult | null = null;
      try {
        downloadResult = await this.media.downloadVideo(sourceUrl, id);
        await this.update(id, {
          videoPath: downloadResult.videoPath,
          videoMetadataPath: downloadResult.metadataPath
        });
        await this.setStage(id, "downloaded");
      } catch (error) {
        const message = error instanceof Error ? error.message : "video download failed";
        await this.update(id, {
          downloadErrorMessage: message
        });
      }

      let pageInfo: PageInfoRecord | null = null;
      try {
        pageInfo = await fetchDouyinPageInfo(sourceUrl);
        await this.storage.writeJson(path.join("raw", "page", `${id}.json`), pageInfo);
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
        await this.storage.writeJson(path.join("raw", "page", `${id}.json`), pageInfo);
      }

      if (downloadResult) {
        await this.setStage(id, "audio_extracted");
        let transcriptText: string | null = null;
        try {
          const audioResult = await this.media.extractAudio(downloadResult.videoPath, id);
          await this.update(id, {
            audioPath: audioResult.audioPath,
            audioManifestPath: audioResult.manifestPath
          });
          await this.setStage(id, "transcribing");
          try {
            const transcriptResult = await this.asr.transcribe(audioResult.audioPath);
            transcriptText = transcriptResult?.text?.trim() || null;
            if (transcriptResult?.text) {
              const transcriptPath = path.join("raw", "transcripts", `${id}.json`);
              await this.storage.writeJson(transcriptPath, {
                jobId: id,
                sourceUrl,
                audioPath: audioResult.audioPath,
                transcript: transcriptResult.text,
                model: transcriptResult.model,
                provider: transcriptResult.provider,
                createdAt: new Date().toISOString()
              });
              await this.update(id, {
                transcriptPath,
                transcriptModel: transcriptResult.model
              });
            }
          } catch (error) {
            if (error instanceof Error && !this.isMissingAsrKeyError(error)) {
              await this.update(id, {
                transcriptErrorMessage: error.message || "transcription failed"
              });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "audio extraction failed";
          await this.update(id, {
            audioErrorMessage: message
          });
        }

        if (!parsed && !transcriptText) {
          throw new Error("transcription failed and no share text was provided");
        }

        const draft = this.defaultScriptAsset(sourceUrl, topic, parsed, pageInfo, transcriptText);
        await this.storage.writeJson(storagePath, draft);

        if (parsed || transcriptText) {
          await this.setStage(id, "cleaned");
          const cleaned = await this.cleaner.clean({
            parsed,
            transcriptText,
            topic,
            draft,
            pageInfo
          });

          // 🎯 双路增强：并行生成视频提示词和 PPT
          let enhanced = cleaned;
          try {
            const videoEnhancer = createVideoEnhancer();
            const pptGenerator = createPPTGenerator();

            const [videoResult, pptResult] = await Promise.allSettled([
              videoEnhancer.enhanceScenes(cleaned.sceneList, topic),
              pptGenerator.generatePPT(cleaned, id)
            ]);

            // 合并视频增强结果
            if (videoResult.status === "fulfilled") {
              enhanced = {
                ...enhanced,
                videoPrompts: videoResult.value.videoPrompts,
                enhancedScenes: videoResult.value.enhancedScenes,
                videoEnhancedAt: new Date().toISOString()
              };
            } else {
              console.error("Video enhancement failed:", videoResult.reason);
            }

            // 合并 PPT 生成结果
            if (pptResult.status === "fulfilled") {
              enhanced = {
                ...enhanced,
                pptContent: pptResult.value.pptContent,
                pptPath: pptResult.value.pptPath,
                pptStyle: pptResult.value.style,
                pptGeneratedAt: new Date().toISOString()
              };
            } else {
              console.error("PPT generation failed:", pptResult.reason);
            }
          } catch (error) {
            console.error("Enhancement pipeline failed:", error);
            // 增强失败不影响主流程，继续使用 cleaned 结果
          }

          await this.storage.writeJson(path.join("processed", "cleaned", `${id}.json`), {
            jobId: id,
            sourceUrl,
            topic,
            createdAt,
            aiModel: enhanced.aiModel,
            cleaningMode: enhanced.cleaningMode,
            pageInfo,
            parsed,
            transcriptText,
            output: enhanced
          });
          await this.storage.writeJson(storagePath, enhanced);
          await this.setStage(id, "scripted", "done");
        } else {
          await this.setStage(id, "scripted", "done");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "job processing failed";
      console.error(`Job ${id} failed:`, message);
      await this.update(id, { errorMessage: message });
      await this.setStage(id, "failed", "failed");
    }
  }

  async get(id: string) {
    const index = await this.readIndex();
    return index[id] ?? null;
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
        return {
          ...draft,
          rawText: transcriptText,
          transcriptText: transcriptText.trim(),
          cleanScript: transcriptText.trim(),
          voiceoverScript: transcriptText.trim()
        };
      }
      return draft;
    }

    if (transcriptText) {
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
        coverTitle: pageInfo?.pageTitle?.slice(0, 24) ?? transcriptText.slice(0, 24) ?? "AI 技术分享",
        tags: ["AI", "技术分享"],
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

  private isMissingAsrKeyError(error: Error) {
    return /api key|OPENAI_API_KEY|ASR_API_KEY/i.test(error.message);
  }
}
