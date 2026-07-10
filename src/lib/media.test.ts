import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaService } from "./media.js";
import { LocalStorage } from "./storage.js";

test("MediaService extracts Whisper-ready wav audio and records manifest", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "media-wav-"));
  const storage = new LocalStorage(storageRoot);
  await storage.ensureBaseDirs();
  const videoPath = path.join(storageRoot, "raw", "videos", "job-wav.mp4");
  await writeFile(videoPath, "video");

  const calls: Array<{ command: string; args: string[] }> = [];
  const media = new MediaService(storage, {
    ffmpegBinary: "fake-ffmpeg",
    ffprobeBinary: "fake-ffprobe",
    commandRunner: {
      async run(command: string, args: string[]) {
        calls.push({ command, args });
        if (command === "fake-ffprobe") {
          return {
            stdout: JSON.stringify({
              format: { duration: "12.5" },
              streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 1, sample_rate: "16000" }]
            }),
            stderr: ""
          };
        }
        await writeFile(args[args.length - 1], "wav");
        return { stdout: "", stderr: "" };
      }
    }
  } as any);

  const result = await media.extractAudio(videoPath, "job-wav");

  assert.equal(result.audioPath, path.join(storageRoot, "raw", "audio", "job-wav.wav"));
  assert.equal(result.duration, 12.5);

  const ffmpegCall = calls.find((call) => call.command === "fake-ffmpeg");
  assert.ok(ffmpegCall);
  assert.deepEqual(ffmpegCall.args, [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    result.audioPath
  ]);

  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
    status: string;
    audioPath: string;
    args: string[];
  };
  assert.equal(manifest.status, "ready");
  assert.equal(manifest.audioPath, result.audioPath);
  assert.deepEqual(manifest.args, ffmpegCall.args);
});
