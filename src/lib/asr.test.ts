import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  assert.equal(result?.duration, undefined);

  assert.equal(calls[0].command, cliPath);
  assert.deepEqual(calls[0].args.slice(0, 6), ["-m", modelPath, "-f", audioPath, "-l", "zh"]);
  assert.ok(calls[0].args.includes("-ojf"));
  assert.ok(calls[0].args.includes("-np"));
  assert.equal(calls[0].args[calls[0].args.indexOf("-mc") + 1], "0");
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

test("AsrService accepts auto language and retains detected source language", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asr-auto-"));
  try {
    const audio = path.join(root, "audio.wav");
    const cli = path.join(root, "whisper-cli");
    const model = path.join(root, "model.bin");
    await Promise.all([audio, cli, model].map((file) => writeFile(file, "fixture")));
    const service = new AsrService({ whisperCliPath: cli, whisperModelPath: model, commandRunner: {
      async run(_command, args) {
        assert.equal(args[args.indexOf("-l") + 1], "auto");
        await writeFile(`${args[args.indexOf("-of") + 1]}.json`, JSON.stringify({ result: { language: "en" }, segments: [{ start: 0, end: 2, text: "Original text" }] }));
        return { stdout: "", stderr: "" };
      }
    } });
    const result = await (service.transcribe as any)(audio, "auto");
    assert.equal(result.language, "en");
    assert.equal(result.text, "Original text");
  } finally { await rm(root, { recursive: true, force: true }); }
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

async function transcribePayload(payload: unknown, audio: string | Buffer = "fixture") {
  const root = await mkdtemp(path.join(tmpdir(), "asr-payload-"));
  try {
    const cliPath = path.join(root, "whisper-cli");
    const modelPath = path.join(root, "model.bin");
    const audioPath = path.join(root, "audio.wav");
    await Promise.all([cliPath, modelPath].map((file) => writeFile(file, "fixture")));
    await writeFile(audioPath, audio);
    return await new AsrService({ whisperCliPath: cliPath, whisperModelPath: modelPath,
      commandRunner: { async run(_command, args) {
        await writeFile(`${args[args.indexOf("-of") + 1]}.json`, JSON.stringify(payload));
        return { stdout: "", stderr: "" };
      } }
    }).transcribe(audioPath);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("ASR converts every millisecond offset including subsecond values", async () => {
  const result = await transcribePayload({ transcription: [
    { offsets: { from: 0, to: 600 }, text: "第一句" },
    { offsets: { from: 800, to: 3700 }, text: "第二句" }
  ] });
  assert.deepEqual(result?.segments, [
    { start: 0, end: 0.6, text: "第一句" }, { start: 0.8, end: 3.7, text: "第二句" }
  ]);
});

test("ASR keeps second fields above 1000 seconds and parses clock strings independently", async () => {
  const result = await transcribePayload({ duration: 4000, segments: [
    { start: 1000, end: 1002, text: "长音频" },
    { timestamps: { from: "00:20:00,800", to: "00:20:03.700" }, text: "时间字符串" }
  ] });
  assert.equal(result?.segments[0].start, 1000);
  assert.equal(result?.segments[1].start, 1200.8);
});

for (const [label, segments, duration] of [
  ["blank", [{ start: "", end: 2, text: "空时间" }], 5],
  ["null", [{ start: null, end: 2, text: "缺失时间" }], 5],
  ["missing", [{ text: "缺失时间" }], 5],
  ["reversed", [{ start: 4, end: 1, text: "倒序" }], 5],
  ["outside", [{ start: 0, end: 600, text: "越界" }], 5],
  ["invalid clock", [{ start: "00:70:00.000", end: "00:70:01.000", text: "非法时间" }], 5000],
  ["loop", Array.from({ length: 63 }, (_, i) => ({ start: 118.4 + i, end: 119.4 + i, text: "这次的战机是什么呢？" })), 203]
] as const) {
  test(`ASR rejects ${label} recognition without recording success`, async () => {
    await assert.rejects(transcribePayload({ segments, duration }), /转录.*异常/);
  });
}

test("ASR does not pretend last recognition end is the actual audio duration", async () => {
  const result = await transcribePayload({ segments: [{ start: 0, end: 2, text: "尾部还有静音" }] });
  assert.equal(result?.duration, undefined);
});


test("ASR uses actual WAV duration including the silence after the last segment", async () => {
  const audio = Buffer.alloc(44 + 64000);
  audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(64000, 40);
  const result = await transcribePayload({ duration: 600, segments: [{ start: 0, end: 0.8, text: "说完以后保持静音" }] }, audio);
  assert.equal(result?.duration, 2);
  await assert.rejects(transcribePayload({ duration: 600, segments: [{ start: 0, end: 60, text: "错误越界" }] }, audio), /超出音频时长/);
});
