/**
 * 小红书笔记配图（3:4 裁切）测试。
 *
 * 全程用**假 command runner**（不跑真 ffmpeg、不碰用户的素材原图），断言的是
 * 「我们发出的指令」与「产物纪律」：
 *
 * - 滤镜必须是**等比放大到覆盖 1080×1440 再居中裁切** —— 我们的场景静帧是 1080×1920（9:16），
 *   而平台发布页原文写着「不限制宽高比例，推荐上传 **3:4 至 2:1 之间**」（2026-09-20 实测），
 *   9:16 ≈ 0.5625 **落在推荐区间之外**，直接传会被裁切或留白；
 * - 产物名必须**带序号且补零**（图文包的图片顺序就是内容顺序，名字必须稳定可预期）；
 * - 失败或超限时**删掉产物**，绝不在包目录里留半成品；
 * - **源文件只读**（Step 4 会用真实 ffmpeg 验证前后 sha256 一致）。
 *
 * 另有一条用例守住「源图 20MB 上限」与 `toutiao-media.ts` / `wechat-media.ts` 同口径
 *（同一批输入：场景静帧 / 素材库图片），防止几处数字悄悄漂移。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runCommand } from "./command.js";
import { MAX_SOURCE_IMAGE_BYTES as TOUTIAO_MAX_SOURCE_IMAGE_BYTES } from "./toutiao-media.js";
import {
  MAX_SOURCE_IMAGE_BYTES,
  NOTE_IMAGE_LIMITS,
  NoteMediaError,
  NoteMediaService,
  noteImageFileName,
} from "./note-media.js";

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = "note-media-"): Promise<string> {
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

async function sourceImage(dir: string, name = "frame-01.png"): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, Buffer.alloc(64, 7));
  return target;
}

test("滤镜是「等比放大到覆盖 1080×1440 再居中裁切」，且产物名带补零序号", async () => {
  const dir = await tempDir();
  const source = await sourceImage(dir);
  const { runner, calls } = fakeRunner();

  const service = new NoteMediaService({ commandRunner: runner });
  const result = await service.prepareNoteImage(source, path.join(dir, "out"), 3);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, [
    "-y",
    "-i",
    source,
    "-vf",
    "scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440",
    "-frames:v",
    "1",
    result.path,
  ]);
  assert.equal(path.basename(result.path), "note-03.png");
  assert.equal(path.dirname(result.path), path.join(dir, "out"));
  assert.equal(result.bytes, 8);
});

test("产物名：序号一律补到两位（保证字典序 == 场景序），且是 PNG", () => {
  assert.equal(noteImageFileName(1), "note-01.png");
  assert.equal(noteImageFileName(9), "note-09.png");
  assert.equal(noteImageFileName(10), "note-10.png");
  assert.equal(noteImageFileName(18), "note-18.png");
  // 越界序号是调用方的问题，这里只要求它仍产出稳定名字，不抛。
  assert.equal(noteImageFileName(0), "note-00.png");
});

test("ffmpeg 退出码 0 但**没产出文件** → 报错（不许当成 0 字节的成功）", async () => {
  const dir = await tempDir();
  const source = await sourceImage(dir);
  const { runner } = fakeRunner({ noOutput: true });

  await assert.rejects(
    () => new NoteMediaService({ commandRunner: runner }).prepareNoteImage(source, path.join(dir, "out"), 1),
    (error: unknown) =>
      error instanceof NoteMediaError &&
      error.code === "note_media_ffmpeg_failed" &&
      error.message.includes("没有产出图片文件"),
  );
});

test("ffmpeg 失败时**删掉半成品**，不在包目录里留垃圾", async () => {
  const dir = await tempDir();
  const source = await sourceImage(dir);
  const outDir = path.join(dir, "out");
  const { runner } = fakeRunner({ fail: true });

  await assert.rejects(
    () => new NoteMediaService({ commandRunner: runner }).prepareNoteImage(source, outDir, 1),
    (error: unknown) => error instanceof NoteMediaError && error.code === "note_media_ffmpeg_failed",
  );

  await assert.rejects(
    () => stat(path.join(outDir, noteImageFileName(1))),
    "失败的产物必须被删掉",
  );
});

test("产物超过 32MB 上限 → 报错并删掉产物", async () => {
  const dir = await tempDir();
  const source = await sourceImage(dir);
  const outDir = path.join(dir, "out");
  const { runner } = fakeRunner({ bytes: NOTE_IMAGE_LIMITS.maxBytes + 1 });

  await assert.rejects(
    () => new NoteMediaService({ commandRunner: runner }).prepareNoteImage(source, outDir, 1),
    (error: unknown) =>
      error instanceof NoteMediaError &&
      error.code === "note_media_too_large_after_compress" &&
      error.message.includes("32MB"),
  );
  await assert.rejects(() => stat(path.join(outDir, noteImageFileName(1))), "超限产物必须被删掉");
});

test("源图缺失 / 不是文件 → note_media_source_missing", async () => {
  const dir = await tempDir();
  const { runner } = fakeRunner();
  const service = new NoteMediaService({ commandRunner: runner });

  await assert.rejects(
    () => service.prepareNoteImage(path.join(dir, "不存在.png"), path.join(dir, "out"), 1),
    (error: unknown) => error instanceof NoteMediaError && error.code === "note_media_source_missing",
  );
  await assert.rejects(
    () => service.prepareNoteImage(dir, path.join(dir, "out"), 1),
    (error: unknown) => error instanceof NoteMediaError && error.code === "note_media_source_missing",
  );
});

test("源图超过 20MB 处理上限 → note_media_source_too_large（与头条/公众号同口径）", async () => {
  const dir = await tempDir();
  const { runner } = fakeRunner();
  const service = new NoteMediaService({ commandRunner: runner });

  // 用稀疏文件造一个「大文件」，不真的写 20MB 数据。
  const big = path.join(dir, "big.png");
  await writeFile(big, Buffer.alloc(1));
  const { truncate } = await import("node:fs/promises");
  await truncate(big, MAX_SOURCE_IMAGE_BYTES + 1);

  await assert.rejects(
    () => service.prepareNoteImage(big, path.join(dir, "out"), 1),
    (error: unknown) =>
      error instanceof NoteMediaError &&
      error.code === "note_media_source_too_large" &&
      error.message.includes("20MB"),
  );

  // ⚠️ 同口径守卫：三处（wechat / toutiao / xhs）处理的是同一批输入，数字不许漂。
  assert.equal(MAX_SOURCE_IMAGE_BYTES, TOUTIAO_MAX_SOURCE_IMAGE_BYTES);
});

test("ffmpegBinary 传空白字符串 → note_media_ffmpeg_unavailable + 可照抄的动作", async () => {
  const dir = await tempDir();
  const source = await sourceImage(dir);
  const { runner, calls } = fakeRunner();

  await assert.rejects(
    () => new NoteMediaService({ commandRunner: runner, ffmpegBinary: "   " }).prepareNoteImage(source, path.join(dir, "out"), 1),
    (error: unknown) =>
      error instanceof NoteMediaError &&
      error.code === "note_media_ffmpeg_unavailable" &&
      error.message.includes("ffmpeg") &&
      error.message.includes("重启后端"),
  );
  assert.deepEqual(calls, [], "配置不对时**一个进程都不该起**");
});

test("目标口径常量：1080×1440（3:4）/ 单图 32MB", () => {
  assert.equal(NOTE_IMAGE_LIMITS.width, 1080);
  assert.equal(NOTE_IMAGE_LIMITS.height, 1440);
  assert.equal(NOTE_IMAGE_LIMITS.width / NOTE_IMAGE_LIMITS.height, 0.75, "必须是 3:4");
  assert.equal(NOTE_IMAGE_LIMITS.maxBytes, 32 * 1024 * 1024);

  // ⚠️ 这里**不该**出现平台专属的数字。张数上限 18 与格式白名单（png/jpg/jpeg/webp）
  // 属于**小红书那一侧的闸门**（`xhs-page.ts` 的 XHS_MAX_IMAGES + 发布页校验），
  // 把它们混进这个平台中立的模块，会让「为什么纯抖音的图文包受小红书限制」变成必然的困惑。
  assert.deepEqual(Object.keys(NOTE_IMAGE_LIMITS).sort(), ["height", "maxBytes", "width"]);
});

test("本模块是平台中立的：文件名/导出名都不带平台前缀", async () => {
  const module = await import("./note-media.js");
  const exported = Object.keys(module);
  assert.equal(
    exported.some((name) => /xhs|douyin|toutiao/i.test(name)),
    false,
    `平台中立的模块不该导出平台专属的名字：${exported.join(", ")}`,
  );
});

/**
 * **真实 ffmpeg 端到端**：证明「我们的场景静帧（9:16）裁出来就是 1080×1440」。
 *
 * 为什么单独一条：上面的用例全部用假 runner，只能证明「我们发出的指令」——
 * **stub 会接受任何 argv，滤镜语法对不对它证明不了**（公众号那轮的教训）。
 * 这条真的跑 ffmpeg + ffprobe，断言的是**产物本身**。
 *
 * 没有 ffmpeg 时跳过（与 `RUN_HYPERFRAMES_INTEGRATION` 同一惯例）。
 */
