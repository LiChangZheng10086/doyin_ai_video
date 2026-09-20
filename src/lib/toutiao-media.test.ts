/**
 * 今日头条封面处理测试。
 *
 * 全程用**假 command runner**（不跑真 ffmpeg、不联网、不碰用户的素材原图），
 * 断言的是「我们发出的指令」与「产物纪律」：
 *
 * - 滤镜必须是**等比放大到覆盖 1280×720 再居中裁切** —— 我们的场景静帧是 1080×1920 竖图，
 *   直接交给平台只会被系统随机裁（与公众号封面同理，spec §2）；
 * - 产物名必须是 `cover.jpg`（article 包目录约定）；
 * - 失败或超限时**删掉产物**，绝不在包目录里留半成品；
 * - **源文件只读**（前后 sha256 一致）。
 *
 * 另有一条用例守住「源图 20MB 上限」与 `wechat-media.ts` 同口径（同一批输入：静帧 / 素材库图片），
 * 防止两处数字悄悄漂移。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { MAX_SOURCE_IMAGE_BYTES as WECHAT_MAX_SOURCE_IMAGE_BYTES } from "./wechat-media.js";
import {
  MAX_SOURCE_IMAGE_BYTES,
  TOUTIAO_COVER_FILE_NAME,
  ToutiaoMediaError,
  ToutiaoMediaService,
} from "./toutiao-media.js";
import { TOUTIAO_ARTICLE_LIMITS } from "./toutiao-article.js";

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = "toutiao-media-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface RunCall {
  command: string;
  args: string[];
}

function fakeRunner(options: { bytes?: number; fail?: boolean; noOutput?: boolean } = {}) {
  const calls: RunCall[] = [];
  return {
    calls,
    runner: {
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        const target = args[args.length - 1]!;
        if (options.fail && !options.noOutput) {
          // 先写出产物再失败：否则「失败要删产物」这条断言等于没测。
          await writeFile(target, Buffer.alloc(options.bytes ?? 8));
          throw new Error("ffmpeg 退出码 1");
        }
        if (options.fail) throw new Error("ffmpeg 退出码 1");
        if (!options.noOutput) await writeFile(target, Buffer.alloc(options.bytes ?? 8));
        return { stdout: "", stderr: "" };
      },
    },
  };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

test("封面指令：等比覆盖 1280×720 后居中裁切，产物名 cover.jpg", async () => {
  const dir = await tempDir();
  const source = path.join(dir, "frame-00-at-3s.png");
  await writeFile(source, "fake-png");
  const { calls, runner } = fakeRunner({ bytes: 1024 });

  const service = new ToutiaoMediaService({ ffmpegBinary: "ffmpeg", commandRunner: runner });
  const result = await service.prepareCoverImage(source, path.join(dir, "package"));

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.command, "ffmpeg");
  assert.ok(call!.args.includes(source), "源路径应作为 -i 的输入");
  const filter = call!.args[call!.args.indexOf("-vf") + 1]!;
  assert.equal(
    filter,
    `scale=${TOUTIAO_ARTICLE_LIMITS.coverWidth}:${TOUTIAO_ARTICLE_LIMITS.coverHeight}:force_original_aspect_ratio=increase,crop=${TOUTIAO_ARTICLE_LIMITS.coverWidth}:${TOUTIAO_ARTICLE_LIMITS.coverHeight}`,
  );
  assert.equal(call!.args[call!.args.length - 1], path.join(dir, "package", TOUTIAO_COVER_FILE_NAME));
  assert.equal(result.path, path.join(dir, "package", TOUTIAO_COVER_FILE_NAME));
  assert.equal(result.bytes, 1024);
});

test("缺省用 PATH 里的 ffmpeg（与 media.ts / wechat-media.ts 同一口径）", async () => {
  const dir = await tempDir();
  const source = path.join(dir, "cover.png");
  await writeFile(source, "fake-png");
  const { calls, runner } = fakeRunner();

  await new ToutiaoMediaService({ commandRunner: runner }).prepareCoverImage(source, dir);
  assert.equal(calls[0]!.command, "ffmpeg");
});

test("ffmpeg 退出码 0 但没产出文件时报错（不能当成 0 字节的成功）", async () => {
  const dir = await tempDir();
  const source = path.join(dir, "cover.png");
  await writeFile(source, "fake-png");
  const { runner } = fakeRunner({ noOutput: true });

  await assert.rejects(
    () => new ToutiaoMediaService({ commandRunner: runner }).prepareCoverImage(source, dir),
    (error: unknown) => error instanceof ToutiaoMediaError && error.code === "toutiao_media_ffmpeg_failed",
  );
});

test("ffmpeg 失败时删掉半成品，不在包目录里留垃圾", async () => {
  const dir = await tempDir();
  const source = path.join(dir, "cover.png");
  await writeFile(source, "fake-png");
  const outDir = path.join(dir, "package");
  const { runner } = fakeRunner({ fail: true });

  await assert.rejects(
    () => new ToutiaoMediaService({ commandRunner: runner }).prepareCoverImage(source, outDir),
    (error: unknown) => error instanceof ToutiaoMediaError && error.code === "toutiao_media_ffmpeg_failed",
  );
  await assert.rejects(() => stat(path.join(outDir, TOUTIAO_COVER_FILE_NAME)));
});

test("产物超过 10MB 上限时报错并删产物", async () => {
  const dir = await tempDir();
  const source = path.join(dir, "cover.png");
  await writeFile(source, "fake-png");
  const outDir = path.join(dir, "package");
  const { runner } = fakeRunner({ bytes: TOUTIAO_ARTICLE_LIMITS.coverBytes + 1 });

  await assert.rejects(
    () => new ToutiaoMediaService({ commandRunner: runner }).prepareCoverImage(source, outDir),
    (error: unknown) =>
      error instanceof ToutiaoMediaError && error.code === "toutiao_media_too_large_after_compress",
  );
  await assert.rejects(() => stat(path.join(outDir, TOUTIAO_COVER_FILE_NAME)));
});

test("源文件不存在 / 不是文件 / 超过 20MB 上限时明确报错，且不调用 ffmpeg", async () => {
  const dir = await tempDir();
  const { calls, runner } = fakeRunner();
  const service = new ToutiaoMediaService({ commandRunner: runner });

  await assert.rejects(
    () => service.prepareCoverImage(path.join(dir, "nope.png"), dir),
    (error: unknown) => error instanceof ToutiaoMediaError && error.code === "toutiao_media_source_missing",
  );
  await assert.rejects(
    () => service.prepareCoverImage(dir, dir),
    (error: unknown) => error instanceof ToutiaoMediaError && error.code === "toutiao_media_source_missing",
  );

  const huge = path.join(dir, "huge.png");
  await writeFile(huge, "");
  await truncate(huge, MAX_SOURCE_IMAGE_BYTES + 1);
  await assert.rejects(
    () => service.prepareCoverImage(huge, dir),
    (error: unknown) => error instanceof ToutiaoMediaError && error.code === "toutiao_media_source_too_large",
  );

  assert.equal(calls.length, 0, "输入不合法时不该启动 ffmpeg");
});

test("源文件只读：处理前后 sha256 一致", async () => {
  const dir = await tempDir();
  const source = path.join(dir, "frame.png");
  const bytes = Buffer.from("fake-png-bytes");
  await writeFile(source, bytes);
  const before = sha256(await readFile(source));

  const { runner } = fakeRunner({ bytes: 64 });
  await new ToutiaoMediaService({ commandRunner: runner }).prepareCoverImage(source, dir);

  assert.equal(sha256(await readFile(source)), before);
});

test("ffmpegBinary 传空白字符串时给明确安装指引（不静默回退 PATH）", async () => {
  const dir = await tempDir();
  const source = path.join(dir, "cover.png");
  await writeFile(source, "fake-png");
  const { calls, runner } = fakeRunner();

  await assert.rejects(
    () => new ToutiaoMediaService({ ffmpegBinary: "  ", commandRunner: runner }).prepareCoverImage(source, dir),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoMediaError);
      assert.equal(error.code, "toutiao_media_ffmpeg_unavailable");
      assert.match(error.message, /ffmpeg/u);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("源图 20MB 上限与 wechat-media 同口径（同一批输入，别让两处数字漂移）", () => {
  assert.equal(MAX_SOURCE_IMAGE_BYTES, WECHAT_MAX_SOURCE_IMAGE_BYTES);
  assert.equal(MAX_SOURCE_IMAGE_BYTES, 20 * 1024 * 1024);
});
