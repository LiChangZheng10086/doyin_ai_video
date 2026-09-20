/**
 * 微信公众号图片处理测试（封面 + 正文图）。
 *
 * **全程用一个 shell stub 冒充 ffmpeg**（临时目录里 `chmod +x` 后经 `ffmpegBinary` 注入）：
 * 不联网、不调用真实 ffmpeg、不碰用户的素材原图。
 *
 * 限额依据（spec §1.3，官方文档）：
 * - 封面走 `material/add_material`：图片 ≤ **10MB**，且 news 封面裁剪比例**只支持 `2.35_1` 与 `1_1`**
 *   → 我们的静帧是 9:16，必须**自己裁成 2.35:1**，不能赌系统乱裁；
 * - 正文图走 `media/uploadimg`：**只支持 jpg/png 且必须 <1MB**，不占用素材库限额
 *   → webp 必须转换，超限必须压缩（循环降质）。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  MAX_SOURCE_IMAGE_BYTES,
  WECHAT_COVER_HEIGHT,
  WECHAT_COVER_RATIO,
  WECHAT_COVER_WIDTH,
  WechatMediaError,
  WechatMediaService,
  contentImageFileName,
} from "./wechat-media.js";

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = "wechat-media-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface StubOptions {
  /** 第 n 次调用产出的文件大小（KB）；不够长时重复最后一个值。 */
  sizesKb: number[];
  argvFile: string;
  counterFile: string;
  fail?: boolean;
}

/**
 * 写一个假 ffmpeg：把自身 argv 记成一行（用 `|` 连接）、按调用次数产出指定大小的文件、
 * 输出路径取**最后一个参数**。可选地直接退出 1 模拟失败。
 */
async function stubFfmpeg(directory: string, options: StubOptions): Promise<string> {
  const stubPath = path.join(directory, `ffmpeg-stub-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  const sizes = options.sizesKb.length > 0 ? options.sizesKb : [1];
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$(printf '%s|' "$@")" >> ${shQuote(options.argvFile)}`,
    `n=$(cat ${shQuote(options.counterFile)} 2>/dev/null || printf 0)`,
    "n=$((n + 1))",
    `printf '%s' "$n" > ${shQuote(options.counterFile)}`,
    "out=''",
    'for a in "$@"; do out="$a"; done',
    'mkdir -p "$(dirname "$out")"',
    "i=1",
    `kb=${sizes[sizes.length - 1]}`,
    `for s in ${sizes.join(" ")}; do`,
    "  kb=$s",
    '  if [ "$i" -eq "$n" ]; then break; fi',
    "  i=$((i + 1))",
    "done",
    `dd if=/dev/zero of="$out" bs=1024 count="$kb" 2>/dev/null`,
    // 失败模式**先把产物写出来再失败**：这样「不留半成品」的断言才真的在测清理逻辑。
    options.fail ? "exit 1" : "exit 0",
  ].join("\n");
  await writeFile(stubPath, `${script}\n`, "utf8");
  await chmod(stubPath, 0o755);
  return stubPath;
}

interface MediaFixture {
  dir: string;
  sourcePath: string;
  outDir: string;
  argvFile: string;
  calls: () => Promise<string[][]>;
  service: WechatMediaService;
  outDirEntries: () => Promise<string[]>;
}

async function mediaFixture(
  options: { sizesKb?: number[]; fail?: boolean; sourceName?: string; sourceBytes?: number } = {},
): Promise<MediaFixture> {
  const dir = await tempDir();
  const sourceName = options.sourceName ?? "静帧 01.png";
  const sourcePath = path.join(dir, "source", sourceName);
  const outDir = path.join(dir, "out");
  const argvFile = path.join(dir, "argv.txt");
  const counterFile = path.join(dir, "counter.txt");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(sourcePath, Buffer.alloc(options.sourceBytes ?? 4096, 7));

  const ffmpegBinary = await stubFfmpeg(dir, {
    sizesKb: options.sizesKb ?? [300],
    argvFile,
    counterFile,
    fail: options.fail,
  });

  return {
    dir,
    sourcePath,
    outDir,
    argvFile,
    service: new WechatMediaService({ ffmpegBinary }),
    calls: async () => {
      try {
        const raw = await readFile(argvFile, "utf8");
        return raw
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => line.split("|").filter((part) => part.length > 0));
      } catch {
        return [];
      }
    },
    outDirEntries: async () => (await readdir(outDir)).sort(),
  };
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// ── 封面 ──────────────────────────────────────────────────────────────────────