const hasFfmpeg = await (async () => {
  try {
    await runCommand(process.env.FFMPEG_BINARY ?? "ffmpeg", ["-version"], { captureStdout: true, timeoutMs: 20_000 });
    await runCommand(process.env.FFPROBE_BINARY ?? "ffprobe", ["-version"], { captureStdout: true, timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

test("真实 ffmpeg：1080×1920 的静帧裁出 **1080×1440**（3:4），源文件不被改动", { skip: hasFfmpeg ? false : "本机没有 ffmpeg/ffprobe" }, async () => {
  const dir = await tempDir("note-media-real-");
  const source = path.join(dir, "frame.png");
  await runCommand(process.env.FFMPEG_BINARY ?? "ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc2=s=1080x1920", "-frames:v", "1", source,
  ], { captureStderr: true, timeoutMs: 60_000 });

  const before = createHash("sha256").update(await readFile(source)).digest("hex");
  const result = await new NoteMediaService().prepareNoteImage(source, path.join(dir, "out"), 1);

  const probed = await runCommand(process.env.FFPROBE_BINARY ?? "ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", result.path,
  ], { captureStdout: true, captureStderr: true, timeoutMs: 60_000 });
  assert.equal(probed.stdout.trim(), "png,1080,1440", "必须是无损 PNG 且正好 1080×1440");

  const after = createHash("sha256").update(await readFile(source)).digest("hex");
  assert.equal(after, before, "源文件必须只读（前后 sha256 一致）");
  // 产物远低于平台 32MB 上限 —— 用真实文件确认一次，别只信常量。
  assert.equal(result.bytes < NOTE_IMAGE_LIMITS.maxBytes, true);
});
