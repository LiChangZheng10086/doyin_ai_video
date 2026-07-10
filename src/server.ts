import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createExpressApp } from "./app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const aiProvider = process.env.AI_PROVIDER ?? "deepseek";
const aiApiKey =
  aiProvider === "deepseek"
    ? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY
    : process.env.OPENAI_API_KEY;

const app = await createExpressApp({
  storagePath: path.join(rootDir, "storage"),
  rootDir,
  aiProvider,
  aiModel: process.env.AI_MODEL ?? "deepseek-v4-pro",
  aiApiKey,
  aiBaseURL: aiProvider === "deepseek" ? "https://api.deepseek.com" : undefined,
  ytDlpBinary: process.env.YTDLP_BINARY,
  ffmpegBinary: process.env.FFMPEG_BINARY,
  ffprobeBinary: process.env.FFPROBE_BINARY,
  cookiesFile: process.env.YTDLP_COOKIES_FILE,
  cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER,
  whisperCliPath: process.env.WHISPER_CLI_BINARY,
  whisperModelPath: process.env.WHISPER_MODEL_PATH,
  hyperframesNpxBinary: process.env.HYPERFRAMES_NPX_BINARY
});

const port = Number(process.env.PORT ?? 3100);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
