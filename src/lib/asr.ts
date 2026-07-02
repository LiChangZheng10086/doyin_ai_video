import OpenAI from "openai";
import { createReadStream } from "node:fs";
import { CommandError, runCommand } from "./command.js";
import type { TranscriptSegment, TranscriptWord } from "../types.js";

export interface AsrServiceConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  provider?: string;
  pythonBinary?: string;
  whisperModelSize?: string;
  whisperDevice?: string;
  whisperComputeType?: string;
}

type AsrProvider = "openai" | "local-whisper" | "funasr";

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

export class AsrService {
  private readonly client?: OpenAI;
  private readonly openAiModel: string;
  private readonly provider: AsrProvider;
  private readonly pythonBinary: string;
  private readonly whisperModelSize: string;
  private readonly whisperDevice: string;
  private readonly whisperComputeType: string;
  private readonly funasrModel: string;
  private readonly funasrVadModel: string;
  private readonly funasrPuncModel: string;

  constructor(config: AsrServiceConfig = {}) {
    this.provider = normalizeProvider(config.provider, Boolean(config.apiKey));
    this.openAiModel = firstNonBlank(config.model, process.env.ASR_MODEL) ?? "whisper-1";
    this.pythonBinary =
      config.pythonBinary ?? process.env.ASR_PYTHON_BINARY ?? process.env.WHISPER_PYTHON ?? "python3";
    this.whisperModelSize =
      firstNonBlank(config.whisperModelSize, process.env.WHISPER_MODEL_SIZE, process.env.ASR_MODEL) ?? "medium";
    this.whisperDevice = config.whisperDevice ?? process.env.WHISPER_DEVICE ?? "cpu";
    this.whisperComputeType = config.whisperComputeType ?? process.env.WHISPER_COMPUTE_TYPE ?? "int8";
    const funasrModel = firstNonBlank(config.model, process.env.FUNASR_MODEL, process.env.ASR_MODEL);
    this.funasrModel = !funasrModel || funasrModel === "whisper-1" ? "paraformer-zh" : funasrModel;
    this.funasrVadModel = firstNonBlank(process.env.FUNASR_VAD_MODEL) ?? "fsmn-vad";
    this.funasrPuncModel = firstNonBlank(process.env.FUNASR_PUNC_MODEL) ?? "ct-punc";
    if (config.apiKey) {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL
      });
    }
  }

  async transcribe(audioPath: string): Promise<TranscriptResult | null> {
    if (this.provider === "local-whisper") {
      return this.transcribeWithLocalWhisper(audioPath);
    }

    if (this.provider === "funasr") {
      return this.transcribeWithFunAsr(audioPath);
    }

    if (!this.client) {
      return null;
    }

    const response = await this.transcribeWithOpenAI(audioPath);

    const text = this.extractText(response);
    if (!text) {
      return null;
    }

    return {
      text,
      model: this.openAiModel,
      provider: this.provider,
      segments: this.extractSegments(response, text),
      words: this.extractWords(response),
      duration: this.extractDuration(response),
      language: this.extractLanguage(response),
      raw: response
    };
  }

  private async transcribeWithOpenAI(audioPath: string) {
    try {
      return await this.client!.audio.transcriptions.create({
        file: createReadStream(audioPath),
        model: this.openAiModel,
        language: "zh",
        response_format: "verbose_json",
        timestamp_granularities: ["segment"]
      } as any);
    } catch (error) {
      if (!isLikelyVerboseJsonCompatibilityError(error)) {
        throw error;
      }

      return this.client!.audio.transcriptions.create({
        file: createReadStream(audioPath),
        model: this.openAiModel,
        language: "zh"
      } as any);
    }
  }

  private async transcribeWithLocalWhisper(audioPath: string): Promise<TranscriptResult | null> {
    const { stdout } = await runCommand(
      this.pythonBinary,
      [
        "-c",
        LOCAL_WHISPER_SCRIPT,
        audioPath,
        this.whisperModelSize,
        this.whisperDevice,
        this.whisperComputeType
      ],
      {
        captureStdout: true,
        captureStderr: true
      }
    ).catch((error) => {
      throw this.decorateLocalWhisperError(error);
    });

    const payload = parseJson(stdout);
    const text = this.extractText(payload);
    if (!text) {
      return null;
    }

    return {
      text,
      model: this.whisperModelSize,
      provider: this.provider,
      segments: this.extractSegments(payload, text),
      words: this.extractWords(payload),
      duration: this.extractDuration(payload),
      language: this.extractLanguage(payload),
      raw: payload
    };
  }

  private async transcribeWithFunAsr(audioPath: string): Promise<TranscriptResult | null> {
    const { stdout } = await runCommand(
      this.pythonBinary,
      [
        "-c",
        FUNASR_SCRIPT,
        audioPath,
        this.funasrModel,
        this.funasrVadModel,
        this.funasrPuncModel
      ],
      {
        captureStdout: true,
        captureStderr: true
      }
    ).catch((error) => {
      throw this.decorateFunAsrError(error);
    });

    const payload = parseJson(stdout);
    if (isFunAsrErrorPayload(payload)) {
      throw new Error(formatFunAsrMessage(payload.message));
    }

    const text = this.extractText(payload);
    if (!text) {
      return null;
    }

    return {
      text,
      model: this.funasrModel,
      provider: this.provider,
      segments: this.extractSegments(payload, text),
      words: this.extractWords(payload),
      duration: this.extractDuration(payload),
      language: this.extractLanguage(payload) ?? "zh",
      raw: payload
    };
  }

  private extractText(response: unknown) {
    if (typeof response === "string") {
      return response.trim();
    }

    const candidate = (response as { text?: unknown })?.text;
    if (typeof candidate === "string") {
      return candidate.trim();
    }

    return "";
  }

  private extractSegments(response: unknown, fallbackText: string): TranscriptSegment[] {
    const segments = (response as { segments?: unknown })?.segments;
    if (Array.isArray(segments)) {
      return segments
        .map((segment): TranscriptSegment | null => {
          const row = segment as { start?: unknown; end?: unknown; text?: unknown };
          const text = typeof row.text === "string" ? row.text.trim() : "";
          if (!text) {
            return null;
          }
          return {
            start: toFiniteNumber(row.start),
            end: toFiniteNumber(row.end),
            text
          };
        })
        .filter((segment): segment is TranscriptSegment => Boolean(segment));
    }

    return fallbackText ? [{ text: fallbackText }] : [];
  }

  private extractWords(response: unknown): TranscriptWord[] | undefined {
    const words = (response as { words?: unknown })?.words;
    if (!Array.isArray(words)) {
      return undefined;
    }

    const result = words
      .map((word): TranscriptWord | null => {
        const row = word as {
          start?: unknown;
          end?: unknown;
          word?: unknown;
          probability?: unknown;
        };
        const text = typeof row.word === "string" ? row.word.trim() : "";
        if (!text) {
          return null;
        }
        return {
          start: toFiniteNumber(row.start),
          end: toFiniteNumber(row.end),
          word: text,
          probability: toFiniteNumber(row.probability)
        };
      })
      .filter((word): word is TranscriptWord => Boolean(word));

    return result.length ? result : undefined;
  }

  private extractDuration(response: unknown) {
    return toFiniteNumber((response as { duration?: unknown })?.duration);
  }

  private extractLanguage(response: unknown) {
    const language = (response as { language?: unknown })?.language;
    return typeof language === "string" && language.trim() ? language.trim() : undefined;
  }

  private decorateLocalWhisperError(error: unknown) {
    if (!(error instanceof CommandError)) {
      return error instanceof Error ? error : new Error("local whisper transcription failed");
    }

    const stderr = error.stderr.trim();
    const missingModule = /No module named ['"]faster_whisper['"]/.test(stderr);
    const hint = missingModule
      ? "Install faster-whisper in that Python environment, or set ASR_PYTHON_BINARY to the douyin_ppt venv python."
      : "";
    const message = [stderr || error.message, hint].filter(Boolean).join("\n").trim();
    return new Error(message || "local whisper transcription failed");
  }

  private decorateFunAsrError(error: unknown) {
    if (!(error instanceof CommandError)) {
      return error instanceof Error ? error : new Error("FunASR transcription failed");
    }

    const stdout = error.stdout.trim();
    const payload = parseJson(stdout);
    if (isFunAsrErrorPayload(payload)) {
      return new Error(formatFunAsrMessage(payload.message));
    }

    const stderr = error.stderr.trim();
    return new Error(formatFunAsrMessage(stderr || error.message || "FunASR transcription failed"));
  }
}

