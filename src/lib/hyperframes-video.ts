import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CommandError, runCommand } from "./command.js";
import type {
  EnhancedScene,
  ScriptAsset,
  ShortVideoShot,
  ShortVideoVisualLayer,
  ShotPacing,
  ShotTransition,
  ShotType
} from "../types.js";

export interface HyperframesCommandRunner {
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

export interface HyperframesVideoResult {
  provider: "hyperframes";
  projectPath: string;
  videoPath: string;
  manifestPath: string;
  createdAt: string;
  duration: number;
  aspectRatio: "9:16";
  width: 1080;
  height: 1920;
  scenes: HyperframesVideoScene[];
}

export interface HyperframesVideoGeneratorOptions {
  storageRoot: string;
  npxBinary?: string;
  packageSpec?: string;
  runtimeBinDir?: string;
  cliPath?: string;
  nodeBinary?: string;
  useElectronAsNode?: boolean;
  browserPath?: string;
  commandRunner?: HyperframesCommandRunner;
}

interface HyperframesVideoScene {
  index: number;
  shotType?: ShotType;
  subject: string;
  action: string;
  cameraMotion: string;
  visualLayers: ShortVideoVisualLayer[];
  caption: string;
  emphasisWords: string[];
  transition: ShotTransition;
  pacing: ShotPacing;
  narration: string;
  duration: number;
  accent: string;
}

const WIDTH = 1080;
const HEIGHT = 1920;
const MIN_SCENES = 6;
const MAX_SCENES = 10;
const ACCENTS = ["#2dd4bf", "#f59e0b", "#60a5fa", "#f472b6", "#a3e635", "#fb7185"];

const defaultRunner: HyperframesCommandRunner = {
  run: runCommand
};

export class HyperframesVideoGenerator {
  private readonly runner: HyperframesCommandRunner;
  private readonly npxBinary: string;
  private readonly packageSpec: string;

  constructor(private readonly options: HyperframesVideoGeneratorOptions) {
    this.runner = options.commandRunner ?? defaultRunner;
    this.npxBinary = options.npxBinary ?? (process.platform === "win32" ? "npx.cmd" : "npx");
    this.packageSpec = options.packageSpec ?? process.env.HYPERFRAMES_PACKAGE ?? "hyperframes@0.7.48";
  }

