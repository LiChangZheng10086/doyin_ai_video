import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CommandError } from "./command.js";
import { HyperframesVideoGenerator } from "./hyperframes-video.js";
import type { HyperframesCommandRunner } from "./hyperframes-video.js";
import type { ScriptAsset } from "../types.js";

function sampleScript(options: { withShots?: boolean } = { withShots: true }): ScriptAsset {
  const script: ScriptAsset = {
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
  if (options.withShots !== false) {
    script.shortVideoShots = [
      {
        index: 1,
        duration: 4,
        shotType: "hook",
        subject: "目标先行",
        action: "关键词从暗色背景中弹出，快速建立主题",
        cameraMotion: "slow push-in",
        visualLayers: [
          { type: "background", content: "深色动态网格", motion: "slow drift", style: "dark tech canvas" },
          { type: "subject", content: "目标卡片", motion: "scale in", style: "neon outline" },
          { type: "graphic", content: "目标到结果的连线", motion: "draw line", style: "compact infographic" },
          { type: "caption", content: "先明确目标", motion: "word reveal", style: "large subtitle" },
          { type: "emphasis", content: "目标", motion: "pop", style: "accent pill" }
        ],
        caption: "先明确目标，再开始生成内容。",
        emphasisWords: ["目标", "生成", "内容"],
        transition: "flash",
        pacing: "fast",
        narration: "AI 内容生产要先明确目标。"
      },
      {
        index: 2,
        duration: 5,
        shotType: "process",
        subject: "拆解步骤",
        action: "三张流程卡依次滑入，形成清晰路径",
        cameraMotion: "vertical slide",
        visualLayers: [
          { type: "background", content: "流程线背景", motion: "parallax", style: "blue grid" },
          { type: "subject", content: "三步方法卡", motion: "slide in", style: "glass cards" },
          { type: "graphic", content: "目标、步骤、验证节点", motion: "pop nodes", style: "infographic" }
        ],
        caption: "把大任务拆成可以执行的三步。",
        emphasisWords: ["拆解", "三步"],
        transition: "push",
        pacing: "medium",
        narration: "再拆解步骤，让每一步都可验证。"
      },
      {
        index: 3,
        duration: 5,
        shotType: "explain",
        subject: "减少返工",
        action: "错误路径淡出，正确路径高亮",
        cameraMotion: "soft zoom",
        visualLayers: [
          { type: "background", content: "对比面板背景", motion: "slow shift", style: "contrast canvas" },
          { type: "subject", content: "返工次数下降", motion: "count down", style: "metric card" },
          { type: "graphic", content: "红色叉号转为绿色勾选", motion: "morph", style: "status graphic" }
        ],
        caption: "流程化能明显减少返工。",
        emphasisWords: ["流程化", "返工"],
        transition: "wipe",
        pacing: "medium",
        narration: "流程化的核心价值，是减少返工和不确定性。"
      },
      {
        index: 4,
        duration: 5,
        shotType: "contrast",
        subject: "降低不确定性",
        action: "左右对比栏切换，突出稳定输出",
        cameraMotion: "panel reveal",
        visualLayers: [
          { type: "background", content: "双栏对比空间", motion: "subtle pan", style: "split screen" },
          { type: "subject", content: "混乱输入 vs 稳定输出", motion: "swap panels", style: "comparison cards" },
          { type: "graphic", content: "噪声点变成直线", motion: "align", style: "minimal chart" }
        ],
        caption: "把不确定输入变成稳定输出。",
        emphasisWords: ["稳定", "输出"],
        transition: "match-cut",
        pacing: "fast",
        narration: "当路径清楚，输出质量就更稳定。"
      },
      {
        index: 5,
        duration: 5,
        shotType: "proof",
        subject: "验证结果",
        action: "检查清单逐项点亮，最后形成通过状态",
        cameraMotion: "parallax drift",
        visualLayers: [
          { type: "background", content: "检查清单底纹", motion: "ambient", style: "clean dark canvas" },
          { type: "subject", content: "验证 checklist", motion: "check marks", style: "task list" },
          { type: "graphic", content: "质量阈值和通过标记", motion: "grow bars", style: "data card" }
        ],
        caption: "最后用验证结果判断是否达标。",
        emphasisWords: ["验证", "达标"],
        transition: "zoom",
        pacing: "medium",
        narration: "最后验证结果，确认内容是否真正达标。"
      },
      {
        index: 6,
        duration: 4,
        shotType: "summary",
        subject: "形成闭环",
        action: "目标、步骤、验证三个节点汇聚成闭环",
        cameraMotion: "soft zoom",
        visualLayers: [
          { type: "background", content: "环形路径背景", motion: "rotate slowly", style: "loop graphic" },
          { type: "subject", content: "内容生产闭环", motion: "merge", style: "summary card" },
          { type: "graphic", content: "三节点闭环", motion: "draw circle", style: "simple diagram" }
        ],
        caption: "目标、步骤、验证，形成内容生产闭环。",
        emphasisWords: ["目标", "步骤", "验证"],
        transition: "cut",
        pacing: "slow",
        narration: "目标、步骤、验证，构成一个完整闭环。"
      }
    ];
    const layouts = ["kinetic-title", "process-flow", "concept-map", "comparison", "metric", "summary-stack"] as const;
    script.planVersion = 2;
    script.targetDuration = 60;
    script.shortVideoScript = "先明确目标，再拆解步骤，对比混乱与稳定输出，最后验证结果并形成完整闭环。";
    script.shortVideoShots = script.shortVideoShots.map((shot, index) => ({
      ...shot,
      layout: layouts[index],
      headline: shot.subject,
      supportingText: shot.caption,
      captionLines: [shot.caption.slice(0, 16)],
      visualItems: [
        { label: shot.emphasisWords[0] ?? "重点", tone: "primary" },
        { label: shot.emphasisWords[1] ?? "结果", tone: "success" }
      ],
      sourceKeyPoints: [index % 3]
    }));
  }
  return script;
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
      assert.match(args[1], /^hyperframes@/);
      if (args.includes("init")) {
        const projectPath = args[args.indexOf("init") + 1];
        const existingFiles = await readdir(projectPath).catch(() => []);
        assert.deepEqual(existingFiles, []);
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
  for (const layout of ["kinetic-title", "concept-map", "process-flow", "comparison", "metric", "summary-stack"]) {
    assert.match(indexHtml, new RegExp(`data-layout="${layout}"`));
  }
  assert.match(indexHtml, /class="audience-caption"/);
  assert.match(indexHtml, /class="transition-mask" data-layout-allow-overflow/);
  assert.doesNotMatch(indexHtml, /cdn\.jsdelivr\.net/);
  assert.match(indexHtml, /assets\/gsap\.min\.js/);
  assert.doesNotMatch(indexHtml, /\.transition-mask\s*\{[^}]*transform\s*:/s);
  assert.match(indexHtml, /\.transition-mask\s*\{[^}]*opacity:\s*0/s);
  assert.doesNotMatch(indexHtml, /SHOT 1|slow push-in|panel reveal|SUBJECT|GRAPHIC|class="narration"/i);
  assert.doesNotMatch(indexHtml, /<ul class="bullets"/);
  assert.doesNotMatch(indexHtml, /class="kicker"/);

  const sourceJson = JSON.parse(await readFile(path.join(result.projectPath, "video-source.json"), "utf8")) as {
    source: { shortVideoShots?: unknown[] };
    scenes: Array<{ subject?: string; caption?: string; narration?: string; visualLayers?: unknown[] }>;
  };
  assert.equal(sourceJson.source.shortVideoShots?.length, 6);
  assert.ok(sourceJson.scenes.length >= 6);
  assert.ok(sourceJson.scenes.length <= 10);
  assert.equal(sourceJson.scenes[0]?.subject, "目标先行");
  assert.equal(sourceJson.scenes[0]?.caption, "先明确目标，再开始生成内容。");
  assert.ok(sourceJson.scenes.every((scene) => (scene.narration?.length ?? 0) <= 80));
  assert.ok((sourceJson.scenes[0]?.visualLayers?.length ?? 0) >= 4);

  const invoked = calls.map((call) => call.args.join(" "));
  assert.ok(invoked.some((args) => args.includes("hyperframes@0.7.48 doctor --json")));
  assert.ok(invoked.some((args) => args.includes("hyperframes@0.7.48 init")));
  assert.ok(invoked.some((args) => args.includes("hyperframes@0.7.48 lint")));
  assert.ok(invoked.some((args) => args.includes("hyperframes@0.7.48 validate")));
  assert.ok(invoked.some((args) => args.includes("hyperframes@0.7.48 inspect")));
  assert.ok(invoked.some((args) => args.includes("hyperframes@0.7.48 snapshot")));
  assert.ok(invoked.some((args) => args.includes("hyperframes@0.7.48 render")));
});

test("HyperframesVideoGenerator preserves the previous video when validation fails", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-preserve-"));
  const previousPath = path.join(storageRoot, "output", "videos", "job-preserve", "hyperframes", "renders", "video.mp4");
  await mkdir(path.dirname(previousPath), { recursive: true });
  await writeFile(previousPath, "previous-video");
  const runner: HyperframesCommandRunner = {
    async run(command, args) {
      if (args.includes("doctor")) return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      if (args.includes("inspect")) {
        throw new CommandError("inspect failed", command, args, "", "text_occluded", 1);
      }
      return { stdout: "", stderr: "" };
    }
  };

  const generator = new HyperframesVideoGenerator({ storageRoot, commandRunner: runner });
  await assert.rejects(() => generator.generate(sampleScript(), "job-preserve"), /text_occluded/);

  assert.equal(await readFile(previousPath, "utf8"), "previous-video");
});

