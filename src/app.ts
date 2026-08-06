import express, { Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { AsrService } from "./lib/asr.js";
import { OpenAiScriptCleaner, RuntimeScriptCleaner } from "./lib/ai-cleaner.js";
import { MediaService } from "./lib/media.js";
import { LocalStorage } from "./lib/storage.js";
import { JobStepError, JobStore } from "./lib/jobs.js";
import { CollectionStore } from "./lib/collections.js";
import { registerConfigRoutes } from "./lib/config-server.js";
import { HyperframesVideoGenerator } from "./lib/hyperframes-video.js";
import { simplifyChineseValue } from "./lib/chinese.js";
import type { CollectionRecord, PipelineStep, ScriptAsset } from "./types.js";

export interface ServerConfig {
  storagePath: string;
  rootDir: string;
  aiProvider?: string;
  aiModel?: string;
  aiApiKey?: string;
  aiBaseURL?: string;
  ytDlpBinary?: string;
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  cookiesFile?: string;
  cookiesFromBrowser?: string;
  whisperCliPath?: string;
  whisperModelPath?: string;
  hyperframesNpxBinary?: string;
  runtimeBinDir?: string;
  hyperframesCliPath?: string;
  hyperframesNodeBinary?: string;
  hyperframesUseElectronAsNode?: boolean;
  hyperframesBrowserPath?: string;
  resolveAiConfig?: () => Promise<AiRuntimeConfig | null>;
}

export interface AiRuntimeConfig {
  provider: "deepseek" | "openai" | "custom";
  model: string;
  apiKey: string;
  baseURL?: string;
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * 创建 Express 应用实例（用于 Electron 嵌入）
 */
export async function createExpressApp(config: ServerConfig): Promise<Express> {
  const storage = new LocalStorage(config.storagePath);

  const aiProvider = config.aiProvider ?? "deepseek";
  const aiModel = config.aiModel ?? "deepseek-chat";
  const aiApiKey = config.aiApiKey;
  const aiBaseURL = config.aiBaseURL ?? (aiProvider === "deepseek" ? "https://api.deepseek.com" : undefined);

  const staticCleanerOptions = {
    apiKey: aiApiKey,
    model: aiModel,
    baseURL: aiBaseURL,
    provider: aiProvider === "deepseek" ? "deepseek" : "openai"
  } as const;
  const cleaner = config.resolveAiConfig
    ? new RuntimeScriptCleaner(async () => {
        const current = await config.resolveAiConfig?.();
        if (!current) return null;
        return {
          apiKey: current.apiKey,
          model: current.model,
          baseURL: current.baseURL,
          provider: current.provider === "deepseek" ? "deepseek" : "openai"
        };
      })
    : new OpenAiScriptCleaner(staticCleanerOptions);

  const media = new MediaService(storage, {
    ytDlpBinary: config.ytDlpBinary,
    ffmpegBinary: config.ffmpegBinary,
    ffprobeBinary: config.ffprobeBinary,
    cookiesFile: config.cookiesFile,
    cookiesFromBrowser: config.cookiesFromBrowser
  });

  const asr = new AsrService({
    rootDir: config.rootDir,
    whisperCliPath: config.whisperCliPath,
    whisperModelPath: config.whisperModelPath
  });

  const videoGenerator = new HyperframesVideoGenerator({
    storageRoot: config.storagePath,
    npxBinary: config.hyperframesNpxBinary,
    runtimeBinDir: config.runtimeBinDir,
    cliPath: config.hyperframesCliPath,
    nodeBinary: config.hyperframesNodeBinary,
    useElectronAsNode: config.hyperframesUseElectronAsNode,
    browserPath: config.hyperframesBrowserPath,
    ffprobeBinary: config.ffprobeBinary
  });

  const jobs = new JobStore(storage, cleaner, media, asr, videoGenerator);
  await jobs.init();

  const collections = new CollectionStore(storage, jobs, {
    cookiesFile: config.cookiesFile,
    cookiesFromBrowser: config.cookiesFromBrowser,
  });
  await collections.init();

  const app = express();

  // CORS 中间件（开发环境）
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "2mb" }));

  // 静态文件（开发环境可能不需要）
  const publicDir = path.join(config.rootDir, "public");
  const publicIndex = path.join(publicDir, "index.html");
  if (existsSync(publicIndex)) {
    app.get("/", (_req, res) => {
      res.sendFile(publicIndex);
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "douyin-ai-video" });
  });

  app.get("/api/jobs", async (_req, res) => {
    try {
      const jobList = await jobs.list();
      res.json({ jobs: jobList });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to list jobs";
      res.status(500).json({ message });
    }
  });

  app.get("/api/jobs/overview", async (_req, res) => {
    try {
      const jobList = await jobs.listOverview();
      res.json({ jobs: jobList });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to list job overview";
      res.status(500).json({ message });
    }
  });

  app.post("/api/jobs", async (req, res) => {
    const { sourceUrl, shareText, topic } = req.body as {
      sourceUrl?: string;
      shareText?: string;
      topic?: string;
    };

    if ((!sourceUrl || typeof sourceUrl !== "string") && (!shareText || typeof shareText !== "string")) {
      res.status(400).json({ message: "sourceUrl or shareText is required" });
      return;
    }

    try {
      const record = await jobs.create({ sourceUrl, shareText, topic });
      res.status(201).json({
        job: record,
        message: "job created"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "job create failed";
      res.status(500).json({ message });
    }
  });

  app.get("/api/jobs/trash", async (_req, res) => {
    try {
      const jobList = await jobs.listTrash();
      res.json({ jobs: jobList });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to list trash";
      res.status(500).json({ message });
    }
  });

  app.delete("/api/jobs/:id", async (req, res) => {
    const record = await jobs.trash(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    res.json({ job: record, message: "job moved to trash" });
  });

  app.post("/api/jobs/:id/restore", async (req, res) => {
    const record = await jobs.restore(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    res.json({ job: record, message: "job restored" });
  });

  app.delete("/api/jobs/:id/permanent", async (req, res) => {
    const result = await jobs.permanentlyDelete(req.params.id);
    if (result === "not_found") {
      res.status(404).json({ message: "job not found" });
      return;
    }
    if (result === "not_in_trash") {
      res.status(409).json({ message: "job is not in trash" });
      return;
    }
    if (result === "active") {
      res.status(409).json({ message: "active job cannot be permanently deleted" });
      return;
    }

    res.json({ message: "job permanently deleted" });
  });

  const runStepRoute = async (id: string, step: PipelineStep) => {
    try {
      const record = await jobs.runStep(id, step);
      return {
        status: 200,
        body: {
          job: record,
          message: "step completed"
        }
      };
    } catch (error) {
      if (error instanceof JobStepError) {
        return {
          status: error.statusCode,
          body: {
            message: error.message,
            job: error.job
          }
        };
      }
      const message = error instanceof Error ? error.message : "step failed";
      return {
        status: 500,
        body: { message }
      };
    }
  };

  app.post("/api/jobs/:id/steps/transcribe", async (req, res) => {
    const result = await runStepRoute(req.params.id, "transcribe");
    res.status(result.status).json(result.body);
  });

  app.post("/api/jobs/:id/steps/clean", async (req, res) => {
    const result = await runStepRoute(req.params.id, "clean");
    res.status(result.status).json(result.body);
  });

  app.post("/api/jobs/:id/steps/generate-video-prompts", async (req, res) => {
    const result = await runStepRoute(req.params.id, "generate_video_prompts");
    res.status(result.status).json(result.body);
  });

  app.post("/api/jobs/:id/steps/generate-video", async (req, res) => {
    const result = await runStepRoute(req.params.id, "generate_video");
    res.status(result.status).json(result.body);
  });

  app.get("/api/jobs/:id", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    res.json({ job: record });
  });

  app.get("/api/jobs/:id/script", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const script = await storage.readJson(path.join("processed", "scripts", `${record.id}.json`));
      res.json({ script: simplifyChineseValue(script) });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "script not found" });
        return;
      }
      throw error;
    }
  });

  app.get("/api/jobs/:id/cleaned", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const cleaned = await storage.readJson(path.join("processed", "cleaned", `${record.id}.json`));
      res.json({ cleaned: simplifyChineseValue(cleaned) });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "cleaned result not found" });
        return;
      }
      throw error;
    }
  });

  app.get("/api/jobs/:id/raw-share", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const rawShare = await storage.readJson(path.join("raw", "text", `${record.id}.json`));
      res.json({ rawShare });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "raw share not found" });
        return;
      }
      throw error;
    }
  });

  app.get("/api/jobs/:id/raw-page", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const rawPage = await storage.readJson(path.join("raw", "page", `${record.id}.json`));
      res.json({ rawPage });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "raw page not found" });
        return;
      }
      throw error;
    }
  });

  app.get("/api/jobs/:id/raw-transcript", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const rawTranscript = await storage.readJson(path.join("raw", "transcripts", `${record.id}.json`));
      res.json({ rawTranscript: simplifyChineseValue(rawTranscript) });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "raw transcript not found" });
        return;
      }
      throw error;
    }
  });

  // 分镜接口（保留旧字段以兼容历史任务）
  app.get("/api/jobs/:id/video-prompts", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const script = await storage.readJson<ScriptAsset>(path.join("processed", "scripts", `${record.id}.json`));
      if (!script.shortVideoShots?.length && !script.videoPrompts?.length && !script.enhancedScenes?.length) {
        res.status(404).json({ message: "分镜尚未生成" });
        return;
      }
      res.json(simplifyChineseValue({
        planVersion: script.planVersion,
        targetDuration: script.targetDuration,
        shortVideoScript: script.shortVideoScript,
        shortVideoShots: script.shortVideoShots,
        videoPrompts: script.videoPrompts,
        enhancedScenes: script.enhancedScenes,
        videoOutline: script.videoOutline
      }));
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "script not found" });
        return;
      }
      throw error;
    }
  });

  app.get("/api/jobs/:id/video-output", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const script = await storage.readJson<ScriptAsset>(path.join("processed", "scripts", `${record.id}.json`));
      const videoOutput = script.hyperframesVideo ?? (
        record.videoOutputPath
          ? {
              provider: "hyperframes",
              projectPath: record.videoProjectPath,
              videoPath: record.videoOutputPath,
              createdAt: record.videoGeneratedAt
            }
          : null
      );
      if (!videoOutput) {
        res.status(404).json({ message: "video output not generated yet" });
        return;
      }
      res.json({ videoOutput });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "script not found" });
        return;
      }
      throw error;
    }
  });

  app.get("/api/jobs/:id/video/download", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const videoFullPath = await resolveVideoFile(storage, config.storagePath, record);
      res.download(videoFullPath, `${record.topic}-${record.id.slice(0, 8)}.mp4`);
    } catch (error) {
      if (error instanceof VideoFileError) {
        res.status(404).json({ message: error.message });
        return;
      }
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "script not found" });
        return;
      }
      throw error;
    }
  });

  app.get("/api/jobs/:id/video/stream", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const videoFullPath = await resolveVideoFile(storage, config.storagePath, record);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", "inline");
      res.sendFile(videoFullPath);
    } catch (error) {
      if (error instanceof VideoFileError) {
        res.status(404).json({ message: error.message });
        return;
      }
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "script not found" });
        return;
      }
      throw error;
    }
  });

  // ─── 配置管理 API（浏览器开发模式替代 Electron IPC）─────
  registerConfigRoutes(app);

  // ─── 抖音 Cookie / 扫码登录 API ─────────────────────────────

  // 检查 cookie 状态
  app.get("/api/douyin/cookie-status", (_req, res) => {
    import("./lib/douyin-cookie.js").then(({ hasCookie, hasAuthCookie, getCookiePath }) => {
      const has = hasCookie();
      const hasAuth = hasAuthCookie();
      res.json({
        hasCookie: has,
        hasAuth,
        path: getCookiePath(),
        status: hasAuth ? "authenticated" : has ? "no_auth" : "empty",
      });
    }).catch(err => {
      res.status(500).json({ message: err.message });
    });
  });

  // 扫码登录 — 启动可视化浏览器等待用户扫码
  app.post("/api/douyin/qr-login", async (_req, res) => {
    try {
      const { extractCookiesWithQRLogin } = await import("./lib/douyin-cookie.js");
      const result = await extractCookiesWithQRLogin(120); // 2 minute timeout

      if (result.hasAuth) {
        res.json({
          success: true,
          message: "登录成功，Cookie 已保存",
          hasAuth: true,
          authInfo: result.authInfo,
        });
      } else {
        res.status(401).json({
          success: false,
          message: "登录失败：未检测到登录态",
          hasAuth: false,
        });
      }
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err.message || "扫码登录失败",
        hasAuth: false,
      });
    }
  });

  // 手动保存 Cookie（用户从 Chrome DevTools 复制粘贴）
  app.post("/api/douyin/save-cookie", async (req, res) => {
    try {
      const { cookie } = req.body as { cookie?: string };
      if (!cookie || typeof cookie !== "string" || cookie.trim().length < 10) {
        res.status(400).json({ success: false, message: "请提供有效的 Cookie 字符串" });
        return;
      }
      const { saveCookie, hasAuthCookie, getCookiePath } = await import("./lib/douyin-cookie.js");
      saveCookie(cookie.trim());
      res.json({
        success: true,
        message: "Cookie 已保存",
        hasAuth: hasAuthCookie(),
        path: getCookiePath(),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message || "保存 Cookie 失败" });
    }
  });

  // ─── 合集 API ──────────────────────────────────────────────

  // 创建合集（爬取用户主页 + 创建合集记录）
  app.post("/api/collections", async (req, res) => {
    try {
      const { pageUrl, maxItems } = req.body as { pageUrl?: string; maxItems?: number };
      if (!pageUrl || typeof pageUrl !== "string") {
        res.status(400).json({ message: "pageUrl is required" });
        return;
      }
      const result = await collections.create(pageUrl, Math.min(maxItems ?? 100, 500));
      res.status(201).json({
        collection: result.collection,
        crawlResult: result.crawlResult,
        message: "collection created",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "collection create failed";
      res.status(500).json({ message });
    }
  });

  // 列出所有合集
  app.get("/api/collections", async (_req, res) => {
    try {
      const overviews = await collections.listOverviews();
      res.json({ collections: overviews });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to list collections";
      res.status(500).json({ message });
    }
  });

  // 获取单个合集详情
  app.get("/api/collections/:id", async (req, res) => {
    try {
      const overview = await collections.getOverview(req.params.id);
      if (!overview) {
        res.status(404).json({ message: "collection not found" });
        return;
      }
      res.json({ collection: overview });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to get collection";
      res.status(500).json({ message });
    }
  });

  // 删除合集
  app.delete("/api/collections/:id", async (req, res) => {
    try {
      const deleted = await collections.delete(req.params.id);
      if (!deleted) {
        res.status(404).json({ message: "collection not found" });
        return;
      }
      res.json({ message: "collection deleted" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to delete collection";
      res.status(500).json({ message });
    }
  });

  // 基于合集创建子任务
  app.post("/api/collections/:id/create-jobs", async (req, res) => {
    try {
      const { selectedIds, topic } = req.body as { selectedIds?: string[]; topic?: string };
      if (!selectedIds || !Array.isArray(selectedIds) || selectedIds.length === 0) {
        res.status(400).json({ message: "selectedIds array is required" });
        return;
      }
      const result = await collections.createChildJobs(
        req.params.id,
        selectedIds,
        topic ?? ""
      );
      res.status(201).json({
        collection: result.collection,
        createdJobs: result.createdJobs,
        message: `${result.createdJobs.length} 个子任务已创建`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to create child jobs";
      res.status(500).json({ message });
    }
  });

  // 批量执行合集步骤
  app.post("/api/collections/:id/steps/:step", async (req, res) => {
    try {
      const { id, step } = req.params;
      const pipelineStep = step as PipelineStep;
      if (!["transcribe", "clean", "generate_video_prompts", "generate_video"].includes(pipelineStep)) {
        res.status(400).json({ message: `invalid step: ${step}` });
        return;
      }

      const collection = await collections.get(id);
      if (!collection) {
        res.status(404).json({ message: "collection not found" });
        return;
      }

      const results: Array<{ jobId: string; status: string; error?: string }> = [];
      for (const jobId of collection.childJobIds) {
        try {
          await jobs.runStep(jobId, pipelineStep);
          results.push({ jobId, status: "ok" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "step failed";
          results.push({ jobId, status: "error", error: message });
        }
      }

      const succeeded = results.filter((r) => r.status === "ok").length;
      const failed = results.filter((r) => r.status === "error").length;

      res.json({
        message: `批量${step}完成：${succeeded} 成功，${failed} 失败`,
        results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "batch step failed";
      res.status(500).json({ message });
    }
  });

  // 获取合集全部转录文本（聚合）
  app.get("/api/collections/:id/transcripts", async (req, res) => {
    try {
      const collection = await collections.get(req.params.id);
      if (!collection) {
        res.status(404).json({ message: "collection not found" });
        return;
      }

      const transcripts: Array<{
        jobId: string;
        desc: string;
        transcript: string;
        duration?: number;
        segments?: any[];
      }> = [];

      for (let i = 0; i < collection.childJobIds.length; i++) {
        const jobId = collection.childJobIds[i];
        const item = collection.crawlResult.items[i];
        try {
          const t = await storage.readJson<any>(
            path.join("raw", "transcripts", `${jobId}.json`)
          );
          if (t?.transcript) {
            transcripts.push({
              jobId,
              desc: item?.desc || "(无描述)",
              transcript: t.transcript,
              duration: t.duration,
              segments: t.segments,
            });
          }
        } catch {
          // 转录文件不存在则跳过
        }
      }

      const aggregatedText = transcripts
        .map((t) => `【${t.desc}】\n${t.transcript}`)
        .join("\n\n---\n\n");

      res.json({
        collection: {
          id: collection.id,
          nickname: collection.nickname,
        },
        transcripts,
        aggregatedText,
        summary: {
          totalJobs: collection.childJobIds.length,
          transcribed: transcripts.length,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "fetch transcripts failed";
      res.status(500).json({ message });
    }
  });

  return app;
}

async function resolveVideoFile(storage: LocalStorage, storagePath: string, record: { id: string; videoOutputPath?: string }) {
  const script = await storage.readJson<ScriptAsset>(path.join("processed", "scripts", `${record.id}.json`));
  const videoPath = script.hyperframesVideo?.videoPath ?? record.videoOutputPath;
  if (!videoPath) {
    throw new VideoFileError("video file not generated yet");
  }

  const videoFullPath = resolveOutputPath(storagePath, videoPath);
  if (!existsSync(videoFullPath)) {
    throw new VideoFileError("video file not found on disk");
  }

  return videoFullPath;
}

class VideoFileError extends Error {}

function resolveOutputPath(storagePath: string, outputPath: string) {
  if (path.isAbsolute(outputPath)) {
    return outputPath;
  }
  return path.join(storagePath, outputPath.replace(/^storage\//, ""));
}
