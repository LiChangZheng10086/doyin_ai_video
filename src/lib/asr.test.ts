import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CommandError } from "./command.js";
import { AsrService } from "./asr.js";

test("AsrService transcribes audio with bundled whisper.cpp output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asr-whisper-"));
  const cliPath = path.join(root, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  const modelPath = path.join(root, "models", "ggml-small.bin");
  const audioPath = path.join(root, "audio.wav");
  await mkdir(path.dirname(modelPath), { recursive: true });
  await writeFile(cliPath, "");
  await chmod(cliPath, 0o755);
  await writeFile(modelPath, "model");
  await writeFile(audioPath, "audio");

  const calls: Array<{ command: string; args: string[] }> = [];
  const service = new AsrService({
    whisperCliPath: cliPath,
    whisperModelPath: modelPath,
    commandRunner: {
      async run(command: string, args: string[]) {
        calls.push({ command, args });
        const outputPrefix = args[args.indexOf("-of") + 1];
        await writeFile(
          `${outputPrefix}.json`,
          JSON.stringify({
            result: { language: "zh" },
            transcription: [
              {
                offsets: { from: 0, to: 1800 },
                text: "第一段内容"
              },
              {
                offsets: { from: 1800, to: 4200 },
                text: "第二段内容"
              }
            ]
          })
        );
        return { stdout: "", stderr: "" };
      }
    }
  } as any);

  const result = await service.transcribe(audioPath);

  assert.equal(result?.provider, "whisper.cpp");
  assert.equal(result?.model, "ggml-small");
  assert.equal(result?.language, "zh");
  assert.equal(result?.text, "第一段内容\n第二段内容");
  assert.deepEqual(result?.segments, [
    { start: 0, end: 1.8, text: "第一段内容" },
    { start: 1.8, end: 4.2, text: "第二段内容" }
  ]);
  assert.equal(result?.duration, 4.2);

  assert.equal(calls[0].command, cliPath);
  assert.deepEqual(calls[0].args.slice(0, 6), ["-m", modelPath, "-f", audioPath, "-l", "zh"]);
  assert.ok(calls[0].args.includes("-ojf"));
  assert.ok(calls[0].args.includes("-np"));
});

test("AsrService reports a clear error when bundled Whisper resources are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asr-missing-"));
  const audioPath = path.join(root, "audio.wav");
  await writeFile(audioPath, "audio");

  const service = new AsrService({
    whisperCliPath: path.join(root, "missing-whisper-cli"),
    whisperModelPath: path.join(root, "models", "missing-ggml-small.bin"),
    commandRunner: {
      async run() {
        throw new Error("should not run without resources");
      }
    }
  } as any);

  await assert.rejects(
    () => service.transcribe(audioPath),
    /内置 Whisper 资源缺失或损坏.*whisper-cli.*ggml-small/s
  );
});

test("AsrService decorates whisper.cpp command failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asr-failed-"));
  const cliPath = path.join(root, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  const modelPath = path.join(root, "models", "ggml-small.bin");
  const audioPath = path.join(root, "audio.wav");
  await mkdir(path.dirname(modelPath), { recursive: true });
  await writeFile(cliPath, "");
  await chmod(cliPath, 0o755);
  await writeFile(modelPath, "model");
  await writeFile(audioPath, "audio");

  const service = new AsrService({
    whisperCliPath: cliPath,
    whisperModelPath: modelPath,
    commandRunner: {
      async run(command: string, args: string[]) {
        throw new CommandError("Command failed with exit code 1", command, args, "", "bad wav", 1);
      }
    }
  } as any);

  await assert.rejects(
    () => service.transcribe(audioPath),
    /whisper\.cpp 转录失败.*bad wav/s
  );
});