test("封面裁成 2.35:1（900×383）且输出 jpg", async () => {
  const fixture = await mediaFixture({ sizesKb: [120] });
  const result = await fixture.service.prepareCoverImage(fixture.sourcePath, fixture.outDir);

  assert.equal(path.basename(result.path), "wechat-cover.jpg");
  assert.ok(result.path.startsWith(fixture.outDir), "产物必须落在给它的目录里");

  const [call] = await fixture.calls();
  const filter = argValue(call, "-vf") ?? "";
  // 官方规定 news 封面裁剪比例只支持 2.35_1 / 1_1：我们自己裁，不能赌系统乱裁。
  assert.match(filter, new RegExp(`scale=${WECHAT_COVER_WIDTH}:${WECHAT_COVER_HEIGHT}`, "u"));
  assert.match(filter, /crop/u);
  assert.equal(WECHAT_COVER_RATIO, "2.35_1");
  assert.equal(call[call.length - 1], result.path);
});

test("封面只调用一次 ffmpeg（尺寸固定，不需要降质循环）", async () => {
  const fixture = await mediaFixture({ sizesKb: [120] });
  await fixture.service.prepareCoverImage(fixture.sourcePath, fixture.outDir);
  assert.equal((await fixture.calls()).length, 1);
  assert.deepEqual(await fixture.outDirEntries(), ["wechat-cover.jpg"]);
});

// ── 正文图：格式与限额 ────────────────────────────────────────────────────────

test("webp 输入也被转成 jpg（uploadimg 只支持 jpg/png）", async () => {
  const fixture = await mediaFixture({ sourceName: "素材图.webp", sizesKb: [300] });
  const result = await fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1);

  assert.equal(path.extname(result.path), ".jpg");
  assert.equal(path.basename(result.path), "01.jpg");
  // 输出名由服务端生成：不能带上源文件名（本项目「客户端提供的名字绝不参与路径拼接」的既有纪律）。
  assert.equal(result.path.includes("素材图"), false);
});

test("文件名按序号零填充（与图文包的 images/NN 同一套排序约定）", async () => {
  assert.equal(contentImageFileName(1), "01.jpg");
  assert.equal(contentImageFileName(12), "12.jpg");
  assert.equal(contentImageFileName(100), "100.jpg");
});

test("正文图小于 1MB 时一次到位", async () => {
  const fixture = await mediaFixture({ sizesKb: [300] });
  const result = await fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1);

  assert.ok(result.bytes < 1024 * 1024);
  assert.equal((await fixture.calls()).length, 1);
  assert.deepEqual(await fixture.outDirEntries(), ["01.jpg"]);
});

test("首次产出超 1MB 时循环降质，且第二次的画质参数更低", async () => {
  const fixture = await mediaFixture({ sizesKb: [2048, 300] });
  const result = await fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1);

  const calls = await fixture.calls();
  assert.equal(calls.length, 2, "应在首次超限后再试一次");
  const firstQuality = Number(argValue(calls[0], "-q:v"));
  const secondQuality = Number(argValue(calls[1], "-q:v"));
  assert.ok(
    secondQuality > firstQuality,
    `第二次应压低画质：first=${firstQuality} second=${secondQuality}`,
  );
  assert.ok(result.bytes < 1024 * 1024);
  // 中间产物必须清掉，只能留下最终那一张。
  assert.deepEqual(await fixture.outDirEntries(), ["01.jpg"]);
});

