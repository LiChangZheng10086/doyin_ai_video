import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { CommandError, runCommand } from "./command.js";
import { toSimplifiedChinese } from "./chinese.js";
import type {
  ScriptAsset,
  ShortVideoShot,
  ShortVideoVisualItem,
  ShortVideoVisualLayer,
  ShotLayout,
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
      timeoutMs?: number;
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
  ffprobeBinary?: string;
  commandRunner?: HyperframesCommandRunner;
}

export type HyperframesProgress = {
  phase: "checking_environment" | "building_project" | "validating" | "snapshotting" | "rendering" | "verifying";
  progress: number;
};

interface HyperframesVideoScene {
  index: number;
  shotType: ShotType;
  layout: ShotLayout;
  headline: string;
  supportingText?: string;
  captionLines: string[];
  visualItems: ShortVideoVisualItem[];
  sourceKeyPoints: number[];
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
const ACCENTS = ["#22c7a9", "#f5b942", "#5aa7ff", "#ff6f91", "#9fda3b", "#f66b5d"];
const require = createRequire(import.meta.url);

const defaultRunner: HyperframesCommandRunner = { run: runCommand };

export class HyperframesVideoGenerator {
  private readonly runner: HyperframesCommandRunner;
  private readonly npxBinary: string;
  private readonly packageSpec: string;

  constructor(private readonly options: HyperframesVideoGeneratorOptions) {
    this.runner = options.commandRunner ?? defaultRunner;
    this.npxBinary = options.npxBinary ?? (process.platform === "win32" ? "npx.cmd" : "npx");
    this.packageSpec = options.packageSpec ?? process.env.HYPERFRAMES_PACKAGE ?? "hyperframes@0.7.48";
  }

