import { createWriteStream } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CommandError, runCommand } from "./command.js";
import type { LocalStorage } from "./storage.js";
import type { TranscriptResult } from "./asr.js";
import { isYouTubeUrl, parseYouTubeJson3, selectYouTubeCaption } from "./youtube.js";

export interface MediaServiceConfig {
  ytDlpBinary?: string;
  ytDlpJsRuntime?: string;
  ytDlpUseElectronAsNode?: boolean;
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  cookiesFile?: string;
  cookiesFromBrowser?: string;
  /**
   * 抖音登录 cookie（`loadCookie()` 的注入点）。
   *
   * 缺省时惰性取 `douyin-cookie.ts` 的 `loadCookie()`（与签名 API 通路同一个真源）。
   * 用例靠它断言「请求确实带上了 cookie」，否则只能读到开发者本机那个文件。
   */
  douyinCookie?: () => string;
  commandRunner?: MediaCommandRunner;
}

export interface MediaCommandRunner {
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

/**
 * ffmpeg 可用性探测要跑的命令。
 *
 * 运行环境状态一览用它回答「图文包配图能不能裁 3:4」。**只跑 `-version`**：
 * 一次短命的只读探测，不改变任何状态（INV-3）。命令形状只在这里定义一处，
 * 由调用方通过可注入的探测端口执行（用例据此断言调用形状）。
 */
export function ffmpegProbeCommand(ffmpegBinary?: string): { command: string; args: string[] } {
  return { command: ffmpegBinary?.trim() || "ffmpeg", args: ["-version"] };
}

export interface DownloadResult {
  videoPath: string;
  metadataPath: string;
  metadata: Record<string, unknown>;
  method: "page-parser" | "yt-dlp";
}

export interface AudioExtractionResult {
  audioPath: string;
  manifestPath: string;
  duration?: number;
}

type DouyinPageVideoInfo = {
  videoId: string;
  videoUrl: string;
  watermarkFreeUrl?: string;
  title: string;
  desc: string;
  sourceUrl: string;
  resolvedShareUrl: string;
  pageUrl: string;
  itemUrl?: string;
  metadata: Record<string, unknown>;
};

const DOUYIN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache"
};

export class MediaService {
  private readonly runner: MediaCommandRunner;

  constructor(
    private readonly storage: LocalStorage,
    private readonly config: MediaServiceConfig = {}
  ) {
    this.runner = config.commandRunner ?? { run: runCommand };
  }

  async downloadVideo(sourceUrl: string, jobId: string): Promise<DownloadResult> {
    if (isYouTubeUrl(sourceUrl)) {
      const url = new URL(sourceUrl);
      const videoLink = url.hostname === "youtu.be" ? /^\/[\w-]+\/?$/.test(url.pathname)
        : (url.pathname === "/watch" && /^[\w-]+$/.test(url.searchParams.get("v") ?? "")) || /^\/(shorts|live|embed)\/[\w-]+\/?$/.test(url.pathname);
      if (!videoLink) throw new Error("请使用单条 YouTube 视频链接；暂不支持频道或播放列表批量采集");
      return this.downloadViaYtDlp(sourceUrl, jobId);
    }
    // Try page parser first (works without auth, gets watermarked video)
    let pageError: Error | null = null;
    try {
      return await this.downloadViaPageParser(sourceUrl, jobId);
    } catch (error) {
      pageError = error instanceof Error ? error : new Error("page parser download failed");
    }

    // Try signed API (gets watermark-free video, needs auth cookie)
    try {
      return await this.downloadViaSignedApi(sourceUrl, jobId);
    } catch {
      // silent — fall through to yt-dlp
    }

    try {
      return await this.downloadViaYtDlp(sourceUrl, jobId);
    } catch (error) {
      const ytDlpError = error instanceof Error ? error : new Error("yt-dlp download failed");
      const hint = this.buildYtDlpHint();
      const message = [pageError?.message, ytDlpError.message, hint]
        .filter(Boolean)
        .join("\n")
        .trim();
      throw new Error(message || "video download failed");
    }
  }