function normalizeProvider(provider: string | undefined, hasApiKey: boolean): AsrProvider {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-compatible") {
    return "openai";
  }

  if (normalized === "funasr" || normalized === "local-funasr") {
    return "funasr";
  }

  if (
    normalized === "local" ||
    normalized === "local-whisper" ||
    normalized === "whisper" ||
    normalized === "faster-whisper"
  ) {
    return "local-whisper";
  }

  return hasApiKey ? "openai" : "local-whisper";
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const jsonLine = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith("{") || line.startsWith("["));
    if (jsonLine) {
      try {
        return JSON.parse(jsonLine) as unknown;
      } catch {
        return text;
      }
    }
    return text;
  }
}

function firstNonBlank(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

const LOCAL_WHISPER_SCRIPT = String.raw`
import json
import sys
from faster_whisper import WhisperModel

audio_path = sys.argv[1]
model_size = sys.argv[2]
device = sys.argv[3]
compute_type = sys.argv[4]

model = WhisperModel(model_size, device=device, compute_type=compute_type)
segments, info = model.transcribe(
    audio_path,
    language="zh",
    beam_size=5,
    word_timestamps=True,
    vad_filter=True,
)

text_parts = []
segment_rows = []
word_rows = []
for segment in segments:
    text = segment.text.strip()
    if not text:
        continue
    text_parts.append(text)
    segment_rows.append({
        "start": segment.start,
        "end": segment.end,
        "text": text,
    })
    for word in getattr(segment, "words", []) or []:
        word_text = getattr(word, "word", "").strip()
        if not word_text:
            continue
        word_rows.append({
            "start": getattr(word, "start", None),
            "end": getattr(word, "end", None),
            "word": word_text,
            "probability": getattr(word, "probability", None),
        })

print(json.dumps({
    "text": "\n".join(text_parts),
    "language": getattr(info, "language", None),
    "duration": getattr(info, "duration", None),
    "segments": segment_rows,
    "words": word_rows,
}, ensure_ascii=False))
`;

const FUNASR_SCRIPT = String.raw`
import json
import os
import sys
import traceback

audio_path = sys.argv[1]
model_name = sys.argv[2]
vad_model = sys.argv[3]
punc_model = sys.argv[4]

def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, default=str))

def fail(message):
    emit({"code": "ERROR", "message": message})
    sys.exit(0)

if not os.path.exists(audio_path):
    fail(f"audio file does not exist: {audio_path}")

if os.path.getsize(audio_path) == 0:
    fail("audio file is empty")

try:
    from funasr import AutoModel
except ModuleNotFoundError as error:
    missing = getattr(error, "name", "") or "funasr"
    fail(f"missing Python module: {missing}")
except Exception as error:
    fail(f"failed to import FunASR: {error}")

try:
    model = AutoModel(
        model=model_name,
        vad_model=vad_model,
        punc_model=punc_model,
        disable_update=True,
    )
    result = model.generate(input=audio_path)
except ModuleNotFoundError as error:
    missing = getattr(error, "name", "") or str(error)
    fail(f"missing Python module: {missing}")
except Exception as error:
    fail(f"FunASR failed: {error}\n{traceback.format_exc(limit=2)}")

texts = []
segments = []
timestamps = []

items = result if isinstance(result, list) else [result]
for item in items:
    if isinstance(item, dict):
        text = str(item.get("text") or "").strip()
        if text:
            texts.append(text)
        timestamp = item.get("timestamp")
        if isinstance(timestamp, list):
            timestamps.extend(timestamp)
    elif isinstance(item, str):
        text = item.strip()
        if text:
            texts.append(text)

text = "\n".join(texts).strip()
if not text:
    fail("FunASR returned no transcript")

if timestamps:
    for timestamp in timestamps:
        if (
            isinstance(timestamp, (list, tuple))
            and len(timestamp) >= 3
            and isinstance(timestamp[2], str)
            and timestamp[2].strip()
        ):
            segments.append({
                "start": timestamp[0] / 1000 if isinstance(timestamp[0], (int, float)) else None,
                "end": timestamp[1] / 1000 if isinstance(timestamp[1], (int, float)) else None,
                "text": timestamp[2].strip(),
            })

if not segments:
    segments = [{"text": text}]

emit({
    "code": "SUCCESS",
    "text": text,
    "segments": segments,
    "language": "zh",
    "raw": result,
})
`;

function isFunAsrErrorPayload(value: unknown): value is { code: "ERROR"; message?: string } {
  const payload = value as { code?: unknown; message?: unknown };
  return payload?.code === "ERROR";
}

function formatFunAsrMessage(message?: string) {
  const body = message?.trim() || "FunASR transcription failed";
  const missingDependency = /No module named|missing Python module|failed to import FunASR|funasr|torch|torchaudio/i.test(body);
  const dependencyHint = missingDependency
    ? "请在 ASR 使用的 Python 环境中安装 Python 3.8+ 依赖：pip install torch torchaudio funasr"
    : "";
  const modelHint = /download|model|modelscope|network|connect|timeout/i.test(body)
    ? "FunASR 首次运行可能需要下载模型；请检查网络连接和磁盘空间后重试。"
    : "";
  return [body, dependencyHint, modelHint].filter(Boolean).join("\n").trim();
}

function toFiniteNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function isLikelyVerboseJsonCompatibilityError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /response_format|timestamp|granularit|verbose_json|unsupported|invalid/i.test(message);
}