  async generate(
    script: ScriptAsset,
    jobId: string,
    onProgress?: (progress: HyperframesProgress) => Promise<void> | void
  ): Promise<HyperframesVideoResult> {
    const jobOutputPath = path.join(this.options.storageRoot, "output", "videos", jobId);
    const projectPath = path.join(jobOutputPath, "hyperframes");
    const runId = randomUUID().slice(0, 8);
    const stagingPath = path.join(jobOutputPath, `hyperframes-next-${runId}`);
    const failedPath = path.join(jobOutputPath, "hyperframes-failed");
    const stagingVideoPath = path.join(stagingPath, "renders", "video.mp4");
    const scenes = this.buildScenes(script);
    const duration = scenes.reduce((total, scene) => total + scene.duration, 0);

    try {
      await onProgress?.({ phase: "checking_environment", progress: 5 });
      await this.ensureEnvironment();
      await rm(stagingPath, { recursive: true, force: true });
      await mkdir(jobOutputPath, { recursive: true });

      await onProgress?.({ phase: "building_project", progress: 15 });
      await this.runHyperframes(["init", stagingPath, "--non-interactive", "--example=blank"], {
        cwd: this.options.storageRoot,
        timeoutMs: 120_000
      });
      await mkdir(path.join(stagingPath, "renders"), { recursive: true });
      await mkdir(path.join(stagingPath, "assets"), { recursive: true });
      await copyFile(require.resolve("gsap/dist/gsap.min.js"), path.join(stagingPath, "assets", "gsap.min.js"));
      await writeFile(path.join(stagingPath, "DESIGN.md"), this.renderDesign(script), "utf8");
      await writeFile(path.join(stagingPath, "video-source.json"), JSON.stringify({
        provider: "hyperframes",
        generator: "douyin-ai-video",
        planVersion: script.planVersion,
        targetDuration: script.targetDuration,
        source: {
          topic: script.topic,
          title: script.coverTitle || script.title,
          summary: script.summary,
          cleanScript: script.cleanScript,
          shortVideoScript: script.shortVideoScript,
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
      await writeFile(path.join(stagingPath, "index.html"), this.renderIndexHtml(script, scenes, duration), "utf8");

      await onProgress?.({ phase: "validating", progress: 35 });
      await this.runHyperframes(["lint"], { cwd: stagingPath, timeoutMs: 120_000 });
      await this.runHyperframes(["validate"], { cwd: stagingPath, timeoutMs: 120_000 });
      await this.runHyperframes(["inspect"], { cwd: stagingPath, timeoutMs: 120_000 });

      await onProgress?.({ phase: "snapshotting", progress: 45 });
      await this.runHyperframes(["snapshot", "--at", this.sceneMidpoints(scenes).join(",")], {
        cwd: stagingPath,
        timeoutMs: 180_000
      });

      await onProgress?.({ phase: "rendering", progress: 50 });
      await this.runHyperframes(["render", "--quality", "high", "--fps", "30", "--output", "renders/video.mp4"], {
        cwd: stagingPath,
        timeoutMs: 900_000
      });
      const rendered = await stat(stagingVideoPath).catch(() => null);
      if (!rendered || rendered.size <= 0) {
        throw new Error("HyperFrames render completed but video.mp4 was not created");
      }

      await onProgress?.({ phase: "verifying", progress: 95 });
      await this.verifyVideo(stagingVideoPath, script.planVersion === 2);
      await this.promoteProject(stagingPath, projectPath);

      const result: HyperframesVideoResult = {
        provider: "hyperframes",
        projectPath,
        videoPath: path.join(projectPath, "renders", "video.mp4"),
        manifestPath: path.join(projectPath, "video-output.json"),
        createdAt: new Date().toISOString(),
        duration,
        aspectRatio: "9:16",
        width: WIDTH,
        height: HEIGHT,
        scenes
      };
      await writeFile(result.manifestPath, JSON.stringify(result, null, 2), "utf8");
      await onProgress?.({ phase: "verifying", progress: 100 });
      return result;
    } catch (error) {
      if (await stat(stagingPath).catch(() => null)) {
        await rm(failedPath, { recursive: true, force: true });
        await rename(stagingPath, failedPath).catch(() => undefined);
      }
      throw error;
    }
  }

  private async promoteProject(stagingPath: string, projectPath: string) {
    const previousPath = `${projectPath}-previous`;
    await rm(previousPath, { recursive: true, force: true });
    const hasPrevious = Boolean(await stat(projectPath).catch(() => null));
    if (hasPrevious) await rename(projectPath, previousPath);
    try {
      await rename(stagingPath, projectPath);
      await rm(previousPath, { recursive: true, force: true });
    } catch (error) {
      if (hasPrevious && !(await stat(projectPath).catch(() => null))) {
        await rename(previousPath, projectPath).catch(() => undefined);
      }
      throw error;
    }
  }

  private async verifyVideo(videoPath: string, enforceShortDuration: boolean) {
    if (!this.options.ffprobeBinary) return;
    const result = await this.runner.run(this.options.ffprobeBinary, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size",
      "-of", "json",
      videoPath
    ], { captureStdout: true, captureStderr: true, timeoutMs: 120_000, env: this.buildEnv() });
    const payload = JSON.parse(result.stdout) as {
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }>;
      format?: { duration?: string; size?: string };
    };
    const video = payload.streams?.find((stream) => stream.codec_type === "video");
    const duration = Number(payload.format?.duration);
    if (!video || video.codec_name !== "h264" || video.width !== WIDTH || video.height !== HEIGHT || video.r_frame_rate !== "30/1") {
      throw new Error("生成的视频编码必须为 H.264、1080x1920、30fps");
    }
    if (!Number.isFinite(duration) || (enforceShortDuration && (duration < 50 || duration > 60.5))) {
      throw new Error(`生成的视频时长异常：${payload.format?.duration ?? "unknown"} 秒`);
    }
    if (Number(payload.format?.size) <= 0) throw new Error("生成的视频文件为空");
  }

  private async ensureEnvironment() {
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isFinite(major) || major < 22) throw this.dependencyError(`current Node.js is ${process.version}`);
    try {
      const result = await this.runHyperframes(["doctor", "--json"], {
        cwd: this.options.storageRoot,
        captureStdout: true,
        captureStderr: true,
        timeoutMs: 120_000
      });
      if (!result.stdout.trim()) return;
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        checks?: Array<{ name?: string; ok?: boolean; detail?: string; hint?: string }>;
        errors?: unknown;
      };
      if (payload.ok === false) {
        const blocking = (payload.checks ?? []).filter((check) => check.ok === false && !this.isOptionalDoctorCheck(check));
        if (blocking.length || !payload.checks?.length) throw this.dependencyError(JSON.stringify(payload.errors ?? blocking ?? payload));
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HyperFrames 本地视频生成环境不可用")) throw error;
      throw this.dependencyError(errorMessage(error));
    }
  }

  private async runHyperframes(
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; captureStdout?: boolean; captureStderr?: boolean; timeoutMs?: number } = {}
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
        throw new Error([
          "HyperFrames 命令失败。",
          `命令：${error.command} ${error.args.join(" ")}`,
          detail ? `错误：${detail}` : undefined
        ].filter(Boolean).join("\n"));
      }
      throw error;
    }
  }

  private dependencyError(detail: string) {
    const hint = this.options.cliPath
      ? "内置 HyperFrames CLI 和 Chrome headless shell 资源"
      : "Node 22+、FFmpeg，并且可以在终端运行 npx hyperframes doctor";
    return new Error(`HyperFrames 本地视频生成环境不可用。\n请确认${hint}可用。\n当前错误：${detail}`);
  }

  private buildEnv(env?: NodeJS.ProcessEnv) {
    const merged = { ...process.env, ...env };
    if (this.options.runtimeBinDir) {
      merged.PATH = [this.options.runtimeBinDir, merged.PATH].filter(Boolean).join(path.delimiter);
      if (process.platform === "win32") merged.Path = [this.options.runtimeBinDir, merged.Path].filter(Boolean).join(path.delimiter);
    }
    if (this.options.useElectronAsNode) merged.ELECTRON_RUN_AS_NODE = "1";
    if (this.options.browserPath) merged.PRODUCER_HEADLESS_SHELL_PATH = this.options.browserPath;
    return merged;
  }

  private isOptionalDoctorCheck(check: { name?: string; detail?: string; hint?: string }) {
    const text = [check.name, check.detail, check.hint].filter(Boolean).join(" ");
    return /optional|tts|kokoro|bgm|musicgen|docker|whisper|version|available|upgrade/i.test(text);
  }

  private buildScenes(script: ScriptAsset): HyperframesVideoScene[] {
    const raw = script.shortVideoShots?.length ? script.shortVideoShots : this.buildFallbackShots(script);
    const normalized = raw.map((shot) => this.sceneFromShot(shot));
    const scenes = script.planVersion === 2 ? normalized : this.dedupeScenes(normalized);
    const minimumScenes = script.planVersion === 2 ? 8 : MIN_SCENES;
    while (scenes.length < minimumScenes) {
      const source = scenes[scenes.length - 1] ?? this.sceneFromShot(this.fallbackShot(1, script.topic));
      scenes.push({ ...source, index: scenes.length + 1, headline: `${source.headline} · 延伸`, subject: `${source.subject} · 延伸` });
    }
    return scenes.slice(0, MAX_SCENES).map((scene, index) => ({
      ...scene,
      index: index + 1,
      accent: ACCENTS[index % ACCENTS.length]
    }));
  }

  private buildFallbackShots(script: ScriptAsset) {
    const title = cleanText(script.coverTitle || script.title || script.topic || "视频成片");
    const values = [
      ...((script.sceneList ?? []).map((scene) => scene.caption)),
      ...this.splitSentences(script.voiceoverScript || script.cleanScript || script.rawText),
      ...(script.keyPoints ?? []),
      ...((script.videoOutline ?? []).flatMap((item) => [item.title, ...item.bullets]))
    ].map(cleanText).filter(Boolean);
    const captions = [...new Set(values)];
    while (captions.length < MIN_SCENES) captions.push(`${title} · 要点 ${captions.length + 1}`);
    return captions.slice(0, MAX_SCENES).map((caption, index) => {
      const shot = this.fallbackShot(index + 1, caption);
      shot.shotType = index === 0 ? "hook" : index === Math.min(captions.length, MAX_SCENES) - 1 ? "summary" : "explain";
      shot.layout = index === 0 ? "kinetic-title" : shot.shotType === "summary" ? "summary-stack" : "concept-map";
      return shot;
    });
  }

  private fallbackShot(index: number, caption: string): ShortVideoShot {
    const lines = splitCaption(caption);
    const visualItems: ShortVideoVisualItem[] = [
      ...lines.map((line) => ({ label: line.slice(0, 12) })),
      { label: "重点", tone: "primary" }
    ];
    return {
      index,
      duration: Math.max(5, Math.min(8, Math.ceil(cleanText(caption).length / 18) + 4)),
      shotType: "explain",
      layout: "concept-map",
      headline: cleanText(caption).slice(0, 18) || "核心内容",
      supportingText: cleanText(caption).slice(0, 40),
      captionLines: lines,
      visualItems: visualItems.slice(0, 3),
      sourceKeyPoints: [],
      subject: cleanText(caption).slice(0, 18),
      action: "",
      cameraMotion: "",
      visualLayers: [
        { type: "background", content: "品牌背景", motion: "ambient", style: "local" },
        { type: "subject", content: cleanText(caption).slice(0, 18), motion: "build", style: "semantic" },
        { type: "caption", content: lines.join(" "), motion: "reveal", style: "safe-area" }
      ],
      caption: lines.join(" "),
      emphasisWords: lines.map((line) => line.slice(0, 8)),
      transition: index === 1 ? "flash" : "cut",
      pacing: index === 1 ? "fast" : "medium",
      narration: cleanText(caption)
    };
  }

  private sceneFromShot(shot: ShortVideoShot): HyperframesVideoScene {
    const headline = cleanText(shot.headline || shot.subject || shot.caption).slice(0, 18) || "核心内容";
    const captionLines = (shot.captionLines?.length ? shot.captionLines : splitCaption(shot.caption || shot.narration || headline))
      .map((line) => cleanText(line).slice(0, 16)).filter(Boolean).slice(0, 2);
    const visualItems = this.normalizeVisualItems(shot, headline);
    return {
      index: shot.index,
      shotType: shot.shotType || "explain",
      layout: shot.layout || layoutForShot(shot.shotType),
      headline,
      supportingText: cleanText(shot.supportingText).slice(0, 40) || undefined,
      captionLines: captionLines.length ? captionLines : [headline],
      visualItems,
      sourceKeyPoints: shot.sourceKeyPoints ?? [],
      subject: cleanText(shot.subject) || headline,
      action: cleanText(shot.action),
      cameraMotion: cleanText(shot.cameraMotion),
      visualLayers: shot.visualLayers ?? [],
      caption: captionLines.join(" ") || headline,
      emphasisWords: (shot.emphasisWords ?? []).map(cleanText).filter(Boolean).slice(0, 3),
      transition: shot.transition || "cut",
      pacing: shot.pacing || "medium",
      narration: cleanText(shot.narration || shot.caption || headline).slice(0, 80),
      duration: Math.max(3, Math.min(8, Math.round(shot.duration || 5))),
      accent: ACCENTS[0]
    };
  }

  private normalizeVisualItems(shot: ShortVideoShot, fallback: string) {
    const items = (shot.visualItems ?? []).map((item) => ({
      label: cleanText(item.label).slice(0, 12),
      value: cleanText(item.value).slice(0, 16) || undefined,
      tone: item.tone
    })).filter((item) => item.label);
    if (items.length >= 2) return items.slice(0, 5);
    const derived = [
      ...(shot.emphasisWords ?? []).map((label) => ({ label: cleanText(label).slice(0, 12), tone: "primary" as const })),
      ...(shot.visualLayers ?? []).filter((layer) => layer.type === "subject" || layer.type === "graphic").map((layer) => ({ label: cleanText(layer.content).slice(0, 12) }))
    ].filter((item) => item.label);
    while (derived.length < 2) derived.push({ label: derived.length ? "结果" : fallback.slice(0, 12) });
    return derived.slice(0, 5);
  }

  private dedupeScenes(scenes: HyperframesVideoScene[]) {
    const seen = new Set<string>();
    return scenes.filter((scene) => {
      const key = `${scene.headline}:${scene.caption}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private splitSentences(text?: string) {
    return (text ?? "").split(/[。！？!?；;\n]+/).map(cleanText).filter((sentence) => sentence.length >= 4).slice(0, 10);
  }

  private sceneMidpoints(scenes: HyperframesVideoScene[]) {
    let start = 0;
    return scenes.map((scene) => {
      const midpoint = start + scene.duration / 2;
      start += scene.duration;
      return Number(midpoint.toFixed(2));
    });
  }

  private renderDesign(script: ScriptAsset) {
    return `# HyperFrames Video Design

## Direction
Vertical Chinese faceless explainer. Full-bleed semantic motion graphics with distinct kinetic-title, concept-map, process-flow, comparison, metric, and summary compositions.

## Palette
- Canvas: #071019
- Text: #f4f7fb
- Muted: #9fb0c4
- Primary: #22c7a9
- Warm accent: #f5b942

## Source
- Topic: ${script.topic}
- Title: ${script.coverTitle || script.title || script.topic}

## Constraints
- Audience-facing content only; no shot labels, camera directions, prompts, or production metadata.
- No title-and-bullets slide structure.
- No network-loaded render assets.
`;
  }

  private renderIndexHtml(script: ScriptAsset, scenes: HyperframesVideoScene[], duration: number) {
    let start = 0;
    const markup = scenes.map((scene) => {
      const html = this.renderScene(scene, start, scenes.length);
      start += scene.duration;
      return html;
    }).join("\n");
    start = 0;
    const timeline = scenes.map((scene) => {
      const code = this.renderSceneTimeline(scene, start);
      start += scene.duration;
      return code;
    }).join("\n");
    const title = escapeHtml(script.coverTitle || script.title || script.topic || "视频成片");

    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${WIDTH}, height=${HEIGHT}" />
    <title>${title}</title>
    <script src="assets/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #071019; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      #root { position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
      #background { position: absolute; inset: 0; background: radial-gradient(circle at 16% 18%, rgba(34,199,169,.24), transparent 29%), radial-gradient(circle at 86% 76%, rgba(245,185,66,.18), transparent 31%), #071019; }
      #background::after { content: ""; position: absolute; inset: 0; background-image: repeating-linear-gradient(90deg, rgba(159,176,196,.09) 0 2px, transparent 2px 108px), repeating-linear-gradient(0deg, rgba(159,176,196,.06) 0 2px, transparent 2px 108px); opacity: .5; }
      .clip { visibility: hidden; }
      .scene { position: absolute; inset: 0; width: 100%; height: 100%; color: #f4f7fb; overflow: hidden; }
      .transition-mask { position: absolute; inset: 0; z-index: 1; background: var(--accent); opacity: 0; }
      .orb { position: absolute; z-index: 0; border: 3px solid color-mix(in srgb, var(--accent) 65%, transparent); border-radius: 50%; opacity: .28; }
      .orb-a { width: 420px; height: 420px; top: -120px; right: -120px; }
      .orb-b { width: 240px; height: 240px; left: -80px; bottom: 280px; }
      .scene-inner { position: absolute; inset: 0; z-index: 2; padding: 120px 72px 210px; display: flex; flex-direction: column; }
      .headline { max-width: 900px; color: #f4f7fb; font-size: 88px; line-height: 1.08; font-weight: 900; letter-spacing: 0; }
      .supporting { max-width: 850px; min-height: 54px; margin-top: 26px; color: #b9c7d7; font-size: 34px; line-height: 1.45; font-weight: 600; }
      .visual-zone { position: relative; flex: 1; min-height: 640px; margin-top: 72px; }
      .visual-element { position: relative; border: 2px solid color-mix(in srgb, var(--accent) 62%, #42536a); background: rgba(7,16,25,.72); }
      .visual-label { color: #f4f7fb; font-size: 32px; line-height: 1.25; font-weight: 800; }
      .visual-value { color: var(--accent); font-size: 54px; line-height: 1; font-weight: 950; }
      .tone-success { --item-color: #74d68c; } .tone-danger { --item-color: #ff7770; } .tone-muted { --item-color: #9fb0c4; } .tone-primary { --item-color: var(--accent); }
      .audience-caption { position: absolute; z-index: 3; left: 72px; right: 72px; bottom: 82px; height: 184px; display: flex; flex-direction: column; justify-content: center; gap: 5px; border-top: 3px solid var(--accent); padding-top: 18px; color: #f4f7fb; font-size: 48px; line-height: 1.12; font-weight: 900; }
      .progress { position: absolute; z-index: 3; left: 72px; right: 72px; bottom: 48px; height: 7px; background: rgba(159,176,196,.2); }
      .progress i { display: block; width: var(--progress); height: 100%; background: var(--accent); }

      [data-layout="kinetic-title"] .scene-inner { justify-content: center; padding-bottom: 280px; }
      [data-layout="kinetic-title"] .headline { font-size: 112px; max-width: 920px; }
      .kinetic-word { display: inline-block; margin-top: 54px; color: #071019; background: var(--accent); padding: 18px 30px; font-size: 56px; font-weight: 950; }
      .kinetic-rule { width: 78%; height: 12px; margin-top: 42px; background: var(--accent); transform-origin: left center; }

      .concept-map { height: 100%; display: grid; grid-template-columns: 1fr 1.25fr 1fr; grid-template-rows: 1fr 1fr; gap: 24px; align-items: center; }
      .concept-core { grid-column: 2; grid-row: 1 / 3; display: flex; min-height: 260px; align-items: center; justify-content: center; border: 4px solid var(--accent); color: #f4f7fb; font-size: 52px; font-weight: 950; text-align: center; padding: 28px; }
      .concept-node { min-height: 150px; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }

      .process-flow { height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 26px; }
      .flow-node { min-height: 112px; display: grid; grid-template-columns: 76px 1fr auto; align-items: center; gap: 24px; padding: 24px 30px; border-left: 10px solid var(--accent); }
      .flow-index { color: var(--accent); font-size: 42px; font-weight: 950; }
      .flow-line { position: absolute; left: 68px; top: 92px; bottom: 92px; width: 4px; background: color-mix(in srgb, var(--accent) 75%, transparent); transform-origin: top center; }

      .comparison { height: 100%; display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: center; }
      .compare-panel { min-height: 430px; display: flex; flex-direction: column; justify-content: space-between; padding: 42px; }
      .compare-panel:first-child { border-color: #ff7770; } .compare-panel:last-child { border-color: #74d68c; }
      .compare-symbol { color: var(--item-color, var(--accent)); font-size: 96px; line-height: 1; font-weight: 950; }

      .metric-stage { height: 100%; display: grid; grid-template-columns: 1.2fr .8fr; gap: 34px; align-items: center; }
      .metric-main { min-height: 430px; display: flex; flex-direction: column; justify-content: center; padding: 48px; }
      .metric-main .visual-value { font-size: 132px; }
      .metric-list { display: flex; flex-direction: column; gap: 22px; }
      .metric-item { min-height: 122px; padding: 26px; }
      .metric-bar { width: 100%; height: 10px; margin-top: 20px; background: var(--item-color, var(--accent)); transform-origin: left center; }

      .summary-stack { height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 24px; }
      .summary-item { min-height: 126px; display: grid; grid-template-columns: 18px 1fr auto; align-items: center; gap: 28px; padding: 26px 34px; }
      .summary-dot { width: 18px; height: 72px; background: var(--item-color, var(--accent)); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${WIDTH}" data-height="${HEIGHT}">
      <div id="background"></div>
${markup}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true });
${timeline}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
  }

  private renderScene(scene: HyperframesVideoScene, start: number, count: number) {
    const progress = Math.round((scene.index / count) * 100);
    const captions = scene.captionLines.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
    return `      <section id="scene-${scene.index}" class="scene clip" data-layout="${scene.layout}" data-start="${start}" data-duration="${scene.duration}" data-track-index="1" style="--accent:${scene.accent};--progress:${progress}%">
        <div class="transition-mask" data-layout-allow-overflow></div>
        <div class="orb orb-a" data-layout-allow-overflow></div><div class="orb orb-b" data-layout-allow-overflow></div>
        <div class="scene-inner">
          <h1 class="headline">${escapeHtml(scene.headline)}</h1>
          <p class="supporting">${escapeHtml(scene.supportingText ?? "")}</p>
          <div class="visual-zone">${this.renderLayout(scene)}</div>
        </div>
        <div class="audience-caption">${captions}</div>
        <div class="progress"><i></i></div>
      </section>`;
  }

  private renderLayout(scene: HyperframesVideoScene) {
    const items = scene.visualItems;
    if (scene.layout === "kinetic-title") {
      return `<div class="kinetic-word visual-element">${escapeHtml(items[0]?.value || items[0]?.label || scene.headline)}</div><div class="kinetic-rule"></div>`;
    }
    if (scene.layout === "process-flow") {
      return `<div class="process-flow"><div class="flow-line"></div>${items.map((item, index) => `<div class="flow-node visual-element ${toneClass(item)}"><span class="flow-index">${String(index + 1).padStart(2, "0")}</span><span class="visual-label">${escapeHtml(item.label)}</span>${item.value ? `<span class="visual-value">${escapeHtml(item.value)}</span>` : ""}</div>`).join("")}</div>`;
    }
    if (scene.layout === "comparison") {
      const pair = [items[0], items[1] ?? items[0]];
      return `<div class="comparison">${pair.map((item, index) => `<div class="compare-panel visual-element ${toneClass(item)}"><span class="compare-symbol">${index === 0 ? "−" : "+"}</span><span class="visual-label">${escapeHtml(item?.label ?? "")}</span>${item?.value ? `<span class="visual-value">${escapeHtml(item.value)}</span>` : ""}</div>`).join("")}</div>`;
    }
    if (scene.layout === "metric") {
      const [main, ...rest] = items;
      return `<div class="metric-stage"><div class="metric-main visual-element ${toneClass(main)}"><span class="visual-value">${escapeHtml(main?.value ?? main?.label ?? "")}</span><span class="visual-label">${escapeHtml(main?.label ?? "")}</span></div><div class="metric-list">${rest.map((item) => `<div class="metric-item visual-element ${toneClass(item)}"><span class="visual-label">${escapeHtml(item.label)}</span>${item.value ? `<span class="visual-value">${escapeHtml(item.value)}</span>` : ""}<div class="metric-bar"></div></div>`).join("")}</div></div>`;
    }
    if (scene.layout === "summary-stack") {
      return `<div class="summary-stack">${items.map((item) => `<div class="summary-item visual-element ${toneClass(item)}"><span class="summary-dot"></span><span class="visual-label">${escapeHtml(item.label)}</span>${item.value ? `<span class="visual-value">${escapeHtml(item.value)}</span>` : ""}</div>`).join("")}</div>`;
    }
    const nodes = items.slice(0, 4);
    return `<div class="concept-map"><div class="concept-core visual-element">${escapeHtml(scene.headline)}</div>${nodes.map((item) => `<div class="concept-node visual-element ${toneClass(item)}"><span class="visual-label">${escapeHtml(item.label)}</span></div>`).join("")}</div>`;
  }

  private renderSceneTimeline(scene: HyperframesVideoScene, start: number) {
    const selector = `#scene-${scene.index}`;
    const enter = transitionVars(scene.transition);
    const exitAt = Math.max(start + scene.duration - 0.38, start + 0.8);
    const stagger = scene.pacing === "fast" ? 0.08 : scene.pacing === "slow" ? 0.18 : 0.12;
    const maskDuration = scene.transition === "flash" ? 0.34 : 0.48;
    return `      tl.set("${selector} .transition-mask", { xPercent: -120, opacity: ${scene.transition === "cut" ? 0 : 0.9} }, ${start});
      tl.fromTo("${selector} .transition-mask", { xPercent: -120 }, { xPercent: 120, duration: ${maskDuration}, ease: "power3.inOut" }, ${start + 0.02});
      tl.fromTo("${selector} .scene-inner", ${JSON.stringify(enter.from)}, { ...${JSON.stringify(enter.to)}, duration: ${enter.duration}, ease: "${enter.ease}" }, ${start + 0.12});
      tl.fromTo("${selector} .headline", { opacity: 0, y: 54 }, { opacity: 1, y: 0, duration: 0.62, ease: "expo.out" }, ${start + 0.24});
      tl.fromTo("${selector} .supporting", { opacity: 0, x: -42 }, { opacity: 1, x: 0, duration: 0.46, ease: "power2.out" }, ${start + 0.48});
      tl.fromTo("${selector} .visual-element", { opacity: 0, y: 48, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: ${stagger}, ease: "back.out(1.35)" }, ${start + 0.72});
      tl.fromTo("${selector} .flow-line, ${selector} .kinetic-rule, ${selector} .metric-bar", { scaleY: 0, scaleX: 0 }, { scaleY: 1, scaleX: 1, duration: 0.58, ease: "power2.out" }, ${start + 0.9});
      tl.fromTo("${selector} .audience-caption span", { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 0.38, stagger: 0.14, ease: "power3.out" }, ${start + 1.05});
      tl.fromTo("${selector} .orb-a", { x: 0, y: 0, scale: 0.94 }, { x: 42, y: 54, scale: 1.08, duration: ${Math.max(2, scene.duration - 0.4)}, ease: "sine.inOut" }, ${start + 0.2});
      tl.fromTo("${selector} .orb-b", { x: 0, y: 0 }, { x: -32, y: -44, duration: ${Math.max(2, scene.duration - 0.6)}, ease: "none" }, ${start + 0.3});
      tl.to("${selector} .scene-inner, ${selector} .audience-caption", { opacity: 0, duration: 0.3, ease: "power2.in" }, ${exitAt});`;
  }
}

function layoutForShot(type?: ShotType): ShotLayout {
  if (type === "hook" || type === "cta") return "kinetic-title";
  if (type === "process") return "process-flow";
  if (type === "contrast" || type === "problem") return "comparison";
  if (type === "proof") return "metric";
  if (type === "summary") return "summary-stack";
  return "concept-map";
}

function transitionVars(transition: ShotTransition) {
  if (transition === "push") return { from: { opacity: 0, x: 180 }, to: { opacity: 1, x: 0 }, duration: 0.56, ease: "power3.out" };
  if (transition === "zoom") return { from: { opacity: 0, scale: 0.82 }, to: { opacity: 1, scale: 1 }, duration: 0.62, ease: "expo.out" };
  if (transition === "match-cut") return { from: { opacity: 0, scale: 1.14, rotation: -2 }, to: { opacity: 1, scale: 1, rotation: 0 }, duration: 0.5, ease: "power2.out" };
  if (transition === "wipe") return { from: { opacity: 0, x: -120 }, to: { opacity: 1, x: 0 }, duration: 0.48, ease: "power2.out" };
  if (transition === "flash") return { from: { opacity: 0, scale: 0.92 }, to: { opacity: 1, scale: 1 }, duration: 0.4, ease: "back.out(1.2)" };
  return { from: { opacity: 0 }, to: { opacity: 1 }, duration: 0.16, ease: "none" };
}

function splitCaption(value: string) {
  const text = cleanText(value).slice(0, 32);
  if (text.length <= 16) return [text];
  return [text.slice(0, 16), text.slice(16, 32)];
}

function cleanText(value?: string) {
  return toSimplifiedChinese(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toneClass(item?: ShortVideoVisualItem) {
  return `tone-${item?.tone ?? "primary"}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