  async readYouTubeCaptions(jobId: string, duration?: number): Promise<TranscriptResult | null> {
    let metadata: Record<string, unknown>;
    const metadataPath = this.storage.resolve("raw/videos", `${jobId}.info.json`);
    try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`YouTube 字幕元数据不可读取：${error instanceof Error ? error.message : String(error)}`);
    }
    const track = selectYouTubeCaption(metadata);
    if (!track) return null;
    const output = this.storage.resolve("raw/transcripts", `${jobId}.captions.%(ext)s`);
    const captionPath = this.storage.resolve("raw/transcripts", `${jobId}.captions.${track.language}.json3`);
    try {
      await rm(captionPath, { force: true });
      await this.runner.run(this.config.ytDlpBinary ?? "yt-dlp", [
        ...this.ytDlpRuntimeArgs(), "--no-playlist", "--skip-download", "--load-info-json", metadataPath,
        track.automatic ? "--write-auto-subs" : "--write-subs", "--sub-langs", track.language,
        "--sub-format", "json3", "-o", output, ...this.buildCookieArgs()
      ], this.ytDlpRunOptions());
      const actualDuration = duration ?? (typeof metadata.duration === "number" ? metadata.duration : undefined);
      const segments = parseYouTubeJson3(JSON.parse(await readFile(captionPath, "utf8")), actualDuration);
      return { text: segments.map((segment) => segment.text).join("\n"), segments, duration: actualDuration,
        language: track.language.replace(/-orig$/, ""), model: "youtube-json3",
        provider: track.automatic ? "youtube-automatic-captions" : "youtube-authored-captions" };
    } catch (error) {
      const message = error instanceof CommandError ? error.stderr.trim() || error.message : error instanceof Error ? error.message : String(error);
      throw new Error(`YouTube 字幕读取失败（已下载原视频保留，可重试）：${message}`);
    }
  }

  async extractAudio(videoPath: string, jobId: string): Promise<AudioExtractionResult> {
    const ffmpeg = this.config.ffmpegBinary ?? "ffmpeg";
    const ffprobe = this.config.ffprobeBinary ?? this.inferFfprobeBinary(ffmpeg);
    const audioPath = this.storage.resolve("raw/audio", `${jobId}.wav`);
    const manifestPath = this.storage.resolve("raw/audio", `${jobId}.json`);
    const args = [
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
      audioPath
    ];
    const sourceProbe = await this.probeMedia(ffprobe, videoPath);
    const manifestBase = {
      jobId,
      sourceVideoPath: videoPath,
      audioPath,
      extractedAt: new Date().toISOString(),
      method: "ffmpeg",
      ffmpeg,
      ffprobe,
      args,
      source: sourceProbe
    };

    try {
      await this.runner.run(ffmpeg, args, {
        captureStderr: true
      });
    } catch (error) {
      await this.storage.writeJson(path.join("raw", "audio", `${jobId}.json`), {
        ...manifestBase,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "audio extraction failed"
      });
      throw this.decorateAudioError(error);
    }

    const audioProbe = await this.probeMedia(ffprobe, audioPath);
    await this.storage.writeJson(path.join("raw", "audio", `${jobId}.json`), {
      ...manifestBase,
      status: "ready",
      audio: audioProbe
    });

    return {
      audioPath,
      manifestPath,
      duration: audioProbe.duration ?? sourceProbe.duration
    };
  }

  private inferFfprobeBinary(ffmpeg: string) {
    const binaryName = path.basename(ffmpeg);
    if (binaryName === "ffmpeg") {
      return path.join(path.dirname(ffmpeg), "ffprobe");
    }
    return "ffprobe";
  }

  private async probeMedia(
    ffprobe: string,
    filePath: string
  ): Promise<{
    duration?: number;
    streams?: Array<Record<string, unknown>>;
    errorMessage?: string;
  }> {
    try {
      const { stdout } = await this.runner.run(
        ffprobe,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_type,codec_name,channels,sample_rate",
          "-of",
          "json",
          filePath
        ],
        {
          captureStdout: true,
          captureStderr: true
        }
      );
      const payload = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: Array<Record<string, unknown>>;
      };
      const duration = Number(payload.format?.duration);
      return {
        duration: Number.isFinite(duration) ? duration : undefined,
        streams: payload.streams ?? []
      };
    } catch (error) {
      return {
        errorMessage: error instanceof Error ? error.message : "ffprobe failed"
      };
    }
  }

  private async downloadViaPageParser(sourceUrl: string, jobId: string): Promise<DownloadResult> {
    const info = await this.parseDouyinPageVideoInfo(sourceUrl);
    const videoPath = this.storage.resolve("raw/videos", `${jobId}.mp4`);
    const metadataPath = this.storage.resolve("raw/videos", `${jobId}.page.json`);

    // Prefer watermark-free URL if available (download_addr), fall back to play_addr
    const downloadUrl = info.watermarkFreeUrl || info.videoUrl;

    await this.downloadFile(downloadUrl, videoPath, {
      referer: info.pageUrl
    });

    const metadata = {
      ...info.metadata,
      downloadedVia: "page-parser",
      sourceUrl: info.sourceUrl,
      resolvedShareUrl: info.resolvedShareUrl,
      itemUrl: info.itemUrl || info.pageUrl,
      videoId: info.videoId,
      videoUrl: downloadUrl,
      isWatermarkFree: !!info.watermarkFreeUrl,
      title: info.title,
      desc: info.desc,
      downloadedAt: new Date().toISOString(),
      videoPath
    };
    await this.storage.writeJson(path.join("raw", "videos", `${jobId}.page.json`), metadata);

    return {
      videoPath,
      metadataPath,
      metadata,
      method: "page-parser"
    };
  }

  private async downloadViaYtDlp(sourceUrl: string, jobId: string): Promise<DownloadResult> {
    const ytDlp = this.config.ytDlpBinary ?? "yt-dlp";
    const outputTemplate = this.storage.resolve("raw/videos", `${jobId}.%(ext)s`);
    const args = [
      ...this.ytDlpRuntimeArgs(),
      "--no-playlist",
      "--no-progress",
      "--no-warnings",
      "--restrict-filenames",
      "--merge-output-format",
      "mp4",
      "--remux-video",
      "mp4",
      "--write-info-json",
      "-f",
      "bv*+ba/b",
      "-o",
      outputTemplate,
      ...this.buildCookieArgs(),
      sourceUrl
    ];

    try {
      await this.runner.run(ytDlp, args, this.ytDlpRunOptions());
    } catch (error) {
      throw this.decorateYtDlpError(error, !isYouTubeUrl(sourceUrl));
    }

    const videoPath = await this.findGeneratedFile("raw/videos", jobId, {
      excludeSuffixes: [".info.json", ".part", ".ytdl"]
    });
    const metadataPath = await this.findGeneratedFile("raw/videos", jobId, {
      suffix: ".info.json"
    });
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;

    return {
      videoPath,
      metadataPath,
      metadata: {
        ...metadata,
        downloadedVia: "yt-dlp"
      },
      method: "yt-dlp"
    };
  }

  private async parseDouyinPageVideoInfo(sourceUrl: string): Promise<DouyinPageVideoInfo> {
    // ⚠️ 分享页不带登录 cookie 时，`_ROUTER_DATA` 里**没有** `videoInfoRes`
    // （表现为 "unable to parse douyin video info"），而不是页面改版。
    // 桌面版 `www.douyin.com/video/{id}` 更是只回 JS-VM 挑战页、连 `_ROUTER_DATA` 都没有。
    const cookie = await this.resolveDouyinCookie();
    const headers = cookie ? { ...DOUYIN_HEADERS, Cookie: cookie } : { ...DOUYIN_HEADERS };

    const shareResponse = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      headers
    });

    if (!shareResponse.ok) {
      throw new Error(`share link request failed: ${shareResponse.status}`);
    }

    const resolvedShareUrl = shareResponse.url;
    const videoId = this.extractVideoId(resolvedShareUrl);
    if (!videoId) {
      throw new Error("unable to resolve douyin video id from share link");
    }

    const pageUrl = `https://www.iesdouyin.com/share/video/${videoId}`;
    const pageResponse = await fetch(pageUrl, {
      method: "GET",
      headers
    });

    if (!pageResponse.ok) {
      throw new Error(`page request failed: ${pageResponse.status}`);
    }

    const html = await pageResponse.text();
    const routerData = this.extractRouterData(html);
    const loaderData = (routerData.loaderData ?? {}) as Record<string, any>;
    const videoInfoRes =
      loaderData["video_(id)/page"]?.videoInfoRes ?? loaderData["note_(id)/page"]?.videoInfoRes;

    if (!videoInfoRes?.item_list?.length) {
      throw new Error(
        cookie
          ? "unable to parse douyin video info"
          : "unable to parse douyin video info（未带抖音 cookie：分享页不会返回 videoInfoRes，请先在设置页扫码登录）"
      );
    }

    const item = videoInfoRes.item_list[0] as Record<string, any>;
    const rawVideoUrl = item?.video?.play_addr?.url_list?.[0];
    if (!rawVideoUrl) {
      throw new Error("unable to parse douyin video url");
    }

    const videoUrl = String(rawVideoUrl).replace("playwm", "play");
    const desc = String(item?.desc ?? "").trim() || `douyin_${videoId}`;
    const title = this.sanitizeFilename(desc);

    // Try to extract watermark-free URL (download_addr) if available
    const watermarkFreeUrl = item?.video?.download_addr?.url_list?.[0]
      ? String(item.video.download_addr.url_list[0]).replace("playwm", "play")
      : undefined;

    return {
      videoId,
      videoUrl,
      watermarkFreeUrl,
      title,
      desc,
      sourceUrl,
      resolvedShareUrl,
      pageUrl,
      metadata: {
        routerData,
        item
      }
    };
  }

  private async downloadFile(
    url: string,
    filePath: string,
    options: { referer?: string } = {}
  ) {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        ...DOUYIN_HEADERS,
        ...(options.referer ? { Referer: options.referer } : {})
      }
    });

    if (!response.ok || !response.body) {
      throw new Error(`video download failed: ${response.status}`);
    }

    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(filePath));
  }

  /**
   * 抖音登录 cookie 的唯一取用口（默认实现是 `douyin-cookie.ts` 的 `loadCookie()`）。
   *
   * 用惰性 import 是为了避免 `douyin-cookie.ts` ↔ `media.ts` 的模块加载环，
   * 与签名 API 通路同一写法。失败不抛错：没有 cookie 时分享页拿不到数据，
   * 由调用方按「未登录」给出可照抄的指引。
   */
  private async resolveDouyinCookie(): Promise<string> {
    if (this.config.douyinCookie) {
      return this.config.douyinCookie();
    }

    const { loadCookie } = await import("./douyin-cookie.js");
    return loadCookie();
  }

  private buildCookieArgs() {
    if (this.config.cookiesFile) {
      return ["--cookies", this.config.cookiesFile];
    }

    if (this.config.cookiesFromBrowser) {
      return ["--cookies-from-browser", this.config.cookiesFromBrowser];
    }

    return [];
  }

  private ytDlpRuntimeArgs() {
    return ["--ignore-config", "--no-js-runtimes", "--js-runtimes", `node:${this.config.ytDlpJsRuntime ?? process.execPath}`,
      ...(this.config.ffmpegBinary && !["ffmpeg", "ffmpeg.exe"].includes(this.config.ffmpegBinary)
        ? ["--ffmpeg-location", this.config.ffmpegBinary] : [])];
  }

  private ytDlpRunOptions() {
    return { captureStderr: true, ...(this.config.ytDlpUseElectronAsNode ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } } : {}) };
  }

  private extractRouterData(html: string) {
    const match = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s);
    if (!match) {
      throw new Error("unable to parse router data from douyin page");
    }

    const rawJson = match[1].trim().replace(/;$/, "");
    return JSON.parse(rawJson) as Record<string, unknown>;
  }

  private extractVideoId(url: string) {
    const match = url.match(/\/video\/(\d+)/);
    return match?.[1];
  }

  private sanitizeFilename(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_").trim();
  }

  private buildYtDlpHint() {
    if (this.config.cookiesFile || this.config.cookiesFromBrowser) {
      return "";
    }

    return "Tip: set YTDLP_COOKIES_FILE or YTDLP_COOKIES_FROM_BROWSER if Douyin requires login cookies.";
  }

  private async findGeneratedFile(
    folder: string,
    jobId: string,
    options: {
      suffix?: string;
      excludeSuffixes?: string[];
    } = {}
  ) {
    const targetDir = this.storage.resolve(folder);
    const entries = await readdir(targetDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(`${jobId}.`))
      .filter((name) => (options.suffix ? name.endsWith(options.suffix) : true))
      .filter((name) =>
        options.excludeSuffixes
          ? !options.excludeSuffixes.some((suffix) => name.endsWith(suffix))
          : true
      );

    if (candidates.length === 0) {
      throw new Error(`generated file not found for ${jobId}`);
    }

    if (!options.suffix) {
      const preferredVideoExtensions = [".mp4", ".mkv", ".webm", ".mov", ".m4v", ".flv"];
      const preferred = candidates.find((name) =>
        preferredVideoExtensions.includes(path.extname(name).toLowerCase())
      );
      return path.join(targetDir, preferred ?? candidates[0]);
    }

    return path.join(targetDir, candidates[0]);
  }

  private decorateYtDlpError(error: unknown, includeCookieHint = true) {
    if (!(error instanceof CommandError)) {
      return error instanceof Error ? error : new Error("yt-dlp download failed");
    }

    const hint = includeCookieHint ? this.buildYtDlpHint() : "";
    const message = [error.stderr.trim(), hint].filter(Boolean).join("\n").trim();
    return new Error(message || "yt-dlp download failed");
  }

  // ─── 签名 API 下载（无水印）────────────────────────────────────

  /**
   * Download via the signed aweme/detail API.
   * Gets watermark-free download URLs from download_addr when available.
   * Requires an authenticated cookie (sessionid) for the API to return video data.
   */
  private async downloadViaSignedApi(sourceUrl: string, jobId: string): Promise<DownloadResult> {
    const videoId = this.extractVideoId(sourceUrl);
    if (!videoId) {
      throw new Error("unable to extract video ID for signed API download");
    }

    // Dynamic imports to avoid circular dependency at module load
    const [
      { signAwemeDetailRequest },
      { loadCookie, hasAuthCookie }
    ] = await Promise.all([
      import("./douyin-signatures.js"),
      import("./douyin-cookie.js"),
    ]);

    const cookie = loadCookie();
    if (!cookie || !hasAuthCookie()) {
      throw new Error("no auth cookie available for signed API download");
    }

    const { url, userAgent } = signAwemeDetailRequest(videoId);

    const resp = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        "Referer": "https://www.douyin.com/",
        "Cookie": cookie,
      },
    });

    if (!resp.ok) {
      throw new Error(`signed API request failed: ${resp.status}`);
    }

    const data = await resp.json() as Record<string, any>;
    const item = data?.aweme_detail as Record<string, any> | null;
    if (!item) {
      throw new Error("signed API returned empty video data (may need login cookie)");
    }

    const video = item.video as Record<string, any>;
    // Priority: download_addr (watermark-free) > play_addr_h264 > play_addr
    const downloadAddr = video?.download_addr?.url_list?.[0];
    const playAddrH264 = video?.play_addr_h264?.url_list?.[0];
    const playAddr = video?.play_addr?.url_list?.[0];

    const downloadUrl = typeof downloadAddr === "string"
      ? downloadAddr.replace("playwm", "play")
      : typeof playAddrH264 === "string"
        ? playAddrH264.replace("playwm", "play")
        : typeof playAddr === "string"
          ? playAddr.replace("playwm", "play")
          : null;

    if (!downloadUrl) {
      throw new Error("unable to extract video URL from signed API response");
    }

    const isWatermarkFree = typeof downloadAddr === "string";
    const videoPath = this.storage.resolve("raw/videos", `${jobId}.mp4`);
    const metadataPath = this.storage.resolve("raw/videos", `${jobId}.page.json`);

    await this.downloadFile(downloadUrl, videoPath, {
      referer: "https://www.douyin.com/",
    });

    const desc = String(item?.desc ?? "").trim() || `douyin_${videoId}`;
    const metadata = {
      ...item,
      downloadedVia: "signed-api",
      sourceUrl,
      videoId,
      videoUrl: downloadUrl,
      isWatermarkFree,
      title: this.sanitizeFilename(desc),
      desc,
      downloadedAt: new Date().toISOString(),
      videoPath,
    };
    await this.storage.writeJson(path.join("raw", "videos", `${jobId}.page.json`), metadata);

    return { videoPath, metadataPath, metadata, method: "page-parser" as const };
  }

  private decorateAudioError(error: unknown) {
    if (!(error instanceof CommandError)) {
      return error instanceof Error ? error : new Error("audio extraction failed");
    }

    const message = error.stderr.trim() || "audio extraction failed";
    return new Error(message);
  }
}
