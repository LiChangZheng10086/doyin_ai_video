import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";
import type { EnhancedScene, ScriptAsset } from "../types.js";

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
  commandRunner?: HyperframesCommandRunner;
}

interface HyperframesVideoScene {
  index: number;
  title: string;
  bullets: string[];
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

  constructor(private readonly options: HyperframesVideoGeneratorOptions) {
    this.runner = options.commandRunner ?? defaultRunner;
    this.npxBinary = options.npxBinary ?? (process.platform === "win32" ? "npx.cmd" : "npx");
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
    await mkdir(rendersPath, { recursive: true });

    await this.runHyperframes(["hyperframes", "init", projectPath, "--non-interactive", "--example=blank"], {
      cwd: this.options.storageRoot
    });

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

    await this.runHyperframes(["hyperframes", "lint"], { cwd: projectPath });
    await this.runHyperframes(["hyperframes", "validate"], { cwd: projectPath });
    await this.runHyperframes(["hyperframes", "inspect"], { cwd: projectPath });
    await this.runHyperframes(["hyperframes", "render", "--quality", "high", "--fps", "30", "--output", "renders/video.mp4"], {
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
      const result = await this.runHyperframes(["hyperframes", "doctor", "--json"], {
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
    return this.runner.run(this.npxBinary, ["--yes", ...args], {
      captureStdout: true,
      captureStderr: true,
      ...options
    });
  }

  private dependencyError(detail: string) {
    return new Error(
      [
        "HyperFrames 本地视频生成环境不可用。",
        "请确认已安装 Node 22+、FFmpeg，并且可以在终端运行 npx hyperframes doctor。",
        `当前错误：${detail}`
      ].join("\n")
    );
  }

  private isOptionalDoctorCheck(check: { name?: string; detail?: string; hint?: string }) {
    const text = [check.name, check.detail, check.hint].filter(Boolean).join(" ");
    return /optional|tts|kokoro|bgm|musicgen|docker|whisper/i.test(text);
  }

  private buildScenes(script: ScriptAsset): HyperframesVideoScene[] {
    const scenes: HyperframesVideoScene[] = [];
    const title = this.cleanText(script.coverTitle || script.title || script.topic || "视频成片");
    const summary = this.cleanText(script.summary || script.cleanScript || script.voiceoverScript || "");
    const keyPoints = (script.keyPoints ?? []).map((point) => this.cleanText(point)).filter(Boolean);

    scenes.push(this.scene(title, [script.topic || "AI 洗稿成片"], summary || script.voiceoverScript || title));

    if (summary) {
      scenes.push(this.scene("核心摘要", [summary.slice(0, 48)], summary));
    }

    for (const promptScene of (script.enhancedScenes ?? []).slice(0, 8)) {
      scenes.push(this.sceneFromPromptScene(promptScene));
    }

    if (!script.enhancedScenes?.length) {
      for (const prompt of (script.videoPrompts ?? []).slice(0, 8)) {
        scenes.push(this.scene("画面提示词", [prompt.slice(0, 56)], prompt));
      }
    }

    for (const point of keyPoints.slice(0, 4)) {
      scenes.push(this.scene("关键要点", [point], point));
    }

    const outline = script.videoOutline ?? [];
    for (const item of outline.slice(0, 4)) {
      scenes.push(this.scene(item.title, item.bullets, [item.title, ...item.bullets].join("。")));
    }

    const sentences = this.splitSentences(script.voiceoverScript || script.cleanScript || script.rawText);
    for (const sentence of sentences) {
      scenes.push(this.scene("内容拆解", [sentence.slice(0, 42)], sentence));
    }

    scenes.push(this.scene("总结", keyPoints.slice(-3), script.voiceoverScript || summary || title));

    const unique = this.dedupeScenes(scenes);
    while (unique.length < MIN_SCENES) {
      const fallback = keyPoints[unique.length % Math.max(keyPoints.length, 1)] || summary || title;
      unique.push(this.scene(`补充视角 ${unique.length + 1}`, [fallback.slice(0, 42)], fallback));
    }

    return unique.slice(0, MAX_SCENES).map((scene, index) => ({
      ...scene,
      index: index + 1,
      accent: ACCENTS[index % ACCENTS.length]
    }));
  }

  private sceneFromPromptScene(promptScene: EnhancedScene) {
    return this.scene(
      `场景 ${promptScene.scene}`,
      [promptScene.originalVisual, promptScene.motionEffect, promptScene.cameraMovement].filter(Boolean) as string[],
      promptScene.videoPrompt || promptScene.originalVisual
    );
  }

  private scene(title: string, bullets: string[], narration: string): HyperframesVideoScene {
    const cleanBullets = bullets.map((bullet) => this.cleanText(bullet)).filter(Boolean).slice(0, 3);
    const cleanNarration = this.cleanText(narration || cleanBullets.join("。") || title);
    return {
      index: 0,
      title: this.cleanText(title).slice(0, 28) || "内容要点",
      bullets: cleanBullets.length ? cleanBullets : [cleanNarration.slice(0, 42)],
      narration: cleanNarration.slice(0, 140),
      duration: this.estimateDuration(cleanNarration),
      accent: ACCENTS[0]
    };
  }

  private dedupeScenes(scenes: HyperframesVideoScene[]) {
    const seen = new Set<string>();
    return scenes.filter((scene) => {
      const key = `${scene.title}:${scene.bullets.join("|")}`;
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
Vertical Chinese faceless explainer for Douyin. Clean dark canvas, high-contrast kinetic typography, compact infographic blocks, and calm motion.

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
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 156px 88px;
        gap: 42px;
        color: #f8fafc;
      }
      .scene::before {
        content: "";
        position: absolute;
        inset: 72px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        pointer-events: none;
      }
      .kicker {
        width: max-content;
        max-width: 100%;
        color: #08111f;
        background: var(--accent);
        padding: 12px 22px;
        border-radius: 999px;
        font-size: 28px;
        font-weight: 800;
      }
      h1 {
        max-width: 900px;
        color: #f8fafc;
        font-size: 86px;
        line-height: 1.08;
        font-weight: 900;
      }
      .bullets {
        display: grid;
        gap: 22px;
        list-style: none;
      }
      .bullets li {
        display: grid;
        grid-template-columns: 46px 1fr;
        gap: 18px;
        align-items: start;
        color: #e2e8f0;
        font-size: 38px;
        line-height: 1.34;
        font-weight: 700;
      }
      .bullets span {
        width: 46px;
        height: 46px;
        display: grid;
        place-items: center;
        color: #08111f;
        background: var(--accent);
        border-radius: 50%;
        font-size: 24px;
        font-weight: 900;
      }
      .narration {
        max-width: 860px;
        color: #cbd5e1;
        font-size: 30px;
        line-height: 1.52;
      }
      .progress {
        position: absolute;
        left: 88px;
        right: 88px;
        bottom: 92px;
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
    const bullets = scene.bullets.map((bullet, bulletIndex) => (
      `          <li><span>${bulletIndex + 1}</span>${this.escapeHtml(bullet)}</li>`
    )).join("\n");
    const progress = Math.round((scene.index / sceneCount) * 100);
    return `      <section id="scene-${scene.index}" class="scene clip" data-start="${start}" data-duration="${scene.duration}" data-track-index="${scene.index}" style="--accent: ${scene.accent}; --progress: ${progress}%">
        <div class="kicker">SCENE ${scene.index}</div>
        <h1>${this.escapeHtml(scene.title)}</h1>
        <ul class="bullets">
${bullets}
        </ul>
        <p class="narration">${this.escapeHtml(scene.narration)}</p>
        <div class="progress"><i></i></div>
      </section>`;
  }

  private renderSceneTimeline(scene: HyperframesVideoScene, start: number) {
    const selector = `#scene-${scene.index}`;
    const exitAt = Math.max(start + scene.duration - 0.55, start + 0.5);
    return `      tl.fromTo("${selector} .kicker", { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 0.45, ease: "power2.out" }, ${start + 0.15});
      tl.fromTo("${selector} h1", { opacity: 0, y: 54 }, { opacity: 1, y: 0, duration: 0.65, ease: "power3.out" }, ${start + 0.35});
      tl.fromTo("${selector} .bullets li", { opacity: 0, x: -28 }, { opacity: 1, x: 0, duration: 0.42, stagger: 0.16, ease: "back.out(1.5)" }, ${start + 0.85});
      tl.fromTo("${selector} .narration", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.45, ease: "power2.out" }, ${start + 1.25});
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