  async generate(script: ScriptAsset, jobId: string): Promise<HyperframesVideoResult> {
    const projectPath = path.join(this.options.storageRoot, "output", "videos", jobId, "hyperframes");
    const rendersPath = path.join(projectPath, "renders");
    const videoPath = path.join(rendersPath, "video.mp4");
    const manifestPath = path.join(projectPath, "video-output.json");
    const scenes = this.buildScenes(script);
    const duration = scenes.reduce((total, scene) => total + scene.duration, 0);

    await this.ensureEnvironment();
    await rm(projectPath, { recursive: true, force: true });

    await this.runHyperframes(["init", projectPath, "--non-interactive", "--example=blank"], {
      cwd: this.options.storageRoot
    });

    await mkdir(rendersPath, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(projectPath, "DESIGN.md"), this.renderDesign(script), "utf8");
    await writeFile(path.join(projectPath, "video-source.json"), JSON.stringify({
      provider: "hyperframes",
      generator: "douyin-ai-video",
      source: {
        topic: script.topic,
        title: script.coverTitle || script.title,
        summary: script.summary,
        cleanScript: script.cleanScript,
        voiceoverScript: script.voiceoverScript,
        shortVideoShots: script.shortVideoShots,
        videoPrompts: script.videoPrompts,
        enhancedScenes: script.enhancedScenes
      },
      width: WIDTH,
      height: HEIGHT,
      aspectRatio: "9:16",
      duration,
      scenes
    }, null, 2), "utf8");
    await writeFile(path.join(projectPath, "index.html"), this.renderIndexHtml(script, scenes, duration), "utf8");

    await this.runHyperframes(["lint"], { cwd: projectPath });
    await this.runHyperframes(["validate"], { cwd: projectPath });
    await this.runHyperframes(["inspect"], { cwd: projectPath });
    await this.runHyperframes(["render", "--quality", "high", "--fps", "30", "--output", "renders/video.mp4"], {
      cwd: projectPath
    });

    const rendered = await stat(videoPath).catch(() => null);
    if (!rendered || rendered.size <= 0) {
      throw new Error("HyperFrames render completed but video.mp4 was not created");
    }

    const result: HyperframesVideoResult = {
      provider: "hyperframes",
      projectPath,
      videoPath,
      manifestPath,
      createdAt: new Date().toISOString(),
      duration,
      aspectRatio: "9:16",
      width: WIDTH,
      height: HEIGHT,
      scenes
    };
    await writeFile(manifestPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  private async ensureEnvironment() {
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isFinite(major) || major < 22) {
      throw this.dependencyError(`current Node.js is ${process.version}`);
    }

    try {
      const result = await this.runHyperframes(["doctor", "--json"], {
        cwd: this.options.storageRoot,
        captureStdout: true,
        captureStderr: true
      });
      const text = result.stdout.trim();
      if (!text) {
        return;
      }
      const payload = JSON.parse(text) as {
        ok?: boolean;
        checks?: Array<{ name?: string; ok?: boolean; detail?: string; hint?: string }>;
        errors?: unknown;
      };
      if (payload.ok === false) {
        const blockingChecks = (payload.checks ?? []).filter((check) => (
          check.ok === false && !this.isOptionalDoctorCheck(check)
        ));
        if (blockingChecks.length > 0 || !payload.checks?.length) {
          throw this.dependencyError(JSON.stringify(payload.errors ?? blockingChecks ?? payload));
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HyperFrames 本地视频生成环境不可用")) {
        throw error;
      }
      throw this.dependencyError(error instanceof Error ? error.message : String(error));
    }
  }

  private async runHyperframes(
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      captureStdout?: boolean;
      captureStderr?: boolean;
    } = {}
  ) {
    const command = this.options.cliPath ? (this.options.nodeBinary ?? process.execPath) : this.npxBinary;
    const commandArgs = this.options.cliPath ? [this.options.cliPath, ...args] : ["--yes", this.packageSpec, ...args];
    try {
      return await this.runner.run(command, commandArgs, {
        captureStdout: true,
        captureStderr: true,
        ...options,
        env: this.buildEnv(options.env)
      });
    } catch (error) {
      if (error instanceof CommandError) {
        const detail = [error.stderr, error.stdout, error.message].map((value) => value.trim()).find(Boolean);
        throw new Error(
          [
            "HyperFrames 命令失败。",
            `命令：${error.command} ${error.args.join(" ")}`,
            detail ? `错误：${detail}` : undefined
          ].filter(Boolean).join("\n")
        );
      }
      throw error;
    }
  }

  private dependencyError(detail: string) {
    const commandHint = this.options.cliPath
      ? "内置 HyperFrames CLI 和 Chrome headless shell 资源"
      : "Node 22+、FFmpeg，并且可以在终端运行 npx hyperframes doctor";
    return new Error(
      [
        "HyperFrames 本地视频生成环境不可用。",
        `请确认${commandHint}可用。`,
        `当前错误：${detail}`
      ].join("\n")
    );
  }

  private buildEnv(env?: NodeJS.ProcessEnv) {
    const merged = {
      ...process.env,
      ...env
    };
    if (this.options.runtimeBinDir) {
      merged.PATH = [this.options.runtimeBinDir, merged.PATH].filter(Boolean).join(path.delimiter);
      if (process.platform === "win32") {
        merged.Path = [this.options.runtimeBinDir, merged.Path].filter(Boolean).join(path.delimiter);
      }
    }
    if (this.options.useElectronAsNode) {
      merged.ELECTRON_RUN_AS_NODE = "1";
    }
    if (this.options.browserPath) {
      merged.PRODUCER_HEADLESS_SHELL_PATH = this.options.browserPath;
    }
    return merged;
  }

  private isOptionalDoctorCheck(check: { name?: string; detail?: string; hint?: string }) {
    const text = [check.name, check.detail, check.hint].filter(Boolean).join(" ");
    return /optional|tts|kokoro|bgm|musicgen|docker|whisper/i.test(text);
  }

  private buildScenes(script: ScriptAsset): HyperframesVideoScene[] {
    const scenes = script.shortVideoShots?.length
      ? script.shortVideoShots.map((shot) => this.sceneFromShot(shot))
      : this.buildFallbackShots(script).map((shot) => this.sceneFromShot(shot));
    const unique = this.dedupeScenes(scenes);
    while (unique.length < MIN_SCENES) {
      const fallback = unique[unique.length % Math.max(unique.length, 1)];
      unique.push(this.sceneFromShot({
        index: unique.length + 1,
        duration: fallback?.duration ?? 5,
        shotType: "explain",
        subject: fallback?.subject ?? script.topic ?? "补充视角",
        action: "主体图形重新组合，形成补充解释",
        cameraMotion: "soft zoom",
        visualLayers: this.defaultLayers(fallback?.caption ?? script.topic ?? "补充内容", fallback?.subject ?? "补充视角"),
        caption: fallback?.caption ?? script.topic ?? "补充内容",
        emphasisWords: fallback?.emphasisWords ?? ["重点", "补充", "理解"],
        transition: "push",
        pacing: "medium",
        narration: fallback?.narration ?? script.voiceoverScript ?? script.summary ?? script.topic
      }));
    }

    return unique.slice(0, MAX_SCENES).map((scene, index) => ({
      ...scene,
      index: index + 1,
      accent: ACCENTS[index % ACCENTS.length]
    }));
  }

  private buildFallbackShots(script: ScriptAsset): ShortVideoShot[] {
    const title = this.cleanText(script.coverTitle || script.title || script.topic || "视频成片");
    const summary = this.cleanText(script.summary || script.cleanScript || script.voiceoverScript || title);
    const shots: ShortVideoShot[] = [
      this.fallbackShot(1, "hook", title, "关键词快速弹出，形成强开场", title, summary, "flash", "fast")
    ];
    let index = shots.length + 1;

    for (const promptScene of (script.enhancedScenes ?? []).slice(0, 8)) {
      shots.push(this.shotFromPromptScene(promptScene, index));
      index += 1;
    }

    if (!script.enhancedScenes?.length) {
      for (const prompt of (script.videoPrompts ?? []).slice(0, 8)) {
        shots.push(this.fallbackShot(index, "explain", prompt.slice(0, 22), "提示词视觉化为动态图形", prompt.slice(0, 56), prompt, "wipe", "medium"));
        index += 1;
      }
    }

    for (const item of (script.videoOutline ?? []).slice(0, 4)) {
      const text = [item.title, ...item.bullets].join("。");
      shots.push(this.fallbackShot(index, "process", item.title, "信息卡片按步骤展开", item.title, text, "push", "medium"));
      index += 1;
    }

    for (const sentence of this.splitSentences(script.voiceoverScript || script.cleanScript || script.rawText)) {
      shots.push(this.fallbackShot(index, "explain", sentence.slice(0, 20), "字幕跟随主体卡片推进", sentence.slice(0, 48), sentence, "cut", "medium"));
      index += 1;
    }

    shots.push(this.fallbackShot(index, "summary", "总结", "所有视觉层收束为结论卡片", "总结一下", script.voiceoverScript || summary || title, "zoom", "slow"));
    return shots;
  }

  private sceneFromShot(shot: ShortVideoShot): HyperframesVideoScene {
    const narration = this.cleanText(shot.narration || shot.caption || shot.subject);
    return {
      index: shot.index,
      shotType: shot.shotType,
      subject: this.cleanText(shot.subject).slice(0, 28) || "核心概念",
      action: this.cleanText(shot.action).slice(0, 80) || "主体图形入场并展开",
      cameraMotion: this.cleanText(shot.cameraMotion) || "soft zoom",
      visualLayers: this.normalizeLayers(shot.visualLayers, shot.caption, shot.subject),
      caption: this.cleanText(shot.caption).slice(0, 64) || narration.slice(0, 48),
      emphasisWords: this.normalizeEmphasis(shot.emphasisWords, narration),
      transition: shot.transition || "cut",
      pacing: shot.pacing || "medium",
      narration: narration.slice(0, 140),
      duration: this.normalizeDuration(shot.duration, narration),
      accent: ACCENTS[0]
    };
  }

  private shotFromPromptScene(promptScene: EnhancedScene, index: number): ShortVideoShot {
    const caption = this.cleanText(promptScene.videoPrompt || promptScene.originalVisual);
    const subject = this.cleanText(promptScene.originalVisual || `场景 ${promptScene.scene}`);
    return this.fallbackShot(
      index,
      "explain",
      subject,
      promptScene.motionEffect || "主体信息图入场，关键词逐个高亮",
      caption.slice(0, 56),
      caption,
      "push",
      "medium",
      promptScene.cameraMovement
    );
  }

  private fallbackShot(
    index: number,
    shotType: ShotType,
    subject: string,
    action: string,
    caption: string,
    narration: string,
    transition: ShotTransition,
    pacing: ShotPacing,
    cameraMotion = "soft zoom"
  ): ShortVideoShot {
    return {
      index,
      duration: this.estimateDuration(narration),
      shotType,
      subject: this.cleanText(subject) || "核心概念",
      action,
      cameraMotion,
      visualLayers: this.defaultLayers(caption, subject),
      caption: this.cleanText(caption).slice(0, 56),
      emphasisWords: this.normalizeEmphasis([], narration),
      transition,
      pacing,
      narration: this.cleanText(narration)
    };
  }

  private defaultLayers(caption: string, subject: string): ShortVideoVisualLayer[] {
    return [
      { type: "background", content: "深色渐变空间与动态网格", motion: "slow parallax drift", style: "dark tech canvas" },
      { type: "subject", content: this.cleanText(subject) || "核心概念", motion: "scale in", style: "glass card / neon outline" },
      { type: "graphic", content: "流程线、标签卡片、图标节点", motion: "draw line then pop nodes", style: "compact infographic" },
      { type: "caption", content: this.cleanText(caption).slice(0, 56), motion: "word-by-word reveal", style: "large kinetic Chinese subtitle" },
      { type: "emphasis", content: this.normalizeEmphasis([], caption).join(" / "), motion: "highlight sweep", style: "accent pills" },
      { type: "decoration", content: "粒子、扫描线、角标进度", motion: "ambient loop", style: "subtle" }
    ];
  }

  private normalizeLayers(layers: ShortVideoVisualLayer[] | undefined, caption: string, subject: string) {
    const normalized = (layers ?? []).map((layer) => ({
      type: layer.type,
      content: this.cleanText(layer.content),
      motion: this.cleanText(layer.motion),
      style: this.cleanText(layer.style)
    })).filter((layer) => layer.content);
    return normalized.length ? normalized.slice(0, 6) : this.defaultLayers(caption, subject);
  }

  private normalizeEmphasis(words: string[] | undefined, fallback: string) {
    const result = (words ?? [])
      .map((word) => this.cleanText(word))
      .filter((word) => word.length >= 2)
      .slice(0, 3);
    if (result.length) {
      return result;
    }
    return this.cleanText(fallback)
      .split(/[，,。！？!?；;、\s]+/)
      .filter((word) => word.length >= 2 && word.length <= 8)
      .slice(0, 3);
  }

  private normalizeDuration(duration: number, text: string) {
    if (Number.isFinite(duration)) {
      return Math.max(3, Math.min(8, Math.round(duration)));
    }
    return this.estimateDuration(text);
  }

  private dedupeScenes(scenes: HyperframesVideoScene[]) {
    const seen = new Set<string>();
    return scenes.filter((scene) => {
      const key = `${scene.subject}:${scene.caption}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private splitSentences(text?: string) {
    return (text ?? "")
      .split(/[。！？!?；;\n]+/)
      .map((sentence) => this.cleanText(sentence))
      .filter((sentence) => sentence.length >= 8)
      .slice(0, 6);
  }

  private estimateDuration(text: string) {
    return Math.max(5, Math.min(9, Math.ceil(text.length / 24) + 4));
  }

  private cleanText(value?: string) {
    return (value ?? "").replace(/\s+/g, " ").trim();
  }

  private renderDesign(script: ScriptAsset) {
    return `# HyperFrames Video Design

## Style Prompt
Vertical Chinese faceless explainer for Douyin. Shot-based motion graphics, kinetic captions, animated subject cards, infographic connectors, emphasis words, and fast mobile pacing.

## Colors
- Canvas: #08111f
- Text: #f8fafc
- Muted: #94a3b8
- Accent: #2dd4bf
- Support: #f59e0b

## Typography
- Display: Inter, system-ui, sans-serif
- Body: Inter, system-ui, sans-serif

## Source
- Topic: ${script.topic}
- Title: ${script.coverTitle || script.title || script.topic}

## What NOT to Do
- No realistic avatar or digital human.
- No generated product claims beyond the cleaned script.
- No slide-style title + bullet pages as the primary layout.
- No dense paragraphs that overflow the vertical canvas.
`;
  }

  private renderIndexHtml(script: ScriptAsset, scenes: HyperframesVideoScene[], duration: number) {
    const sceneMarkup = scenes.map((scene) => this.renderScene(scene, this.sceneStart(scenes, scene.index), scenes.length)).join("\n");
    const timeline = scenes.map((scene) => this.renderSceneTimeline(scene, this.sceneStart(scenes, scene.index))).join("\n");
    const safeTitle = this.escapeHtml(script.coverTitle || script.title || script.topic || "视频成片");

    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${WIDTH}, height=${HEIGHT}" />
    <title>${safeTitle}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        overflow: hidden;
        background: #08111f;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #root {
        position: relative;
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        overflow: hidden;
        background:
          radial-gradient(circle at 20% 18%, rgba(45, 212, 191, 0.20), transparent 26%),
          radial-gradient(circle at 84% 72%, rgba(245, 158, 11, 0.16), transparent 28%),
          #08111f;
      }
      .clip {
        visibility: hidden;
      }
      .scene {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        padding: 104px 72px;
        color: #f8fafc;
      }
      .ambient {
        position: absolute;
        inset: 0;
        background:
          linear-gradient(145deg, rgba(255,255,255,0.05), transparent 42%),
          repeating-linear-gradient(90deg, rgba(148, 163, 184, 0.07) 0 1px, transparent 1px 96px);
        pointer-events: none;
      }
      .transition-mask {
        position: absolute;
        inset: 0;
        background: var(--accent);
        transform: translateX(-110%);
        opacity: 0.92;
        z-index: 20;
      }
      .shot-meta {
        position: absolute;
        top: 76px;
        left: 72px;
        right: 72px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        color: #94a3b8;
        font-size: 24px;
        font-weight: 800;
        letter-spacing: 0;
      }
      .shot-type {
        color: #08111f;
        background: var(--accent);
        border-radius: 999px;
        padding: 10px 20px;
      }
      .subject-card {
        position: absolute;
        left: 72px;
        right: 72px;
        top: 260px;
        min-height: 430px;
        border: 1px solid rgba(248, 250, 252, 0.22);
        border-radius: 34px;
        padding: 48px;
        background:
          linear-gradient(135deg, rgba(248, 250, 252, 0.15), rgba(248, 250, 252, 0.04)),
          rgba(15, 23, 42, 0.72);
        box-shadow: 0 34px 90px rgba(0, 0, 0, 0.34);
        overflow: hidden;
      }
      .subject-card::after {
        content: "";
        position: absolute;
        right: -120px;
        top: -120px;
        width: 360px;
        height: 360px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--accent) 36%, transparent);
        filter: blur(8px);
      }
      .subject-label {
        color: var(--accent);
        font-size: 28px;
        font-weight: 900;
      }
      .subject {
        position: relative;
        max-width: 760px;
        margin-top: 26px;
        color: #f8fafc;
        font-size: 82px;
        line-height: 1.08;
        font-weight: 950;
      }
      .action {
        position: relative;
        margin-top: 28px;
        max-width: 780px;
        color: #cbd5e1;
        font-size: 34px;
        line-height: 1.42;
        font-weight: 700;
      }
      .graphic-layer {
        position: absolute;
        left: 108px;
        right: 108px;
        top: 760px;
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 18px;
      }
      .layer-chip {
        min-height: 126px;
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 22px;
        background: rgba(15, 23, 42, 0.62);
        padding: 22px;
      }
      .layer-chip b {
        display: block;
        margin-bottom: 10px;
        color: var(--accent);
        font-size: 20px;
        text-transform: uppercase;
      }
      .layer-chip span {
        color: #e2e8f0;
        font-size: 25px;
        line-height: 1.28;
        font-weight: 750;
      }
      .caption {
        position: absolute;
        left: 72px;
        right: 72px;
        bottom: 312px;
        color: #f8fafc;
        font-size: 56px;
        line-height: 1.18;
        font-weight: 950;
        text-wrap: balance;
      }
      .emphasis {
        position: absolute;
        left: 72px;
        right: 72px;
        bottom: 206px;
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
      }
      .emphasis span {
        color: #08111f;
        background: var(--accent);
        border-radius: 999px;
        padding: 12px 20px;
        font-size: 28px;
        font-weight: 950;
      }
      .narration {
        position: absolute;
        left: 72px;
        right: 72px;
        bottom: 118px;
        color: #cbd5e1;
        font-size: 28px;
        line-height: 1.42;
        max-height: 86px;
        overflow: hidden;
      }
      .progress {
        position: absolute;
        left: 72px;
        right: 72px;
        bottom: 72px;
        height: 8px;
        background: rgba(148, 163, 184, 0.20);
      }
      .progress i {
        display: block;
        height: 100%;
        width: var(--progress);
        background: var(--accent);
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${WIDTH}" data-height="${HEIGHT}">
${sceneMarkup}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true });
${timeline}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  }

  private sceneStart(scenes: HyperframesVideoScene[], index: number) {
    return scenes.slice(0, index - 1).reduce((total, scene) => total + scene.duration, 0);
  }

  private renderScene(scene: HyperframesVideoScene, start: number, sceneCount: number) {
    const chips = scene.visualLayers
      .filter((layer) => layer.type !== "background" && layer.type !== "caption" && layer.type !== "emphasis")
      .slice(0, 3)
      .map((layer) => (
        `          <div class="layer-chip"><b>${this.escapeHtml(layer.type)}</b><span>${this.escapeHtml(layer.content)}</span></div>`
      ))
      .join("\n");
    const emphasis = scene.emphasisWords.map((word) => (
      `          <span>${this.escapeHtml(word)}</span>`
    )).join("\n");
    const progress = Math.round((scene.index / sceneCount) * 100);
    return `      <section id="scene-${scene.index}" class="scene clip" data-start="${start}" data-duration="${scene.duration}" data-track-index="${scene.index}" style="--accent: ${scene.accent}; --progress: ${progress}%">
        <div class="ambient"></div>
        <div class="transition-mask"></div>
        <div class="shot-meta">
          <span class="shot-type">${this.escapeHtml(scene.shotType ?? "shot")}</span>
          <span>${this.escapeHtml(scene.cameraMotion)} · ${this.escapeHtml(scene.pacing)}</span>
        </div>
        <div class="subject-card">
          <div class="subject-label">SHOT ${scene.index}</div>
          <h1 class="subject">${this.escapeHtml(scene.subject)}</h1>
          <p class="action">${this.escapeHtml(scene.action)}</p>
        </div>
        <div class="graphic-layer">
${chips}
        </div>
        <div class="caption">${this.escapeHtml(scene.caption)}</div>
        <div class="emphasis">
${emphasis}
        </div>
        <p class="narration">${this.escapeHtml(scene.narration)}</p>
        <div class="progress"><i></i></div>
      </section>`;
  }

  private renderSceneTimeline(scene: HyperframesVideoScene, start: number) {
    const selector = `#scene-${scene.index}`;
    const exitAt = Math.max(start + scene.duration - 0.55, start + 0.5);
    const fast = scene.pacing === "fast";
    const slow = scene.pacing === "slow";
    const beat = fast ? 0.12 : slow ? 0.24 : 0.18;
    return `      tl.fromTo("${selector} .transition-mask", { xPercent: -110 }, { xPercent: 110, duration: ${fast ? 0.42 : 0.58}, ease: "power3.inOut" }, ${start});
      tl.fromTo("${selector} .ambient", { opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1, duration: 0.7, ease: "power2.out" }, ${start + 0.06});
      tl.fromTo("${selector} .shot-meta", { opacity: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.36, ease: "power2.out" }, ${start + 0.12});
      tl.fromTo("${selector} .subject-card", { opacity: 0, y: 80, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: ${slow ? 0.85 : 0.62}, ease: "power3.out" }, ${start + 0.26});
      tl.fromTo("${selector} .subject", { opacity: 0, y: 42 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${start + 0.42});
      tl.fromTo("${selector} .action", { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.42, ease: "power2.out" }, ${start + 0.68});
      tl.fromTo("${selector} .layer-chip", { opacity: 0, y: 28, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.38, stagger: ${beat}, ease: "back.out(1.6)" }, ${start + 0.92});
      tl.fromTo("${selector} .caption", { opacity: 0, y: 34 }, { opacity: 1, y: 0, duration: 0.46, ease: "power3.out" }, ${start + 1.22});
      tl.fromTo("${selector} .emphasis span", { opacity: 0, y: 26, scale: 0.75 }, { opacity: 1, y: 0, scale: 1, duration: 0.32, stagger: ${beat}, ease: "back.out(2)" }, ${start + 1.48});
      tl.fromTo("${selector} .narration", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.38, ease: "power2.out" }, ${start + 1.72});
      tl.to("${selector} .ambient", { x: ${scene.index % 2 === 0 ? -32 : 32}, y: ${scene.index % 2 === 0 ? 26 : -26}, duration: ${Math.max(1.5, scene.duration - 1.2)}, ease: "none" }, ${start + 0.2});
      tl.to("${selector} .subject-card", { y: ${scene.index % 2 === 0 ? -18 : 18}, duration: ${Math.max(1.5, scene.duration - 1.2)}, ease: "sine.inOut" }, ${start + 0.8});
      tl.to("${selector}", { opacity: 0, duration: 0.35, ease: "power2.in" }, ${exitAt});`;
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
