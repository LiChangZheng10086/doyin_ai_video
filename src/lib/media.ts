import { createWriteStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CommandError, runCommand } from "./command.js";
import type { LocalStorage } from "./storage.js";

export interface MediaServiceConfig {
  ytDlpBinary?: string;
  ffmpegBinary?: string;
  cookiesFile?: string;
  cookiesFromBrowser?: string;
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
}

type DouyinPageVideoInfo = {
  videoId: string;
  videoUrl: string;
  title: string;
  desc: string;
  sourceUrl: string;
  resolvedShareUrl: string;
  pageUrl: string;
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
  constructor(
    private readonly storage: LocalStorage,
    private readonly config: MediaServiceConfig = {}
  ) {}

  async downloadVideo(sourceUrl: string, jobId: string): Promise<DownloadResult> {
    let pageError: Error | null = null;
    try {
      return await this.downloadViaPageParser(sourceUrl, jobId);
    } catch (error) {
      pageError = error instanceof Error ? error : new Error("page parser download failed");
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

  async extractAudio(videoPath: string, jobId: string): Promise<AudioExtractionResult> {
    const ffmpeg = this.config.ffmpegBinary ?? "ffmpeg";
    const audioPath = this.storage.resolve("raw/audio", `${jobId}.mp3`);
    const manifestPath = this.storage.resolve("raw/audio", `${jobId}.json`);
    const args = [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-acodec",
      "libmp3lame",
      "-q:a",
      "2",
      audioPath
    ];

    try {
      await runCommand(ffmpeg, args, {
        captureStderr: true
      });
    } catch (error) {
      throw this.decorateAudioError(error);
    }

    await this.storage.writeJson(path.join("raw", "audio", `${jobId}.json`), {
      jobId,
      sourceVideoPath: videoPath,
      audioPath,
      extractedAt: new Date().toISOString(),
      method: "ffmpeg"
    });

    return {
      audioPath,
      manifestPath
    };
  }

  private async downloadViaPageParser(sourceUrl: string, jobId: string): Promise<DownloadResult> {
    const info = await this.parseDouyinPageVideoInfo(sourceUrl);
    const videoPath = this.storage.resolve("raw/videos", `${jobId}.mp4`);
    const metadataPath = this.storage.resolve("raw/videos", `${jobId}.page.json`);

    await this.downloadFile(info.videoUrl, videoPath, {
      referer: info.pageUrl
    });

    const metadata = {
      ...info.metadata,
      downloadedVia: "page-parser",
      sourceUrl: info.sourceUrl,
      resolvedShareUrl: info.resolvedShareUrl,
      pageUrl: info.pageUrl,
      videoId: info.videoId,
      videoUrl: info.videoUrl,
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
      "--no-playlist",
      "--no-progress",
      "--no-warnings",
      "--restrict-filenames",
      "--merge-output-format",
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
      await runCommand(ytDlp, args, {
        captureStderr: true
      });
    } catch (error) {
      throw this.decorateYtDlpError(error);
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
    const shareResponse = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      headers: DOUYIN_HEADERS
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
      headers: DOUYIN_HEADERS
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
      throw new Error("unable to parse douyin video info");
    }

    const item = videoInfoRes.item_list[0] as Record<string, any>;
    const rawVideoUrl = item?.video?.play_addr?.url_list?.[0];
    if (!rawVideoUrl) {
      throw new Error("unable to parse douyin video url");
    }

    const videoUrl = String(rawVideoUrl).replace("playwm", "play");
    const desc = String(item?.desc ?? "").trim() || `douyin_${videoId}`;
    const title = this.sanitizeFilename(desc);

    return {
      videoId,
      videoUrl,
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

  private buildCookieArgs() {
    if (this.config.cookiesFile) {
      return ["--cookies", this.config.cookiesFile];
    }

    if (this.config.cookiesFromBrowser) {
      return ["--cookies-from-browser", this.config.cookiesFromBrowser];
    }

    return [];
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

  private decorateYtDlpError(error: unknown) {
    if (!(error instanceof CommandError)) {
      return error instanceof Error ? error : new Error("yt-dlp download failed");
    }

    const hint = this.buildYtDlpHint();
    const message = [error.stderr.trim(), hint].filter(Boolean).join("\n").trim();
    return new Error(message || "yt-dlp download failed");
  }

  private decorateAudioError(error: unknown) {
    if (!(error instanceof CommandError)) {
      return error instanceof Error ? error : new Error("audio extraction failed");
    }

    const message = error.stderr.trim() || "audio extraction failed";
    return new Error(message);
  }
}
