import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HyperframesVideoGenerator } from "./hyperframes-video.js";
import type { HyperframesCommandRunner } from "./hyperframes-video.js";
import type { ScriptAsset } from "../types.js";

function sampleScript(): ScriptAsset {
  return {
    sourceUrl: "https://example.com/video",
    topic: "AI 内容生产",
    rawText: "原始文案",
    cleanScript: "AI 内容生产要先明确目标，再拆解步骤，最后验证结果。",
    voiceoverScript: "先明确目标，再拆解步骤，最后验证结果。",
    coverTitle: "AI 内容生产",
    tags: ["AI"],
    summary: "用清晰流程提升 AI 内容生产质量。",
    keyPoints: ["明确目标", "拆解步骤", "验证结果"],
    videoOutline: [
      { title: "为什么要流程化", bullets: ["减少返工", "降低不确定性"], visualPrompt: "流程对比信息图" },
      { title: "三步方法", bullets: ["目标", "步骤", "验证"], visualPrompt: "三段式流程卡" }
    ],
    sceneList: [
      {
        scene: 1,
        duration: 5,
        caption: "AI 内容生产要先明确目标。",
        visual: "竖屏标题卡和关键词高亮"
      }
    ],
    status: "ready",
    videoPrompts: [
      "9:16 竖屏中文图文解释视频，开场标题卡，关键词高亮，无真人。",
      "三步流程卡片依次入场，字幕节奏清晰。"
    ],
    enhancedScenes: [
      {
        scene: 1,
        originalVisual: "开场标题卡",
        videoPrompt: "9:16 竖屏中文图文解释视频，开场标题卡，关键词高亮，无真人。",
        cameraMovement: "slow push-in",
        motionEffect: "kinetic subtitles",
        lightingStyle: "clean dark canvas"
      }
    ],
    videoEnhancedAt: "2026-07-10T00:00:00.000Z"
  };
}

test("HyperframesVideoGenerator reports a clear dependency error when doctor cannot run", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-missing-"));
  const runner: HyperframesCommandRunner = {
    async run() {
      throw new Error("spawn npx ENOENT");
    }
  };

  const generator = new HyperframesVideoGenerator({ storageRoot, commandRunner: runner });

  await assert.rejects(
    () => generator.generate(sampleScript(), "job-missing"),
    /HyperFrames.*Node 22\+.*FFmpeg.*npx hyperframes/s
  );
});

test("HyperframesVideoGenerator builds a vertical explainer project and renders mp4", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-ok-"));
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runner: HyperframesCommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, cwd: options?.cwd });
      if (args.includes("doctor")) {
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("render")) {
        const outputIndex = args.indexOf("--output");
        const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "renders/video.mp4";
        const fullPath = path.resolve(options?.cwd ?? storageRoot, outputPath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, Buffer.alloc(2048));
      }
      return { stdout: "", stderr: "" };
    }
  };

  const generator = new HyperframesVideoGenerator({ storageRoot, commandRunner: runner });
  const result = await generator.generate(sampleScript(), "job-ok");

  assert.equal(result.provider, "hyperframes");
  assert.equal(result.aspectRatio, "9:16");
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.match(result.videoPath, /renders[\/\\]video\.mp4$/);

  const indexHtml = await readFile(path.join(result.projectPath, "index.html"), "utf8");
  assert.match(indexHtml, /data-width="1080"/);
  assert.match(indexHtml, /data-height="1920"/);
  assert.match(indexHtml, /window\.__timelines\["main"\]/);

  const sourceJson = JSON.parse(await readFile(path.join(result.projectPath, "video-source.json"), "utf8")) as {
    scenes: unknown[];
  };
  assert.ok(sourceJson.scenes.length >= 6);
  assert.ok(sourceJson.scenes.length <= 10);

  const invoked = calls.map((call) => call.args.join(" "));
  assert.ok(invoked.some((args) => args.includes("hyperframes doctor --json")));
  assert.ok(invoked.some((args) => args.includes("hyperframes init")));
  assert.ok(invoked.some((args) => args.includes("hyperframes lint")));
  assert.ok(invoked.some((args) => args.includes("hyperframes validate")));
  assert.ok(invoked.some((args) => args.includes("hyperframes inspect")));
  assert.ok(invoked.some((args) => args.includes("hyperframes render")));
});

test("HyperframesVideoGenerator allows optional TTS and BGM doctor failures", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-optional-"));
  const runner: HyperframesCommandRunner = {
    async run(_command, args, options) {
      if (args.includes("doctor")) {
        return {
          stdout: JSON.stringify({
            ok: false,
            checks: [
              { name: "Node.js", ok: true, detail: "v24.14.0" },
              { name: "FFmpeg", ok: true, detail: "ffmpeg 8.0.1" },
              { name: "Chrome", ok: true, detail: "installed" },
              { name: "whisper-cpp", ok: false, detail: "Not installed (unused by video render)" },
              { name: "TTS (Kokoro)", ok: false, detail: "Not installed (optional)" },
              { name: "BGM (MusicGen)", ok: false, detail: "Not installed (optional)" },
              { name: "Docker running", ok: false, detail: "Not running" }
            ]
          }),
          stderr: ""
        };
      }
      if (args.includes("render")) {
        const fullPath = path.resolve(options?.cwd ?? storageRoot, "renders/video.mp4");
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, Buffer.alloc(2048));
      }
      return { stdout: "", stderr: "" };
    }
  };

  const generator = new HyperframesVideoGenerator({ storageRoot, commandRunner: runner });

  const result = await generator.generate(sampleScript(), "job-optional");
  assert.equal(result.provider, "hyperframes");
});
