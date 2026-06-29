import OpenAI from "openai";
import { createReadStream } from "node:fs";
import { CommandError, runCommand } from "./command.js";

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

export interface TranscriptResult {
  text: string;
  model: string;
  provider: string;
  raw?: unknown;
}

export class AsrService {
  private readonly client?: OpenAI;
  private readonly openAiModel: string;
  private readonly provider: "openai" | "local-whisper";
  private readonly pythonBinary: string;
  private readonly whisperModelSize: string;
  private readonly whisperDevice: string;
  private readonly whisperComputeType: string;

  constructor(config: AsrServiceConfig = {}) {
    this.provider = normalizeProvider(config.provider, Boolean(config.apiKey));
    this.openAiModel = config.model ?? process.env.ASR_MODEL ?? "whisper-1";
    this.pythonBinary =
      config.pythonBinary ?? process.env.ASR_PYTHON_BINARY ?? process.env.WHISPER_PYTHON ?? "python3";
    this.whisperModelSize =
      config.whisperModelSize ?? process.env.WHISPER_MODEL_SIZE ?? process.env.ASR_MODEL ?? "medium";
    this.whisperDevice = config.whisperDevice ?? process.env.WHISPER_DEVICE ?? "cpu";
    this.whisperComputeType = config.whisperComputeType ?? process.env.WHISPER_COMPUTE_TYPE ?? "int8";
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

    if (!this.client) {
      return null;
    }

    const response = await this.client.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: this.openAiModel,
      language: "zh"
    } as any);

    const text = this.extractText(response);
    if (!text) {
      return null;
    }

    return {
      text,
      model: this.openAiModel,
      provider: this.provider,
      raw: response
    };
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
}

function normalizeProvider(provider: string | undefined, hasApiKey: boolean): "openai" | "local-whisper" {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-compatible") {
    return "openai";
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
    return text;
  }
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
segments, info = model.transcribe(audio_path, language="zh", beam_size=5)

text_parts = []
segment_rows = []
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

print(json.dumps({
    "text": "\n".join(text_parts),
    "language": getattr(info, "language", None),
    "duration": getattr(info, "duration", None),
    "segments": segment_rows,
}, ensure_ascii=False))
`;
