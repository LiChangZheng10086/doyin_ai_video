import express, { Express, type Request, type Response } from "express";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AsrService } from "./lib/asr.js";
import { OpenAiScriptCleaner, RuntimeScriptCleaner } from "./lib/ai-cleaner.js";
import { MediaService } from "./lib/media.js";
import { LocalStorage } from "./lib/storage.js";
import { LocalSessionStore } from "./lib/local-auth.js";
import { registerLocalUserErrorBoundary, registerLocalUserRoutes } from "./lib/local-user-routes.js";
import { LocalUserStore } from "./lib/local-users.js";
import { JobStepError, JobStore } from "./lib/jobs.js";
import { CollectionStore } from "./lib/collections.js";
import { registerConfigRoutes } from "./lib/config-server.js";
import { HyperframesVideoGenerator } from "./lib/hyperframes-video.js";
import { simplifyChineseValue } from "./lib/chinese.js";
import { buildSkillContext, getSkillErrorMessage, isRetryableSkillError } from "./lib/skill-generation.js";
import { resolveJobVideo, VideoOutputError, type ResolvedVideoFile } from "./lib/video-output.js";
import { PublishingStore } from "./lib/publishing-store.js";
import { PublishingCopyService } from "./lib/publishing-copy.js";
import { PublishingAssetService } from "./lib/publishing-assets.js";
import { PublishingService } from "./lib/publishing-service.js";
import { registerPublishingRoutes } from "./lib/publishing-routes.js";
import type { CollectionRecord, DueNotification, PipelineStep, ScriptAsset } from "./types.js";

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
  resolveJobVideo?: typeof resolveJobVideo;
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
  const localUsers = new LocalUserStore(storage);
  await localUsers.init();
  const localSessions = new LocalSessionStore(localUsers);
  const app = express();
  app.locals.localUsers = localUsers;
  app.locals.localSessions = localSessions;

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
  const resolveVideo = config.resolveJobVideo ?? resolveJobVideo;

  const publishingStore = new PublishingStore(storage);
  const publishingCopy = new PublishingCopyService({
    resolveAiConfig: async () => {
      if (config.resolveAiConfig) return config.resolveAiConfig();
      if (!aiApiKey) return null;
      return {
        provider: aiProvider === "deepseek" || aiProvider === "openai" ? aiProvider : "custom",
        model: aiModel,
        apiKey: aiApiKey,
        baseURL: aiBaseURL,
      };
    },
  });
  const publishingAssets = new PublishingAssetService({ storageRoot: config.storagePath });
  const publishingService = new PublishingService({
    storageRoot: config.storagePath,
    jobs,
    store: publishingStore,
    assets: publishingAssets,
    copy: publishingCopy,
    resolveVideo,
  });
  const checkPublishingDue = publishingService.checkDue.bind(publishingService);
  let startupDueNotifications: DueNotification[] = [];
  const publishing = Object.assign(publishingService, {
    list: publishingStore.list.bind(publishingStore),
    getPackage: publishingStore.getPackage.bind(publishingStore),
    checkDue: async () => {
      const current = await checkPublishingDue();
      return [...startupDueNotifications.splice(0), ...current];
    },
  });
  let publishingRecoveryError: string | undefined;
  try {
    await publishingStore.init();
    const recovery = await publishingService.recoverOnStartup();
    startupDueNotifications = recovery.notifications;
  } catch (error) {
    publishingRecoveryError = "发布数据恢复失败，当前发布中心处于只读保护状态";
    console.error(publishingRecoveryError, error);
  }
  app.locals.publishing = publishing;
  app.locals.publishingHealth = publishingRecoveryError
    ? { ok: false, readOnly: true, message: publishingRecoveryError }
    : { ok: true, readOnly: false };

  const collections = new CollectionStore(storage, jobs, {
    cookiesFile: config.cookiesFile,
    cookiesFromBrowser: config.cookiesFromBrowser,
  });
  await collections.init();

  // CORS 中间件（开发环境）
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Local-Session');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "2mb" }));
  registerLocalUserRoutes(app, { users: localUsers, sessions: localSessions });
  registerLocalUserErrorBoundary(app);
  registerPublishingRoutes(app, { publishing, sessions: localSessions });

  // 静态文件（开发环境可能不需要）
  const publicDir = path.join(config.rootDir, "public");
  const publicIndex = path.join(publicDir, "index.html");
  if (existsSync(publicIndex)) {
    app.get("/", (_req, res) => {
      res.sendFile(publicIndex);
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "douyin-ai-video", publishing: app.locals.publishingHealth });
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
      const video = await resolveVideo(config.storagePath, record);
      await sendResolvedVideo(req, res, video, `${record.topic}-${record.id.slice(0, 8)}.mp4`);
    } catch (error) {
      if (error instanceof VideoOutputError) {
        res.status(error.status).json({ code: error.code, message: error.message });
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
      const video = await resolveVideo(config.storagePath, record);
      await sendResolvedVideo(req, res, video);
    } catch (error) {
      if (error instanceof VideoOutputError) {
        res.status(error.status).json({ code: error.code, message: error.message });
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

  // 增量更新合集 — 抓取博主新视频追加到已有合集
  app.post("/api/collections/:id/update", async (req, res) => {
    try {
      const result = await collections.update(req.params.id);
      res.json({
        collection: result.collection,
        newItemsCount: result.newItemsCount,
        message: result.newItemsCount > 0
          ? `新增 ${result.newItemsCount} 个视频`
          : "已是最新，没有新视频",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to update collection";
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

      // 如果是转录步骤且有成功项、且开启了自动同步，则在后台触发 Skill 更新
      if (pipelineStep === "transcribe" && succeeded > 0 && collection.autoSyncSkill && collection.skillName) {
        // 异步触发，不阻塞响应
        generateSkillForCollection(collection.id, collection.nickname, collections, storage, config).catch((err) => {
          console.warn(`Auto-sync skill failed for collection ${collection.id}:`, err.message);
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "batch step failed";
      res.status(500).json({ message });
    }
  });

  // 获取合集全部转录文本（聚合）
  app.get("/api/collections/:id/transcripts", async (req, res) => {
  // 获取合集中每个视频项的子任务状态
  app.get("/api/collections/:id/item-states", async (req, res) => {
    try {
      const collection = await collections.get(req.params.id);
      if (!collection) {
        res.status(404).json({ message: "collection not found" });
        return;
      }

      const itemStates: Record<string, {
        jobId: string;
        status: string;
        stage: string;
        error?: string;
      } | null> = {};

      for (const item of collection.crawlResult.items) {
        const jobId = collection.childJobMap?.[item.awemeId];
        if (!jobId) {
          itemStates[item.awemeId] = null;
          continue;
        }
        const job = await jobs.get(jobId);
        if (!job) {
          itemStates[item.awemeId] = null;
          continue;
        }
        itemStates[item.awemeId] = {
          jobId: job.id,
          status: job.status,
          stage: job.stage,
          error: job.errorMessage || job.steps?.transcribe?.lastError || job.steps?.clean?.lastError || job.steps?.generate_video_prompts?.lastError || job.steps?.generate_video?.lastError,
        };
      }

      res.json({ itemStates });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to get item states";
      res.status(500).json({ message });
    }
  });
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
        const item = collection.crawlResult.items.find(v => collection.childJobMap[v.awemeId] === jobId);
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

  // 生成/更新 Skill 文件
  app.post("/api/collections/:id/generate-skill", async (req, res) => {
    // 此路由无超时限制：AI 两阶段蒸馏大量转录文本可能需要较长时间
    req.setTimeout(0);
    res.setTimeout(0);
    let streamStarted = false;
    try {
      const collection = await collections.get(req.params.id);
      if (!collection) {
        res.status(404).json({ message: "collection not found" });
        return;
      }

      const { focusPrompt, mode } = req.body as {
        focusPrompt?: string;
        mode?: "create" | "update";
      };

      // 先打开流并发送准备状态，避免收集大量转录时界面长时间没有反馈。
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      streamStarted = true;

      const emit = (data: Record<string, unknown>) => {
        if (!res.writableEnded) {
          res.write(JSON.stringify(data) + "\n");
        }
      };

      const done = (data: Record<string, unknown>) => {
        if (res.writableEnded) return;
        res.write(JSON.stringify(data) + "\n");
        res.end();
      };

      emit({
        stage: "collecting",
        message: "正在读取已转录视频…",
        progress: 0,
        current: 0,
        total: collection.childJobIds.length,
      });

      // 1. 收集全部转录文本
      const transcripts: Array<{ desc: string; transcript: string }> = [];
      for (let i = 0; i < collection.childJobIds.length; i++) {
        const jobId = collection.childJobIds[i];
        const item = collection.crawlResult.items.find(v => collection.childJobMap[v.awemeId] === jobId);
        try {
          const t = await storage.readJson<any>(
            path.join("raw", "transcripts", `${jobId}.json`)
          );
          if (t?.transcript) {
            transcripts.push({ desc: item?.desc || "(无描述)", transcript: t.transcript });
          }
        } catch { /* skip */ }
        emit({
          stage: "collecting",
          message: `已读取 ${i + 1}/${collection.childJobIds.length} 个视频`,
          progress: collection.childJobIds.length > 0
            ? Math.round(((i + 1) / collection.childJobIds.length) * 5)
            : 5,
          current: i + 1,
          total: collection.childJobIds.length,
        });
      }

      if (transcripts.length === 0) {
        done({ stage: "error", success: false, progress: 100, error: "没有已转录的文本，请先执行批量转录" });
        return;
      }

      const aggregatedText = transcripts
        .map((t) => `【${t.desc}】\n${t.transcript}`)
        .join("\n\n---\n\n");

      // Skill 名称（基于合集 ID，避免同名覆盖）
      const skillName = `douyin-${collection.id.slice(0, 8)}`;
      const skillsDir = path.join(homedir(), ".claude", "skills", skillName);

      // 获取 AI 配置
      const aiConfig = config.resolveAiConfig
        ? await config.resolveAiConfig()
        : { provider: aiProvider, model: aiModel, apiKey: aiApiKey, baseURL: aiBaseURL };

      if (!aiConfig?.apiKey) {
        done({ stage: "error", success: false, progress: 100, error: "未配置 AI API Key，请在设置中配置" });
        return;
      }

      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({
        apiKey: aiConfig.apiKey,
        baseURL: aiConfig.baseURL || (aiConfig.provider === "deepseek" ? "https://api.deepseek.com" : undefined),
        timeout: 90_000,
        maxRetries: 0,
      });

      const model = aiConfig.model || "deepseek-chat";
      const focusInstruction = focusPrompt?.trim()
        ? `\n\n用户聚焦方向：${focusPrompt.trim()}`
        : "";

      const generated: string[] = [];

      const requestAi = async (
        systemPrompt: string,
        userPrompt: string,
        compactUserPrompt: string,
        maxTokens: number,
        onRetry?: () => void,
      ) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const completion = await client.chat.completions.create({
              model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: attempt === 0 ? userPrompt : compactUserPrompt },
              ],
              max_tokens: maxTokens,
              temperature: 0.7,
            });
            return completion.choices[0]?.message?.content || "";
          } catch (error) {
            if (attempt === 0 && isRetryableSkillError(error)) {
              onRetry?.();
              continue;
            }
            throw error;
          }
        }
        return "";
      };

      // ─── 阶段 1：逐个视频提炼可复用知识 ──────────────────────────────
      const extractedInsights: Array<{ desc: string; transcript: string }> = [];
      const extractionSystemPrompt = `你是知识提炼专家。只处理当前这一个视频的转录，提炼未来生成 Claude Code Skill 有用的事实和方法。

输出简洁的中文 Markdown，不要复述全文，必须包含：
- 核心主题
- 可复用的方法、步骤或原则
- 关键术语/概念
- 案例、数字或边界条件（如果有）

只使用原文信息，不要编造。控制在 300-600 字。${focusInstruction}`;
      let extractionCompleted = 0;
      let extractionFailed = 0;
      let extractionCursor = 0;
      const extractionConcurrency = Math.min(3, transcripts.length);

      emit({
        stage: "extracting",
        message: `开始逐个提炼 ${transcripts.length} 个视频…`,
        progress: 5,
        current: 0,
        total: transcripts.length,
      });

      const extractWorker = async () => {
        while (extractionCursor < transcripts.length) {
          const index = extractionCursor++;
          const item = transcripts[index];
          const sourceText = item.transcript.slice(0, 6000);
          emit({
            stage: "extracting_item",
            message: `正在提炼第 ${index + 1}/${transcripts.length} 个视频`,
            progress: 5 + Math.round((extractionCompleted / transcripts.length) * 55),
            current: extractionCompleted,
            total: transcripts.length,
            itemLabel: item.desc,
          });

          try {
            const insight = await requestAi(
              extractionSystemPrompt,
              `视频描述：${item.desc}\n\n转录文本：\n${sourceText}`,
              `视频描述：${item.desc}\n\n转录文本摘要：\n${sourceText.slice(0, 3000)}`,
              1000,
              () => emit({
                stage: "retrying",
                message: `第 ${index + 1} 个视频请求较慢，正在用精简内容重试`,
                progress: 5 + Math.round((extractionCompleted / transcripts.length) * 55),
                current: extractionCompleted,
                total: transcripts.length,
                itemLabel: item.desc,
              }),
            );
            if (!insight.trim()) {
              throw new Error("AI 没有返回有效提炼内容");
            }
            extractedInsights[index] = { desc: item.desc, transcript: insight.trim() };
          } catch (error) {
            extractionFailed += 1;
            emit({
              stage: "item_failed",
              message: `第 ${index + 1} 个视频提炼失败：${getSkillErrorMessage(error)}`,
              progress: 5 + Math.round(((extractionCompleted + 1) / transcripts.length) * 55),
              current: extractionCompleted + 1,
              total: transcripts.length,
              itemLabel: item.desc,
            });
          }

          extractionCompleted += 1;
          emit({
            stage: "item_done",
            message: `已完成 ${extractionCompleted}/${transcripts.length} 个视频提炼`,
            progress: 5 + Math.round((extractionCompleted / transcripts.length) * 55),
            current: extractionCompleted,
            total: transcripts.length,
            itemLabel: item.desc,
          });
        }
      };

      await Promise.all(Array.from({ length: extractionConcurrency }, () => extractWorker()));
      const successfulInsights = extractedInsights.filter(Boolean);
      if (successfulInsights.length === 0) {
        done({
          stage: "error",
          success: false,
          progress: 100,
          error: "所有视频提炼都失败，未生成 Skill。请检查 AI 中转服务后重试。",
        });
        return;
      }
      const skillContext = buildSkillContext(successfulInsights);
      const compactSkillContext = buildSkillContext(successfulInsights, 6000);

      // ─── 阶段 2：汇总每个视频的提炼结果，决定产物类型 ────────────────

      emit({
        stage: "analyze",
        message: extractionFailed > 0
          ? `正在汇总 ${successfulInsights.length} 个成功结果（${extractionFailed} 个视频提炼失败）…`
          : "正在汇总视频提炼结果，判断产物类型…",
        progress: 62,
      });

      const stage1SystemPrompt = `你是 Skill 设计专家。分析以下视频转录文本，判断适合生成哪些知识增强产物。

返回纯 JSON（不要 markdown 包裹）：
{
  "skillType": "knowledge",
  "title": "Skill 标题（10字以内）",
  "description": "一行中文描述（30字以内）",
  "generates": {
    "knowledge_base": true/false,
    "case_library": true/false,
    "quotes_collection": true/false,
    "checklist": true/false,
    "templates": true/false,
    "decision_framework": true/false
  },
  "templates": [{ "name": "模板名称", "topic": "适用场景" }]
}

判断标准：
- knowledge_base：有 >= 5 个专有术语可定义时生成
- case_library：有 >= 3 个可归纳的案例/故事时生成
- quotes_collection：有 >= 8 条原创金句/观点时生成
- checklist：内容有明确的可操作步骤/流程时生成
- templates：有可复用的框架/公式/结构时生成（列出具体模板）
- decision_framework：有需要决策树的复杂判断逻辑时生成
- skillType 固定为 "knowledge"
${focusInstruction}`;

      let stage1Result: {
        skillType: string;
        title: string;
        description: string;
        generates: Record<string, boolean>;
        templates: Array<{ name: string; topic: string }>;
      };

      try {
        const rawJson = (await requestAi(
          stage1SystemPrompt,
          `来源：抖音合集「${collection.nickname}」，共 ${transcripts.length} 个视频。\n\n${skillContext}`,
          `来源：抖音合集「${collection.nickname}」，共 ${transcripts.length} 个视频。\n\n${compactSkillContext}`,
          1000,
          () => emit({
            stage: "retrying",
            message: "汇总请求较慢，正在用精简知识重试",
            progress: 62,
          }),
        )).trim();
        const jsonMatch = rawJson.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("阶段 1 返回格式异常");
        stage1Result = JSON.parse(jsonMatch[0]);

        // 报告阶段 1 分析结果
        const generatingCount = Object.values(stage1Result.generates).filter(Boolean).length + 2; // +2: skill_md + eval
        const templateCount = stage1Result.generates.templates ? (stage1Result.templates?.length || 0) : 0;
        const totalTasks = generatingCount + templateCount;
        emit({
          stage: "planned",
          message: `分析完成，将生成 ${totalTasks} 项产物`,
          progress: 65,
          totalTasks,
          generates: stage1Result.generates,
          templates: stage1Result.templates,
        });
      } catch (err: any) {
        done({
          stage: "error",
          success: false,
          progress: 100,
          error: `Skill 分析阶段失败：${getSkillErrorMessage(err)}`
        });
        return;
      }

      // 准备目录
      mkdirSync(skillsDir, { recursive: true });
      mkdirSync(path.join(skillsDir, "references"), { recursive: true });
      mkdirSync(path.join(skillsDir, "assets"), { recursive: true });
      mkdirSync(path.join(skillsDir, "assets", "templates"), { recursive: true });
      mkdirSync(path.join(skillsDir, "evals"), { recursive: true });

      const writeFile = async (relativePath: string, content: string) => {
        const filePath = path.join(skillsDir, relativePath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, content, "utf-8");
      };

      // 产物生成任务定义
      interface GenerateTask {
        id: string;
        label: string;
        shouldRun: boolean;
        systemPrompt: string;
        userPrompt: string;
        outputFile: string;
      }

      const tasks: GenerateTask[] = [
        // SKILL.md — 始终生成（增强版）
        {
          id: "enhanced_skill_md",
          label: "增强 SKILL.md",
          shouldRun: true,
          systemPrompt: `你是 Claude Code Skill 创作专家。基于视频转录内容，创作一份**生产级**知识增强型 SKILL.md。

必需的 frontmatter：
---
name: "${skillName}"
description: "${stage1Result.description}"
---

正文必须包含以下 section（有实质内容才保留）：
## 概述 — Skill 的用途、适用对象、输入输出
## 触发条件 — 什么情况下 Claude 应该激活这个 Skill（明确的关键词、场景描述）
## 多阶段执行指令 — Step-by-step 指导流程，每一阶段写明输入/输出/成功标准
## 决策树 — 用文本流程图表示关键决策点（如 IF...THEN...ELSE...）
## 核心方法论 — 可复用的框架、步骤、原则（要具体可操作，不是摘要）
## 金句与观点索引 — 列出关键金句 + 引用指针（详见 references/quotes-collection.md）
## 术语索引 — 列出术语 + 简要定义 + 引用指针（详见 references/knowledge-base.md）
## 案例索引 — 列出案例名 + 一句话概要 + 引用指针（详见 references/case-library.md）
## 执行检查清单 — 调用前/中/后的自检项（详见 assets/checklist.md）
## 可复用模板 — 列出模板名 + 适用场景（详见 assets/templates/）
## 对话示例 — 至少 2 组 User/Claude 交互示例（展示 Skill 的实际使用方式）
## 边界与注意事项 — 不适用的情况、局限性、版本信息

要求：
- SKILL.md 是入口文件，正文方法论要精炼，详细内容放入 references/
- 使用引用指针（详见 xxx.md）避免 SKILL.md 过于冗长
- 方法论要有可执行性：不是 "分析冲突"，而是 "1. 列出角色 X 和 Y 的目标 2. 标注目标互斥点 3. 设计 escalate 节点..."
- 决策树用文本缩进表示层级`,
          userPrompt: `来源：抖音合集「${collection.nickname}」，共 ${transcripts.length} 个视频。

已分析产物框架：
${JSON.stringify(stage1Result, null, 2)}

原始转录文本（已按视频均衡压缩，完整原文保存在本地 references/source.md）：
${skillContext}`,
          outputFile: "SKILL.md",
        },
        // Knowledge base
        {
          id: "knowledge_base",
          label: "结构化知识库",
          shouldRun: stage1Result.generates.knowledge_base,
          systemPrompt: `你是知识整理专家。从视频转录中提取**所有专业术语、概念和领域知识**，生成结构化知识库。

格式（Markdown）：
# 知识库

## 术语词典
按字母/拼音排序，每条格式：
### 术语名
- **定义**：一句话定义
- **出处**：来自哪个视频/谁说的
- **相关术语**：关联的其他术语

## 方法卡片
每个方法论/技巧一张卡片：
### 方法名
- **一句话**：这是什么
- **何时用**：触发场景
- **怎么做**：步骤 1/2/3
- **预期效果**：做对了会怎样
- **常见错误**：做错了会怎样`,
          userPrompt: `来源：抖音合集「${collection.nickname}」，共 ${transcripts.length} 个视频。\n\n请提取所有术语和方法论：\n\n${skillContext}`,
          outputFile: "references/knowledge-base.md",
        },
        // Case library
        {
          id: "case_library",
          label: "案例库",
          shouldRun: stage1Result.generates.case_library,
          systemPrompt: `你是案例分析专家。从转录中提取所有**案例、故事、实战经历**，生成结构化案例库。

每个案例格式：
## 案例 N：一句话标题
- **来源视频**：描述
- **背景/情境**：什么情况下发生的
- **问题/挑战**：遇到了什么困难
- **做法/应对**：怎么处理的
- **结果**：最终怎样
- **可复用教训**：3-5 条可迁移的行动指南
- **适用条件**：什么情况下这个教训有效`,
          userPrompt: `来源：抖音合集「${collection.nickname}」。\n\n请提取所有案例：\n\n${skillContext}`,
          outputFile: "references/case-library.md",
        },
        // Quotes collection
        {
          id: "quotes_collection",
          label: "金句合集",
          shouldRun: stage1Result.generates.quotes_collection,
          systemPrompt: `你是一位编辑。从视频转录中提取**所有值得引用/转发/收藏的金句和观点**。

格式：
# 金句与观点合集

## 金句（可直接引用的原句）
> 金句原文
- 出处：哪个视频
- 适用语境：什么时候引用

## 核心观点（概括性观点）
### 观点标题
- **核心论点**：用一段话概括
- **支撑论据**：原文中怎么论证的
- **反方观点**：原文是否提到了反对意见`,
          userPrompt: `来源：抖音合集「${collection.nickname}」。\n\n请提取所有金句和核心观点：\n\n${skillContext}`,
          outputFile: "references/quotes-collection.md",
        },
        // Checklist
        {
          id: "checklist",
          label: "执行检查清单",
          shouldRun: stage1Result.generates.checklist,
          systemPrompt: `你是一位流程优化专家。从视频转录中提取所有**可操作的检查清单和流程步骤**。

格式：
# 执行检查清单

## 阶段 N：阶段名称
### 开始前检查
- [ ] 是否已满足前置条件 A？
- [ ] 是否已准备 B 资源？

### 执行中检查
- [ ] 步骤 X 的输出是否符合预期 Y？
- [ ] 是否已处理边界情况 Z？

### 完成后验证
- [ ] 最终结果满足标准 W 吗？
- [ ] 是否有遗留问题需要追踪？

## 常见踩坑清单
- ❌ 错误做法 → 后果 → ✅ 正确做法`,
          userPrompt: `来源：抖音合集「${collection.nickname}」。\n\n请提取所有检查清单和流程：\n\n${skillContext}`,
          outputFile: "assets/checklist.md",
        },
        // Decision framework
        {
          id: "decision_framework",
          label: "决策框架",
          shouldRun: stage1Result.generates.decision_framework,
          systemPrompt: `你是一位决策分析专家。从视频转录中提取所有**需要多步骤判断和决策的框架**。

格式：
# 决策框架

## 框架 N：框架名称
### 适用场景
### 决策树
用文本缩进表示：
1. 第一步判断：条件 A？
   - YES → 进入路线 A-1
     - 子判断 A1-1 → 选择 X
     - 子判断 A1-2 → 选择 Y
   - NO → 进入路线 B
     - 子判断 B-1 → ....

### 每个分支的详细说明
### 常见误判与修正`,
          userPrompt: `来源：抖音合集「${collection.nickname}」。\n\n请提取所有决策框架：\n\n${skillContext}`,
          outputFile: "assets/decision-framework.md",
        },
        // Eval cases — 始终生成
        {
          id: "eval_cases",
          label: "验收用例",
          shouldRun: true,
          systemPrompt: `你是测试设计专家。为这个 Skill 设计验收测试用例。每个用例包含输入场景和预期行为。

格式：
# 验收测试用例

## 用例 N：场景名称
- **输入描述**：用户会对 Claude 说什么/问什么
- **预期行为**：Claude 应该做什么
- **成功标准**：怎么判断 Skill 被正确激活并执行了
- **可能失败模式**：Claude 可能走偏的路径`,
          userPrompt: `Skill 名称：${skillName}\nSkill 描述：${stage1Result.description}\nSkill 类型：${stage1Result.skillType}\n\n转录来源：抖音合集「${collection.nickname}」，共 ${transcripts.length} 个视频。\n\n请设计 5-8 个验收测试用例。\n\n参考提炼结果：\n${skillContext}`,
          outputFile: "evals/test-cases.md",
        },
      ];

      // 模板生成任务（由阶段 1 决定）
      if (stage1Result.generates.templates && stage1Result.templates.length > 0) {
        for (const tpl of stage1Result.templates) {
          const safeName = tpl.name.replace(/[/\\:*?"<>|]/g, "-").slice(0, 30);
          tasks.push({
            id: `template_${safeName}`,
            label: `模板：${tpl.name}`,
            shouldRun: true,
            systemPrompt: `你是一位模板设计专家。基于视频转录内容，创建可复用的**「${tpl.name}」**模板。

格式：
# ${tpl.name}

## 适用场景
${tpl.topic}

## 模板

### 前置条件/准备工作

### 主体内容框架
（用填空/占位符形式，让用户填入自己的内容）

### 完成标准

### 使用示例
（填入一个模拟例子展示模板如何使用）

要求：模板必须可以直接使用，占位符用【xxx】标记。`,
            userPrompt: `来源：抖音合集「${collection.nickname}」。\n\n请根据以下提炼结果创建「${tpl.name}」模板：\n\n${skillContext}`,
            outputFile: `assets/templates/${safeName}.md`,
          });
        }
      }

      // 阶段 3：实际需要运行的任务
      const activeTasks = tasks.filter((t) => t.shouldRun);

      emit({
        stage: "generating",
        message: `开始生成产物（共 ${activeTasks.length} 项）…`,
        progress: 65,
        current: 0,
        total: activeTasks.length,
      });

      // 阶段 3：逐个串行执行（避免对 API 代理造成压力，也更稳定）
      let completed = 0;
      const failed: string[] = [];
      for (const task of activeTasks) {
        emit({
          stage: "generating_item",
          message: `正在生成：${task.label}`,
          progress: 65 + Math.round((completed / activeTasks.length) * 34),
          current: completed,
          total: activeTasks.length,
          itemId: task.id,
          itemLabel: task.label,
        });

        try {
          const maxTokens = task.id === "enhanced_skill_md"
            ? 5000
            : task.id.startsWith("template_") ? 2200 : 2600;
          const content = await requestAi(
            task.systemPrompt,
            task.userPrompt,
            task.userPrompt.replace(skillContext, compactSkillContext),
            maxTokens,
            () => emit({
              stage: "retrying",
              message: `${task.label} 请求较慢，正在用精简知识重试`,
              progress: 65 + Math.round((completed / activeTasks.length) * 34),
              current: completed,
              total: activeTasks.length,
              itemId: task.id,
              itemLabel: task.label,
            }),
          );
          if (content.trim()) {
            await writeFile(task.outputFile, content.trim());
            generated.push(task.id);
            emit({
              stage: "item_done",
              message: `${task.label} — 完成`,
              progress: 65 + Math.round(((completed + 1) / activeTasks.length) * 34),
              current: completed + 1,
              total: activeTasks.length,
              itemId: task.id,
            });
          } else {
            failed.push(task.label);
            emit({
              stage: "item_failed",
              message: `${task.label} — AI 未返回内容`,
              progress: 65 + Math.round(((completed + 1) / activeTasks.length) * 34),
              current: completed + 1,
              total: activeTasks.length,
              itemId: task.id,
            });
          }
        } catch (err: any) {
          console.warn(`[generate-skill] 产物 "${task.id}" 生成失败:`, err.message);
          failed.push(task.label);
          emit({
            stage: "item_failed",
            message: `${task.label} — 失败：${getSkillErrorMessage(err)}`,
            progress: 65 + Math.round(((completed + 1) / activeTasks.length) * 34),
            current: completed + 1,
            total: activeTasks.length,
            itemId: task.id,
          });
        }
        completed++;
      }

      // 始终写入 source.md 和 meta.json
      writeFileSync(
        path.join(skillsDir, "references", "source.md"),
        `# 原始转录来源\n\n合集：${collection.nickname}\n生成时间：${new Date().toISOString()}\n视频数：${transcripts.length}\n\n${aggregatedText}`,
        "utf-8"
      );
      writeFileSync(
        path.join(skillsDir, "references", "meta.json"),
        JSON.stringify({
          collectionId: collection.id,
          nickname: collection.nickname,
          sourcePageUrl: collection.sourcePageUrl,
          generatedAt: new Date().toISOString(),
          videoCount: transcripts.length,
          hasFocusPrompt: !!focusPrompt?.trim(),
          skillType: stage1Result.skillType,
          generated,
          stage1Analysis: stage1Result,
        }, null, 2),
        "utf-8"
      );

      // 更新合集 Skill 元信息
      await collections.updateSkillMeta(collection.id, {
        skillName,
        skillPath: skillsDir,
        skillGeneratedAt: new Date().toISOString(),
      });

      const productLabels: Record<string, string> = {
        enhanced_skill_md: "增强 SKILL.md",
        knowledge_base: "结构化知识库",
        case_library: "案例库",
        quotes_collection: "金句合集",
        checklist: "执行检查清单",
        decision_framework: "决策框架",
        eval_cases: "验收用例",
      };

      const generatedLabels = generated
        .filter((g) => !g.startsWith("template_"))
        .map((g) => productLabels[g] || g);
      const templateCount = generated.filter((g) => g.startsWith("template_")).length;
      if (templateCount > 0) {
        generatedLabels.push(`${templateCount} 个模板`);
      }

      if (generated.length === 0) {
        done({
          stage: "error",
          success: false,
          progress: 100,
          error: `所有 Skill 产物生成失败：${failed.join("、") || "未知错误"}`,
        });
        return;
      }

      done({
        stage: "done",
        success: true,
        progress: 100,
        skillName,
        skillPath: skillsDir,
        message: `已生成 ${generatedLabels.length} 项产物${failed.length ? `，${failed.length} 项失败` : ""}`,
        generated: generatedLabels,
        allGenerated: generated,
        skillType: stage1Result.skillType,
        failed,
      });
    } catch (error) {
      const message = getSkillErrorMessage(error);
      if (!streamStarted && !res.headersSent) {
        res.status(500).json({ message });
      } else if (!res.writableEnded) {
        res.write(JSON.stringify({ stage: "error", success: false, progress: 100, error: message }) + "\n");
        res.end();
      }
    }
  });

  // 查看 Skill 内容
  app.get("/api/collections/:id/skill-content", async (req, res) => {
    try {
      const collection = await collections.get(req.params.id);
      if (!collection) {
        res.status(404).json({ message: "collection not found" });
        return;
      }

      if (!collection.skillPath) {
        res.status(404).json({ message: "该合集尚未生成 Skill" });
        return;
      }

      const skillsDir = collection.skillPath;
      const readFileSafe = async (p: string) => {
        try {
          return await import("node:fs").then((m) => m.promises.readFile(p, "utf-8"));
        } catch {
          return null;
        }
      };

      // 读取所有可能存在的产物
      const [
        skillMarkdown, sourceMarkdown, metaRaw,
        knowledgeBase, caseLibrary, quotesCollection,
        checklist, decisionFramework, evalCases,
      ] = await Promise.all([
        readFileSafe(path.join(skillsDir, "SKILL.md")),
        readFileSafe(path.join(skillsDir, "references", "source.md")),
        readFileSafe(path.join(skillsDir, "references", "meta.json")),
        readFileSafe(path.join(skillsDir, "references", "knowledge-base.md")),
        readFileSafe(path.join(skillsDir, "references", "case-library.md")),
        readFileSafe(path.join(skillsDir, "references", "quotes-collection.md")),
        readFileSafe(path.join(skillsDir, "assets", "checklist.md")),
        readFileSafe(path.join(skillsDir, "assets", "decision-framework.md")),
        readFileSafe(path.join(skillsDir, "evals", "test-cases.md")),
      ]);

      // 读取模板文件列表
      let templates: Array<{ name: string; content: string }> = [];
      try {
        const templatesDir = path.join(skillsDir, "assets", "templates");
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(templatesDir);
        for (const file of files) {
          if (file.endsWith(".md")) {
            const content = await readFileSafe(path.join(templatesDir, file));
            if (content) {
              templates.push({ name: file.replace(/\.md$/, ""), content });
            }
          }
        }
      } catch { /* no templates */ }

      let meta = null;
      if (metaRaw) {
        try {
          meta = JSON.parse(metaRaw);
        } catch { /* ignore */ }
      }

      res.json({
        skillName: collection.skillName,
        skillPath: skillsDir,
        skillMarkdown: skillMarkdown || "",
        sourceMarkdown: sourceMarkdown || "",
        meta,
        // 新增产物
        knowledgeBase: knowledgeBase || "",
        caseLibrary: caseLibrary || "",
        quotesCollection: quotesCollection || "",
        checklist: checklist || "",
        decisionFramework: decisionFramework || "",
        evalCases: evalCases || "",
        templates,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "read skill failed";
      res.status(500).json({ message });
    }
  });

  // 列出所有已生成的 Skill
  app.get("/api/skills", async (_req, res) => {
    try {
      const allCollections = await collections.list();
      const skills = allCollections
        .filter((c) => c.skillName)
        .map((c) => ({
          collectionId: c.id,
          collectionNickname: c.nickname,
          avatarUrl: c.avatarUrl || "",
          skillName: c.skillName,
          skillPath: c.skillPath,
          skillGeneratedAt: c.skillGeneratedAt,
          autoSyncSkill: c.autoSyncSkill || false,
          transcribedCount: c.childJobIds.length,
        }));
      res.json({ skills });
    } catch (error) {
      const message = error instanceof Error ? error.message : "list skills failed";
      res.status(500).json({ message });
    }
  });

  // 重命名 Skill
  app.put("/api/skills/:collectionId/rename", async (req, res) => {
    try {
      const { newName } = req.body as { newName?: string };
      if (!newName || typeof newName !== "string" || !/^[\w一-鿿-]+$/.test(newName)) {
        res.status(400).json({ message: "newName 仅支持字母、数字、中文、下划线和短横线" });
        return;
      }

      const collection = await collections.get(req.params.collectionId);
      if (!collection) {
        res.status(404).json({ message: "collection not found" });
        return;
      }
      if (!collection.skillName || !collection.skillPath) {
        res.status(400).json({ message: "该合集未生成 Skill" });
        return;
      }

      const homedir = await import("node:os").then(m => m.homedir());
      const { rename, access } = await import("node:fs/promises");
      const path = await import("node:path");

      const newSkillDir = path.join(homedir, ".claude", "skills", newName);

      // 检查目标路径是否已存在
      try {
        await access(newSkillDir);
        res.status(409).json({ message: `Skill 名称 "${newName}" 已存在` });
        return;
      } catch { /* 不存在，可以重命名 */ }

      // 重命名目录
      try {
        await rename(collection.skillPath, newSkillDir);
      } catch {
        // rename 跨设备可能失败，用 copy + delete
        const { cp, rm: del } = await import("node:fs/promises");
        await cp(collection.skillPath, newSkillDir, { recursive: true });
        await del(collection.skillPath, { recursive: true, force: true });
      }

      // 更新 SKILL.md 的 frontmatter name 字段
      const skillMdPath = path.join(newSkillDir, "SKILL.md");
      try {
        const { readFile, writeFile } = await import("node:fs/promises");
        let content = await readFile(skillMdPath, "utf8");
        content = content.replace(/^name:\s*.*$/m, `name: ${newName}`);
        await writeFile(skillMdPath, content, "utf8");
      } catch {
        // SKILL.md 不存在不影响
      }

      // 更新合集记录
      await collections.updateSkillMeta(req.params.collectionId, {
        skillName: newName,
        skillPath: newSkillDir,
        skillGeneratedAt: collection.skillGeneratedAt ?? new Date().toISOString(),
      });

      res.json({ success: true, skillName: newName, skillPath: newSkillDir });
    } catch (error) {
      const message = error instanceof Error ? error.message : "rename skill failed";
      res.status(500).json({ message });
    }
  });

  // 删除 Skill 文件并清除合集记录
  app.delete("/api/skills/:collectionId", async (req, res) => {
    try {
      const collection = await collections.get(req.params.collectionId);
      if (!collection) {
        res.status(404).json({ message: "collection not found" });
        return;
      }

      // 删除 Skill 目录
      if (collection.skillPath) {
        try {
          const { rm } = await import("node:fs/promises");
          await rm(collection.skillPath, { recursive: true, force: true });
        } catch {
          // 文件删除失败不影响记录清理
        }
      }

      // 清除合集 skill 字段
      await collections.updateSkillMeta(req.params.collectionId, {
        skillName: "",
        skillPath: "",
        skillGeneratedAt: new Date().toISOString(),
      });

      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "delete skill failed";
      res.status(500).json({ message });
    }
  });

  // 切换自动同步 Skill 开关
  app.post("/api/collections/:id/toggle-auto-sync-skill", async (req, res) => {
    try {
      const collection = await collections.get(req.params.id);
      if (!collection) {
        res.status(404).json({ message: "collection not found" });
        return;
      }

      const { enabled } = req.body as { enabled: boolean };
      const updated = await collections.toggleAutoSyncSkill(req.params.id, enabled);
      res.json({ success: true, autoSyncSkill: updated?.autoSyncSkill });
    } catch (error) {
      const message = error instanceof Error ? error.message : "toggle failed";
      res.status(500).json({ message });
    }
  });

  return app;
}

async function sendResolvedVideo(
  req: Request,
  res: Response,
  video: ResolvedVideoFile,
  downloadFilename?: string,
): Promise<void> {
  try {
    res.setHeader("Accept-Ranges", "bytes");
    if (downloadFilename) res.attachment(downloadFilename);
    else res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", video.mimeType);

    const parsedRange = req.headers.range ? req.range(video.size, { combine: true }) : undefined;
    if (parsedRange === -1 || parsedRange === -2) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${video.size}`);
      res.end();
      return;
    }

    const range = Array.isArray(parsedRange) && parsedRange.length === 1 ? parsedRange[0] : undefined;
    const start = range?.start ?? 0;
    const end = range?.end ?? video.size - 1;
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${video.size}`);
    }
    res.setHeader("Content-Length", String(end - start + 1));
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = video.handle.createReadStream({ start, end, autoClose: false });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        res.off("finish", onFinish);
        res.off("close", onClose);
        stream.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onFinish = () => settle();
      const onClose = () => {
        if (!res.writableFinished) stream.destroy();
        settle();
      };
      const onError = (error: Error) => settle(error);
      res.once("finish", onFinish);
      res.once("close", onClose);
      stream.once("error", onError);
      stream.pipe(res);
    });
  } finally {
    await video.close().catch(() => undefined);
  }
}

async function generateSkillForCollection(
  collectionId: string,
  nickname: string,
  _collections: CollectionStore,
  _storage: LocalStorage,
  _config: ServerConfig,
  focusPrompt?: string,
): Promise<void> {
  const skillName = `douyin-${collectionId.slice(0, 8)}`;
  const skillsDir = path.join(homedir(), ".claude", "skills", skillName);

  // Gather all transcripts
  const transcripts: Array<{ desc: string; transcript: string }> = [];
  const collection = await _collections.get(collectionId);
  if (!collection) return;

  for (let i = 0; i < collection.childJobIds.length; i++) {
    const jobId = collection.childJobIds[i];
    const item = collection.crawlResult.items.find(v => collection.childJobMap[v.awemeId] === jobId);
    try {
      const t = await _storage.readJson<any>(path.join("raw", "transcripts", `${jobId}.json`));
      if (t?.transcript) {
        transcripts.push({ desc: item?.desc || "(无描述)", transcript: t.transcript });
      }
    } catch { /* skip */ }
  }

  if (transcripts.length === 0) return;

  const aggregatedText = transcripts
    .map((t) => `【${t.desc}】\n${t.transcript}`)
    .join("\n\n---\n\n");

  const focusInstruction = focusPrompt?.trim()
    ? `\n\n用户聚焦方向（只提取与此相关的知识，忽略无关内容）：${focusPrompt.trim()}`
    : "";

  const systemPrompt = `你是知识蒸馏专家。将以下视频转录文本提炼为可复用的 Claude Code Skill（SKILL.md）。

输出格式：
- frontmatter 包含 name: "${skillName}" 和 description（一行中文描述）
- 正文按以下 section 组织（如果某个 section 没有实质内容可省略）：
  ## 核心方法论 — 可复用的框架、步骤、原则
  ## 金句与观点 — 可直接引用的精华语句
  ## 术语表 — 领域术语及解释
  ## 案例库 — 原文中的案例、故事及其教训
  ## 适用场景 — 何时触发这个 Skill
  ## 边界与注意事项 — 不适用的情况、局限性
- SKILL.md 总体保持精炼（200-400行），方法论要有可执行性（不是摘要，是可操作的步骤）
${focusInstruction}`;

  const userPrompt = `来源：抖音合集「${nickname}」，共 ${transcripts.length} 个视频的转录文本（自动同步更新）。

${aggregatedText}`;

  const aiProvider = _config.aiProvider ?? "deepseek";
  const aiConfig = _config.resolveAiConfig
    ? await _config.resolveAiConfig()
    : { provider: aiProvider as string, model: _config.aiModel ?? "deepseek-chat", apiKey: _config.aiApiKey, baseURL: _config.aiBaseURL ?? (aiProvider === "deepseek" ? "https://api.deepseek.com" : undefined) };

  if (!aiConfig?.apiKey) return;

  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({
    apiKey: aiConfig.apiKey,
    baseURL: aiConfig.baseURL || (aiConfig.provider === "deepseek" ? "https://api.deepseek.com" : undefined),
  });

  const completion = await client.chat.completions.create({
    model: aiConfig.model || "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 8000,
    temperature: 0.7,
  });

  const skillContent = completion.choices[0]?.message?.content || "";
  if (!skillContent.trim()) return;

  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(path.join(skillsDir, "references"), { recursive: true });
  writeFileSync(path.join(skillsDir, "SKILL.md"), skillContent, "utf-8");
  writeFileSync(
    path.join(skillsDir, "references", "source.md"),
    `# 原始转录来源\n\n合集：${nickname}\n自动同步时间：${new Date().toISOString()}\n视频数：${transcripts.length}\n\n${aggregatedText}`,
    "utf-8"
  );

  await _collections.updateSkillMeta(collectionId, {
    skillName,
    skillPath: skillsDir,
    skillGeneratedAt: new Date().toISOString(),
  });
}
