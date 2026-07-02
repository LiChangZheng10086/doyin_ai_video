import express, { Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { AsrService } from "./lib/asr.js";
import { OpenAiScriptCleaner } from "./lib/ai-cleaner.js";
import { MediaService } from "./lib/media.js";
import { LocalStorage } from "./lib/storage.js";
import { JobStepError, JobStore } from "./lib/jobs.js";
import { createPPTGenerator } from "./lib/ppt-generator.js";
import type { PipelineStep, ScriptAsset } from "./types.js";

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
  asrApiKey?: string;
  asrBaseURL?: string;
  asrModel?: string;
  asrProvider?: string;
  asrPythonBinary?: string;
  whisperModelSize?: string;
  whisperDevice?: string;
  whisperComputeType?: string;
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

  const cleaner = new OpenAiScriptCleaner({
    apiKey: aiApiKey,
    model: aiModel,
    baseURL: aiBaseURL,
    provider: aiProvider === "deepseek" ? "deepseek" : "openai"
  });

  const media = new MediaService(storage, {
    ytDlpBinary: config.ytDlpBinary,
    ffmpegBinary: config.ffmpegBinary,
    ffprobeBinary: config.ffprobeBinary,
    cookiesFile: config.cookiesFile,
    cookiesFromBrowser: config.cookiesFromBrowser
  });

  const asr = new AsrService({
    apiKey: config.asrApiKey ?? config.aiApiKey,
    baseURL: config.asrBaseURL,
    model: config.asrModel,
    provider: config.asrProvider,
    pythonBinary: config.asrPythonBinary,
    whisperModelSize: config.whisperModelSize,
    whisperDevice: config.whisperDevice,
    whisperComputeType: config.whisperComputeType
  });

  const pptGenerator = createPPTGenerator({
    apiKey: aiApiKey,
    model: aiModel,
    baseURL: aiBaseURL,
    provider: aiProvider === "deepseek" ? "deepseek" : "openai",
    storageRoot: config.storagePath
  });

  const jobs = new JobStore(storage, cleaner, media, asr, pptGenerator);
  await jobs.init();

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
  if (existsSync(publicDir)) {
    app.get("/", (_req, res) => {
      res.sendFile(path.join(publicDir, "index.html"));
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

  app.post("/api/jobs/:id/steps/download", async (req, res) => {
    const result = await runStepRoute(req.params.id, "download");
    res.status(result.status).json(result.body);
  });

  app.post("/api/jobs/:id/steps/extract-audio", async (req, res) => {
    const result = await runStepRoute(req.params.id, "extract_audio");
    res.status(result.status).json(result.body);
  });

  app.post("/api/jobs/:id/steps/transcribe", async (req, res) => {
    const result = await runStepRoute(req.params.id, "transcribe");
    res.status(result.status).json(result.body);
  });

  app.post("/api/jobs/:id/steps/clean", async (req, res) => {
    const result = await runStepRoute(req.params.id, "clean");
    res.status(result.status).json(result.body);
  });

  app.post("/api/jobs/:id/steps/generate-ppt", async (req, res) => {
    const result = await runStepRoute(req.params.id, "generate_ppt");
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
      res.json({ script });
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
      res.json({ cleaned });
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
      res.json({ rawTranscript });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "raw transcript not found" });
        return;
      }
      throw error;
    }
  });

  // 🎯 视频提示词接口
  app.get("/api/jobs/:id/video-prompts", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const script = await storage.readJson<ScriptAsset>(path.join("processed", "scripts", `${record.id}.json`));
      if (!script.videoPrompts) {
        res.status(404).json({ message: "video prompts not generated yet" });
        return;
      }
      res.json({ videoPrompts: script.videoPrompts, enhancedScenes: script.enhancedScenes });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "script not found" });
        return;
      }
      throw error;
    }
  });

  // 🎯 PPT 内容接口
  app.get("/api/jobs/:id/ppt-content", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const script = await storage.readJson<ScriptAsset>(path.join("processed", "scripts", `${record.id}.json`));
      if (!script.pptContent) {
        res.status(404).json({ message: "PPT not generated yet" });
        return;
      }
      res.json({
        pptContent: script.pptContent,
        pptStyle: script.pptStyle,
        pptPath: script.pptPath
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "script not found" });
        return;
      }
      throw error;
    }
  });

  // 🎯 下载 PPT 文件
  app.get("/api/jobs/:id/ppt/download", async (req, res) => {
    const record = await jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ message: "job not found" });
      return;
    }

    try {
      const script = await storage.readJson<ScriptAsset>(path.join("processed", "scripts", `${record.id}.json`));
      if (!script.pptPath) {
        res.status(404).json({ message: "PPT file not generated yet" });
        return;
      }

      const pptFullPath = resolveOutputPath(config.storagePath, script.pptPath);
      if (!existsSync(pptFullPath)) {
        res.status(404).json({ message: "PPT file not found on disk" });
        return;
      }

      res.download(pptFullPath, `${record.topic}-${record.id.slice(0, 8)}.pptx`);
    } catch (error) {
      if (isMissingFileError(error)) {
        res.status(404).json({ message: "script not found" });
        return;
      }
      throw error;
    }
  });

  return app;
}

function resolveOutputPath(storagePath: string, outputPath: string) {
  if (path.isAbsolute(outputPath)) {
    return outputPath;
  }
  return path.join(storagePath, outputPath.replace(/^storage\//, ""));
}
