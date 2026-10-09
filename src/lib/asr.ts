import { access, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectTranscriptQuality } from "./transcript-quality.js";
import { CommandError, runCommand } from "./command.js";
import type { TranscriptSegment, TranscriptWord } from "../types.js";

export interface AsrServiceConfig {
  rootDir?: string;
  whisperCliPath?: string;
  whisperModelPath?: string;
  commandRunner?: AsrCommandRunner;
}

export interface AsrCommandRunner {
  run(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      captureStdout?: boolean;
      captureStderr?: boolean;
    }
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface TranscriptResult {
  text: string;
  model: string;
  provider: string;
  segments: TranscriptSegment[];
  words?: TranscriptWord[];
  duration?: number;
  language?: string;
  raw?: unknown;
}

const PROVIDER = "whisper.cpp";
const MODEL = "ggml-small";

export class AsrService {
  private readonly whisperCliPath: string;
  private readonly whisperModelPath: string;
  private readonly runner: AsrCommandRunner;

  constructor(config: AsrServiceConfig = {}) {
    const whisperRoot = getWhisperRoot(config.rootDir);
    this.whisperCliPath =
      firstNonBlank(config.whisperCliPath, process.env.WHISPER_CLI_BINARY) ??
      path.join(whisperRoot, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
    this.whisperModelPath =
      firstNonBlank(config.whisperModelPath, process.env.WHISPER_MODEL_PATH) ??
      path.join(whisperRoot, "models", `${MODEL}.bin`);
    this.runner = config.commandRunner ?? {
      run: runCommand
    };
  }

  async transcribe(audioPath: string): Promise<TranscriptResult | null> {
    await this.assertResources(audioPath);

    const workDir = await mkdtemp(path.join(tmpdir(), "douyin-whisper-"));
    const outputPrefix = path.join(workDir, "transcript");
    try {
      await this.runner
        .run(
          this.whisperCliPath,
          [
            "-m",
            this.whisperModelPath,
            "-f",
            audioPath,
            "-l",
            "zh",
            "-ojf",
            "-of",
            outputPrefix,
            "-np",
            "-mc",
            "0"
          ],
          {
            captureStdout: true,
            captureStderr: true
          }
        )
        .catch((error) => {
          throw decorateWhisperError(error);
        });

      const payload = await readWhisperJson(outputPrefix);
      const segments = extractSegments(payload);
      const text = extractText(payload, segments);
      if (!text) {
        return null;
      }

      const duration = await readWavDuration(audioPath) ?? extractDuration(payload);
      const qualityIssues = inspectTranscriptQuality({ segments, text, duration });
      if (qualityIssues.length || !segments.length) {
        throw new Error(`whisper.cpp 转录异常：${qualityIssues.join("；") || "缺少带时间的分段"}`);
      }
      return {
        text,
        model: MODEL,
        provider: PROVIDER,
        segments: segments.length ? segments : [{ text }],
        words: extractWords(payload),
        duration,
        language: extractLanguage(payload) ?? "zh",
        raw: payload
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async assertResources(audioPath: string) {
    const missing: string[] = [];
    await access(this.whisperCliPath).catch(() => missing.push(`whisper-cli: ${this.whisperCliPath}`));
    await access(this.whisperModelPath).catch(() => missing.push(`ggml-small: ${this.whisperModelPath}`));
    await access(audioPath).catch(() => missing.push(`audio: ${audioPath}`));

    if (missing.length) {
      throw new Error(
        [
          "内置 Whisper 资源缺失或损坏，无法执行本地转录。",
          ...missing,
          "请重新运行 npm run prepare:whisper 后重新打包，或重新安装完整应用。"
        ].join("\n")
      );
    }
  }
}

async function readWhisperJson(outputPrefix: string) {
  const jsonPath = `${outputPrefix}.json`;
  try {
    return JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
  } catch (error) {
    if (!isMissingFileError(error)) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      throw new Error(`whisper.cpp 转录失败：JSON 输出格式无效。\n${message}`);
    }
  }

  try {
    return JSON.parse(await readFile(outputPrefix, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing whisper.cpp JSON output";
    throw new Error(`whisper.cpp 转录失败：未生成 JSON 输出。\n${message}`);
  }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function extractText(payload: unknown, segments: TranscriptSegment[]) {
  const direct = firstNonBlank((payload as { text?: unknown })?.text);
  if (direct) {
    return direct;
  }
  return segments.map((segment) => segment.text).filter(Boolean).join("\n").trim();
}

function extractSegments(payload: unknown): TranscriptSegment[] {
  const source = getSegmentSource(payload);
  return source
    .map((segment): TranscriptSegment | null => {
      const row = segment as {
        start?: unknown;
        end?: unknown;
        text?: unknown;
        offsets?: { from?: unknown; to?: unknown };
        timestamps?: { from?: unknown; to?: unknown };
      };
      const text = firstNonBlank(row.text);
      if (!text) {
        return null;
      }
      return {
        start: row.start !== undefined ? toSeconds(row.start) : row.offsets ? milliseconds(row.offsets.from) : toSeconds(row.timestamps?.from),
        end: row.end !== undefined ? toSeconds(row.end) : row.offsets ? milliseconds(row.offsets.to) : toSeconds(row.timestamps?.to),
        text
      };
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
}

function getSegmentSource(payload: unknown): unknown[] {
  const value = payload as { segments?: unknown; transcription?: unknown };
  if (Array.isArray(value.segments)) {
    return value.segments;
  }
  if (Array.isArray(value.transcription)) {
    return value.transcription;
  }
  return [];
}

function extractWords(payload: unknown): TranscriptWord[] | undefined {
  const words = (payload as { words?: unknown })?.words;
  if (!Array.isArray(words)) {
    return undefined;
  }

  const result = words
    .map((word): TranscriptWord | null => {
      const row = word as { start?: unknown; end?: unknown; word?: unknown; text?: unknown; probability?: unknown };
      const text = firstNonBlank(row.word, row.text);
      if (!text) {
        return null;
      }
      return {
        start: toSeconds(row.start),
        end: toSeconds(row.end),
        word: text,
        probability: toFiniteNumber(row.probability)
      };
    })
    .filter((word): word is TranscriptWord => Boolean(word));

  return result.length ? result : undefined;
}

function extractDuration(payload: unknown) {
  const duration = toFiniteNumber((payload as { duration?: unknown })?.duration);
  return duration !== undefined && duration > 0 ? duration : undefined;
}

async function readWavDuration(audioPath: string): Promise<number | undefined> {
  const handle = await open(audioPath, "r");
  try {
    const header = Buffer.alloc(12);
    if ((await handle.read(header, 0, 12, 0)).bytesRead < 12 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8) !== "WAVE") return undefined;
    const size = (await handle.stat()).size;
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= size) {
      const chunk = Buffer.alloc(8);
      await handle.read(chunk, 0, 8, offset);
      const length = chunk.readUInt32LE(4);
      if (offset + 8 + length > size) return undefined;
      if (chunk.toString("ascii", 0, 4) === "fmt " && length >= 16) {
        const format = Buffer.alloc(16);
        await handle.read(format, 0, 16, offset + 8);
        byteRate = format.readUInt32LE(8);
      }
      if (chunk.toString("ascii", 0, 4) === "data" && byteRate > 0) return length / byteRate;
      offset += 8 + length + (length % 2);
    }
    return undefined;
  } finally { await handle.close(); }
}

function extractLanguage(payload: unknown) {
  const direct = firstNonBlank((payload as { language?: unknown })?.language);
  if (direct) {
    return direct;
  }
  const result = (payload as { result?: { language?: unknown }; params?: { language?: unknown } });
  return firstNonBlank(result.result?.language, result.params?.language);
}

function toSeconds(value: unknown) {
  if (typeof value === "string" && value.includes(":")) {
    const match = /^(\d+):([0-5]\d):([0-5]\d)(?:[,.](\d{1,3}))?$/.exec(value.trim());
    if (!match) return undefined;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] ?? "0"}`);
  }
  return toFiniteNumber(value);
}

function milliseconds(value: unknown) {
  const number = toFiniteNumber(value);
  return number === undefined ? undefined : number / 1000;
}

function toFiniteNumber(value: unknown) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function decorateWhisperError(error: unknown) {
  if (error instanceof CommandError) {
    const detail = firstNonBlank(error.stderr, error.stdout, error.message) ?? "whisper.cpp command failed";
    return new Error(`whisper.cpp 转录失败：${detail}`);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(`whisper.cpp 转录失败：${message}`);
}

function getWhisperRoot(rootDir?: string) {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return firstNonBlank(
    process.env.WHISPER_DIR,
    resourcesPath ? path.join(resourcesPath, "whisper") : undefined,
    rootDir ? path.join(rootDir, "vendor", "whisper") : undefined,
    path.join(process.cwd(), "vendor", "whisper")
  )!;
}

function firstNonBlank(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
