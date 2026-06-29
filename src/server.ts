import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { AsrService } from "./lib/asr.js";
import { OpenAiScriptCleaner } from "./lib/ai-cleaner.js";
import { MediaService } from "./lib/media.js";
import { LocalStorage } from "./lib/storage.js";
import { JobStore } from "./lib/jobs.js";
import type { ScriptAsset } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const storage = new LocalStorage(path.join(rootDir, "storage"));
const aiProvider = process.env.AI_PROVIDER ?? "deepseek";
const aiModel = process.env.AI_MODEL ?? "deepseek-v4-pro";
const aiApiKey =
  aiProvider === "deepseek"
    ? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY
    : process.env.OPENAI_API_KEY;
const aiBaseURL =
  aiProvider === "deepseek" ? "https://api.deepseek.com" : undefined;
const cleaner = new OpenAiScriptCleaner({
  apiKey: aiApiKey,
  model: aiModel,
  baseURL: aiBaseURL,
  provider: aiProvider === "deepseek" ? "deepseek" : "openai"
});
const media = new MediaService(storage, {
  ytDlpBinary: process.env.YTDLP_BINARY,
  ffmpegBinary: process.env.FFMPEG_BINARY,
  cookiesFile: process.env.YTDLP_COOKIES_FILE,
  cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER
});
const asr = new AsrService({
  apiKey: process.env.ASR_API_KEY ?? process.env.OPENAI_API_KEY,
  baseURL: process.env.ASR_BASE_URL,
  model: process.env.ASR_MODEL,
  provider: process.env.ASR_PROVIDER,
  pythonBinary: process.env.ASR_PYTHON_BINARY,
  whisperModelSize: process.env.WHISPER_MODEL_SIZE,
  whisperDevice: process.env.WHISPER_DEVICE,
  whisperComputeType: process.env.WHISPER_COMPUTE_TYPE
});
const jobs = new JobStore(storage, cleaner, media, asr);

await jobs.init();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "public", "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "douyin-ai-video" });
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

// 🎯 新增：视频提示词接口
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

// 🎯 新增：PPT 内容接口
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

// 🎯 新增：下载 PPT 文件
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

    const pptFullPath = path.join(rootDir, "storage", script.pptPath.replace(/^storage\//, ""));
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

const port = Number(process.env.PORT ?? 3100);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
