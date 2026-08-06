import express, { Express } from "express";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

  // 生成/更新 Skill 文件
  app.post("/api/collections/:id/generate-skill", async (req, res) => {
    // 此路由无超时限制：AI 蒸馏大量转录文本可能需要较长时间
    req.setTimeout(0);
    res.setTimeout(0);
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

      // 1. 收集全部转录文本
      const transcripts: Array<{ desc: string; transcript: string }> = [];
      for (let i = 0; i < collection.childJobIds.length; i++) {
        const jobId = collection.childJobIds[i];
        const item = collection.crawlResult.items[i];
        try {
          const t = await storage.readJson<any>(
            path.join("raw", "transcripts", `${jobId}.json`)
          );
          if (t?.transcript) {
            transcripts.push({ desc: item?.desc || "(无描述)", transcript: t.transcript });
          }
        } catch { /* skip */ }
      }

      if (transcripts.length === 0) {
        res.status(400).json({ message: "没有已转录的文本，请先执行批量转录" });
        return;
      }

      const aggregatedText = transcripts
        .map((t) => `【${t.desc}】\n${t.transcript}`)
        .join("\n\n---\n\n");

      // 2. 生成 Skill 名称（基于合集 ID，避免同名覆盖）
      const skillName = `douyin-${collection.id.slice(0, 8)}`;
      const skillsDir = path.join(homedir(), ".claude", "skills", skillName);

      // 3. 调用 AI 蒸馏
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

      const userPrompt = `来源：抖音合集「${collection.nickname}」，共 ${transcripts.length} 个视频的转录文本。

${aggregatedText}`;

      // 4. 调用 AI（复用现有 cleaner 的 OpenAI 客户端）
      let skillContent: string;
      try {
        // 使用 RuntimeScriptCleaner 获取当前活跃的 AI 配置
        const aiConfig = config.resolveAiConfig
          ? await config.resolveAiConfig()
          : { provider: aiProvider, model: aiModel, apiKey: aiApiKey, baseURL: aiBaseURL };

        if (!aiConfig?.apiKey) {
          res.status(400).json({ message: "未配置 AI API Key，请在设置中配置" });
          return;
        }

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

        skillContent = completion.choices[0]?.message?.content || "";
        if (!skillContent.trim()) {
          throw new Error("AI 返回空内容");
        }
      } catch (err: any) {
        const message = err?.message || "AI 调用失败";
        res.status(500).json({ message: `Skill 生成失败：${message}` });
        return;
      }

      // 5. 写入文件
      mkdirSync(skillsDir, { recursive: true });
      mkdirSync(path.join(skillsDir, "references"), { recursive: true });

      writeFileSync(path.join(skillsDir, "SKILL.md"), skillContent, "utf-8");
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
        }, null, 2),
        "utf-8"
      );

      // 6. 更新合集 Skill 元信息
      await collections.updateSkillMeta(collection.id, {
        skillName,
        skillPath: skillsDir,
        skillGeneratedAt: new Date().toISOString(),
      });

      res.json({
        success: true,
        skillName,
        skillPath: skillsDir,
        message: `Skill 已生成：${skillName}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "generate skill failed";
      res.status(500).json({ message });
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

      const [skillMarkdown, sourceMarkdown, metaRaw] = await Promise.all([
        readFileSafe(path.join(skillsDir, "SKILL.md")),
        readFileSafe(path.join(skillsDir, "references", "source.md")),
        readFileSafe(path.join(skillsDir, "references", "meta.json")),
      ]);

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
    const item = collection.crawlResult.items[i];
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

function resolveOutputPath(storagePath: string, outputPath: string) {
  if (path.isAbsolute(outputPath)) {
    return outputPath;
  }
  return path.join(storagePath, outputPath.replace(/^storage\//, ""));
}