test("所有档位都压不到 1MB 时明确报错，并清掉半成品", async () => {
  const fixture = await mediaFixture({ sizesKb: [2048] });
  await assert.rejects(
    () => fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1),
    (error: unknown) => {
      assert.ok(error instanceof WechatMediaError);
      assert.equal(error.code, "wechat_media_too_large_after_compress");
      assert.match(error.message, /1MB|1 MB|1048576/u);
      return true;
    },
  );
  assert.deepEqual(await fixture.outDirEntries(), [], "失败后不该留下半成品");
});

// ── 源文件纪律 ────────────────────────────────────────────────────────────────

test("绝不改动源文件（前后 sha256 一致）", async () => {
  const fixture = await mediaFixture({ sizesKb: [2048, 300] });
  const before = await sha256(fixture.sourcePath);
  await fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1);
  await fixture.service.prepareCoverImage(fixture.sourcePath, fixture.outDir);
  assert.equal(await sha256(fixture.sourcePath), before);
});

test("源文件不存在时给出明确错误", async () => {
  const fixture = await mediaFixture();
  await assert.rejects(
    () => fixture.service.prepareContentImage(path.join(fixture.dir, "不见了.png"), fixture.outDir, 1),
    (error: unknown) => {
      assert.ok(error instanceof WechatMediaError);
      assert.equal(error.code, "wechat_media_source_missing");
      return true;
    },
  );
});

test("源图超过 20MB 时在处理前就拦掉（不启动 ffmpeg）", async () => {
  const fixture = await mediaFixture({ sourceBytes: MAX_SOURCE_IMAGE_BYTES + 1 });
  await assert.rejects(
    () => fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1),
    (error: unknown) => {
      assert.ok(error instanceof WechatMediaError);
      assert.equal(error.code, "wechat_media_source_too_large");
      return true;
    },
  );
  assert.deepEqual(await fixture.calls(), [], "超限输入不该白跑一次 ffmpeg");
});

test("ffmpeg 失败时抛明确错误，且不留半成品", async () => {
  const fixture = await mediaFixture({ fail: true });
  await assert.rejects(
    () => fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1),
    (error: unknown) => {
      assert.ok(error instanceof WechatMediaError);
      assert.equal(error.code, "wechat_media_ffmpeg_failed");
      return true;
    },
  );
  assert.deepEqual(await fixture.outDirEntries(), [], "ffmpeg 失败后不该留下半成品");
});

test("封面处理失败时同样不留半成品", async () => {
  const fixture = await mediaFixture({ fail: true });
  await assert.rejects(
    () => fixture.service.prepareCoverImage(fixture.sourcePath, fixture.outDir),
    (error: unknown) => {
      assert.ok(error instanceof WechatMediaError);
      assert.equal(error.code, "wechat_media_ffmpeg_failed");
      return true;
    },
  );
  assert.deepEqual(await fixture.outDirEntries(), [], "封面失败后不该留下半成品");
});

test("ffmpeg 未配置（空白字符串）时给出可执行的错误，且不启动任何进程", async () => {
  const fixture = await mediaFixture();
  const bare = new WechatMediaService({ ffmpegBinary: "   " });
  await assert.rejects(
    () => bare.prepareCoverImage(fixture.sourcePath, fixture.outDir),
    (error: unknown) => {
      assert.ok(error instanceof WechatMediaError);
      assert.equal(error.code, "wechat_media_ffmpeg_unavailable");
      assert.match(error.message, /ffmpeg/u);
      return true;
    },
  );
  assert.deepEqual(await fixture.outDirEntries(), []);
});

// ── 幂等与覆盖 ────────────────────────────────────────────────────────────────

test("重复处理同一序号会覆盖旧产物（不追加、不生成 01-1.jpg）", async () => {
  const fixture = await mediaFixture({ sizesKb: [300] });
  const first = await fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1);
  const second = await fixture.service.prepareContentImage(fixture.sourcePath, fixture.outDir, 1);
  assert.equal(first.path, second.path);
  assert.deepEqual(await fixture.outDirEntries(), ["01.jpg"]);
  assert.ok((await stat(second.path)).size > 0);
});