test("HyperframesVideoGenerator verifies the encoded output with ffprobe", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-probe-"));
  let probed = false;
  const runner: HyperframesCommandRunner = {
    async run(command, args, options) {
      if (args.includes("doctor")) return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      if (args.includes("render")) {
        const fullPath = path.resolve(options?.cwd ?? storageRoot, "renders/video.mp4");
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, Buffer.alloc(2048));
      }
      if (command === "ffprobe-test") {
        probed = true;
        return {
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, r_frame_rate: "30/1" }],
            format: { duration: "52", size: "2048" }
          }),
          stderr: ""
        };
      }
      return { stdout: "", stderr: "" };
    }
  };

  const generator = new HyperframesVideoGenerator({ storageRoot, commandRunner: runner, ffprobeBinary: "ffprobe-test" });
  await generator.generate(sampleScript(), "job-probe");

  assert.equal(probed, true);
});

test("HyperframesVideoGenerator falls back to legacy prompt fields when shots are missing", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-legacy-"));
  const runner: HyperframesCommandRunner = {
    async run(_command, args, options) {
      if (args.includes("doctor")) {
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
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
  const legacyScript = sampleScript({ withShots: false });
  legacyScript.voiceoverScript = "推薦內容方法，這是觀眾字幕。";
  legacyScript.sceneList[0].caption = "推薦內容方法，這是觀眾字幕。";
  const result = await generator.generate(legacyScript, "job-legacy");
  const sourceJson = JSON.parse(await readFile(path.join(result.projectPath, "video-source.json"), "utf8")) as {
    source: { shortVideoShots?: unknown[] };
    scenes: Array<{ subject?: string; caption?: string; narration?: string; visualLayers?: unknown[] }>;
  };

  assert.equal(sourceJson.source.shortVideoShots, undefined);
  assert.ok(sourceJson.scenes.length >= 6);
  assert.ok(sourceJson.scenes.every((scene) => scene.subject && scene.caption));
  assert.ok(sourceJson.scenes.every((scene) => (scene.visualLayers?.length ?? 0) >= 3));
  const renderedText = sourceJson.scenes.map((scene) => [scene.caption, scene.narration].join(" ")).join(" ");
  assert.doesNotMatch(renderedText, /9:16|动态图形|图文解释视频|无真人/);
  assert.doesNotMatch(renderedText, /推薦|內容|這是|觀眾/);
  assert.match(renderedText, /推荐内容方法|这是观众字幕/);
  assert.match(renderedText, /推荐内容方法|明确目标/);
});

test("HyperframesVideoGenerator uses packaged CLI and runtime assets when configured", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-packaged-"));
  const cliPath = path.join(storageRoot, "resources", "hyperframes", "node_modules", "hyperframes", "dist", "cli.js");
  const nodeBinary = path.join(storageRoot, "Douyin AI Video");
  const runtimeBinDir = path.join(storageRoot, "resources", "bin");
  const browserPath = path.join(storageRoot, "resources", "browser", "chrome-headless-shell");
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
  const runner: HyperframesCommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, env: options?.env, cwd: options?.cwd });
      if (args.includes("doctor")) {
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("render")) {
        const fullPath = path.resolve(options?.cwd ?? storageRoot, "renders/video.mp4");
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, Buffer.alloc(2048));
      }
      return { stdout: "", stderr: "" };
    }
  };

  const generator = new HyperframesVideoGenerator({
    storageRoot,
    commandRunner: runner,
    cliPath,
    nodeBinary,
    runtimeBinDir,
    browserPath,
    useElectronAsNode: true
  });
  const result = await generator.generate(sampleScript(), "job-packaged");

  assert.equal(result.provider, "hyperframes");
  assert.equal(calls[0]?.command, nodeBinary);
  assert.equal(calls[0]?.args[0], cliPath);
  assert.equal(calls[0]?.env?.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[0]?.env?.PRODUCER_HEADLESS_SHELL_PATH, browserPath);
  assert.ok(calls[0]?.env?.PATH?.startsWith(runtimeBinDir));
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

test("HyperframesVideoGenerator allows HyperFrames version upgrade doctor warning", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-version-"));
  const runner: HyperframesCommandRunner = {
    async run(_command, args, options) {
      if (args.includes("doctor")) {
        return {
          stdout: JSON.stringify({
            ok: false,
            checks: [
              {
                name: "Version",
                ok: false,
                detail: "0.7.48 → 0.7.52 available",
                hint: "Run: hyperframes upgrade"
              }
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

  const result = await generator.generate(sampleScript(), "job-version");
  assert.equal(result.provider, "hyperframes");
});

test("HyperframesVideoGenerator includes HyperFrames stderr when a command fails", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-stderr-"));
  const runner: HyperframesCommandRunner = {
    async run(command, args) {
      if (args.includes("doctor")) {
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      throw new CommandError(
        "Command failed with exit code 1",
        command,
        args,
        "",
        "Directory already exists and is not empty: demo",
        1
      );
    }
  };

  const generator = new HyperframesVideoGenerator({ storageRoot, commandRunner: runner });

  await assert.rejects(
    () => generator.generate(sampleScript(), "job-stderr"),
    /HyperFrames 命令失败.*hyperframes@0\.7\.48 init.*Directory already exists/s
  );
});
