import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { MediaService } from "./media.js";
import { LocalStorage } from "./storage.js";

const DOUYIN_DESKTOP_URL = "https://www.douyin.com/video/7690254449486351616";

/** 抖音分享页的典型形状：**带 cookie 才有 `videoInfoRes`**（实测，见探针记录）。 */
function douyinSharePageHtml(withVideoInfo: boolean): string {
  const routerData = {
    loaderData: {
      "video_(id)/page": withVideoInfo
        ? {
            videoInfoRes: {
              item_list: [
                {
                  desc: "测试作品",
                  video: { play_addr: { url_list: ["https://cdn.example.test/v.mp4"] } }
                }
              ]
            }
          }
        : {}
    }
  };
  return `<html><script>window._ROUTER_DATA = ${JSON.stringify(routerData)}</script></html>`;
}

/**
 * 抖音下载通路的 fetch 桩：**全部命中本地桩**，不发任何真实请求。
 * 记录每次请求的 URL 与 Cookie 头，供断言「cookie 到底有没有发出去」。
 */
function stubDouyinFetch(seen: Array<{ url: string; cookie: string | undefined }>) {
  return (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const cookie = init?.headers?.Cookie;
    seen.push({ url, cookie });

    if (url.includes("/aweme/v1/web/aweme/detail/")) {
      const payload = JSON.stringify({ aweme_detail: null });
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    }

    if (url.includes("iesdouyin.com/share/video/")) {
      const html = douyinSharePageHtml(Boolean(cookie));
      return { ok: true, status: 200, url, text: async () => html };
    }

    if (url.includes("cdn.example.test")) {
      return { ok: true, status: 200, body: Readable.toWeb(Readable.from([Buffer.from("ftyp")])) };
    }

    // 原始 sourceUrl（桌面 video 页）：只用来拿 video id
    return { ok: true, status: 200, url: DOUYIN_DESKTOP_URL, text: async () => "<html></html>" };
  }) as unknown as typeof fetch;
}

/** 捕获 yt-dlp 的调用形状，然后让它失败 —— 用来断言「配置有没有真的变成命令行参数」。 */
function captureYtDlpArgs() {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    commandRunner: {
      async run(command: string, args: string[]) {
        calls.push({ command, args });
        throw new Error("yt-dlp download failed");
      }
    }
  };
}

test("抖音页面解析通路会带上登录 cookie：分享页只有带 cookie 才返回 videoInfoRes", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "media-douyin-cookie-"));
  const storage = new LocalStorage(storageRoot);
  await storage.ensureBaseDirs();

  const seen: Array<{ url: string; cookie: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubDouyinFetch(seen);

  try {
    const media = new MediaService(storage, {
      douyinCookie: () => "sessionid=fake-session; ttwid=fake-ttwid"
    });

    const result = await media.downloadVideo(DOUYIN_DESKTOP_URL, "job-douyin");

    assert.equal(result.method, "page-parser");

    const pageCall = seen.find((call) => call.url.includes("iesdouyin.com/share/video/"));
    assert.ok(pageCall, "必须请求过 iesdouyin 分享页");
    assert.equal(pageCall.cookie, "sessionid=fake-session; ttwid=fake-ttwid");
    assert.equal(result.metadata.title, "测试作品");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("抖音页面解析：未带 cookie 时分享页无 videoInfoRes，报错必须点明未登录而不是含糊的解析失败", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "media-douyin-nocookie-"));
  const storage = new LocalStorage(storageRoot);
  await storage.ensureBaseDirs();

  const seen: Array<{ url: string; cookie: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubDouyinFetch(seen);
  const { calls, commandRunner } = captureYtDlpArgs();

  try {
    const media = new MediaService(storage, {
      douyinCookie: () => "",
      commandRunner
    });

    await assert.rejects(
      () => media.downloadVideo(DOUYIN_DESKTOP_URL, "job-douyin-nocookie"),
      (error: Error) => {
        assert.match(error.message, /unable to parse douyin video info/);
        assert.match(error.message, /扫码登录/);
        return true;
      }
    );

    assert.ok(
      seen.filter((call) => call.url.includes("iesdouyin.com")).every((call) => call.cookie === undefined),
      "未配置 cookie 时不应凭空造出 Cookie 头"
    );
    assert.ok(
      calls.every((call) => !call.args.includes("--cookies") && !call.args.includes("--cookies-from-browser")),
      "两个 cookie 配置都没给时，不该下发任何 cookie 参数"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("yt-dlp 通路：cookiesFile 必须原样下发成 --cookies（桌面端曾整条丢掉这两个配置）", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "media-ytdlp-cookies-"));
  const storage = new LocalStorage(storageRoot);
  await storage.ensureBaseDirs();

  const seen: Array<{ url: string; cookie: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubDouyinFetch(seen);
  const { calls, commandRunner } = captureYtDlpArgs();

  try {
    const media = new MediaService(storage, {
      douyinCookie: () => "",
      cookiesFile: "/tmp/douyin-cookies.txt",
      commandRunner
    });
    await assert.rejects(() => media.downloadVideo(DOUYIN_DESKTOP_URL, "job-ytdlp-cookies"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const call = calls.find((item) => item.args.includes("--cookies"));
  assert.ok(call, "配置了 cookiesFile 就必须下发 --cookies");
  assert.equal(call.args[call.args.indexOf("--cookies") + 1], "/tmp/douyin-cookies.txt");
  assert.ok(!call.args.includes("--cookies-from-browser"), "两种来源互斥，不能同时下发");
});

test("yt-dlp 通路：cookiesFromBrowser 必须原样下发成 --cookies-from-browser", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "media-ytdlp-browser-"));
  const storage = new LocalStorage(storageRoot);
  await storage.ensureBaseDirs();

  const seen: Array<{ url: string; cookie: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubDouyinFetch(seen);
  const { calls, commandRunner } = captureYtDlpArgs();

  try {
    const media = new MediaService(storage, {
      douyinCookie: () => "",
      cookiesFromBrowser: "chrome",
      commandRunner
    });
    await assert.rejects(() => media.downloadVideo(DOUYIN_DESKTOP_URL, "job-ytdlp-browser"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const call = calls.find((item) => item.args.includes("--cookies-from-browser"));
  assert.ok(call, "配置了 cookiesFromBrowser 就必须下发 --cookies-from-browser");
  assert.equal(call.args[call.args.indexOf("--cookies-from-browser") + 1], "chrome");
  assert.ok(!call.args.includes("--cookies"), "两种来源互斥，不能同时下发");
});

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
