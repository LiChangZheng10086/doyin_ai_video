import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile as fsCopyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename as fsRename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  ActorSnapshot,
  DeliveryPackage,
  PublishTask,
  PublishingIndex,
  PublishingPackageDetail,
} from "../types.js";
import {
  PublishingAssetError,
  PublishingAssetService,
  collectSceneSnapshots,
  type ArticlePackageAssetInput,
  type NotePackageAssetInput,
  type PackageAssetInput,
} from "./publishing-assets.js";

const NOW = new Date("2026-08-10T08:00:00.000Z");
const ACTOR: ActorSnapshot = { userId: "user-1", displayName: "发布员", role: "publisher" };

function task(
  id: string,
  platform: PublishTask["platform"],
  packageId = "package-1",
): PublishTask {
  return {
    id,
    packageId,
    platform,
    title: `${platform} 标题`,
    description: `${platform} 正文`,
    hashtags: ["内容创作", "效率"],
    copySource: "ai",
    status: "ready",
    contentRevision: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

async function fixture(overrides: Partial<PackageAssetInput> = {}) {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "publishing-assets-"));
  const sourceVideoPath = path.join(storageRoot, "output", "videos", "job-1", "video.mp4");
  await mkdir(path.dirname(sourceVideoPath), { recursive: true });
  await writeFile(sourceVideoPath, Buffer.from("source mp4 bytes"));
  return {
    storageRoot,
    input: {
      packageId: "package-1",
      sourceJobId: "job-1",
      version: 1,
      sourceVideoPath,
      title: "发布包标题",
      tasks: [task("task-douyin", "douyin"), task("task-bilibili", "bilibili")],
      actor: ACTOR,
      ...overrides,
    } satisfies PackageAssetInput,
  };
}

function interceptHandleReads(
  handle: Awaited<ReturnType<typeof open>>,
  beforeRead: (position: number) => Promise<void>,
): Awaited<ReturnType<typeof open>> {
  return new Proxy(handle, {
    get(target, property) {
      if (property === "read") {
        return async (buffer: Buffer, offset: number, length: number, position: number) => {
          await beforeRead(position);
          return target.read(buffer, offset, length, position);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else files.push(path.relative(root, fullPath));
    }
  }
  await visit(root);
  return files.sort();
}

async function directoryBytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const relativePath of await listFiles(root)) {
    result[relativePath] = (await readFile(path.join(root, relativePath))).toString("base64");
  }
  return result;
}

function packageRecord(
  result: Awaited<ReturnType<PublishingAssetService["createPackageAssets"]>>,
  overrides: Partial<DeliveryPackage> = {},
): DeliveryPackage {
  return {
    id: "package-1",
    sourceJobId: "job-1",
    version: 1,
    state: "active",
    title: "发布包标题",
    packagePath: result.packagePath,
    videoPath: result.videoPath,
    coverPath: result.coverPath,
    videoSha256: result.videoSha256,
    videoSize: result.videoSize,
    videoMethod: result.videoMethod,
    assetHealth: result.assetHealth,
    createdBy: ACTOR,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** 合法最小 1×1 PNG（IHDR + IDAT + IEND，CRC 正确）。 */
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** 每个场景一张「静帧」：最小 PNG + 一个区分字节，便于断言「改了哪一张」。 */
function frameBytes(seed: number): Buffer {
  return Buffer.concat([MINIMAL_PNG, Buffer.from([seed])]);
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 各图 sha256 有序拼接后再哈希 —— 测试内独立重算，不复用被测实现。 */
function manifestHashOf(hashes: string[]): string {
  return createHash("sha256").update(hashes.join("\n")).digest("hex");
}

function noteInput(overrides: Partial<NotePackageAssetInput> = {}): NotePackageAssetInput {
  return {
    packageId: "package-1",
    sourceJobId: "job-1",
    version: 1,
    noteCopy: { title: "抖音图文标题", description: "抖音图文正文", hashtags: ["内容创作", "效率"] },
    title: "发布包标题",
    tasks: [task("task-douyin", "douyin")],
    actor: ACTOR,
    ...overrides,
  };
}

/** 换包号/版本时必须同时换 tasks 的 packageId（`validateProjectionTasks` 校验任务归属）。 */
function noteInputFor(
  packageId: string,
  version: number,
  overrides: Partial<NotePackageAssetInput> = {},
): NotePackageAssetInput {
  return noteInput({
    packageId,
    version,
    tasks: [task(`task-${packageId}`, "douyin", packageId)],
    ...overrides,
  });
}

async function emptyNoteStorageRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "publishing-notes-empty-")));
}

async function noteFixture() {
  const storageRoot = await emptyNoteStorageRoot();
  const snapshotsDirectory = path.join(
    storageRoot,
    "output",
    "videos",
    "job-1",
    "hyperframes",
    "snapshots",
  );
  await mkdir(snapshotsDirectory, { recursive: true });
  const snapshots = {
    frame00: path.join(snapshotsDirectory, "frame-00-at-3s.png"),
    frame01: path.join(snapshotsDirectory, "frame-01-at-9s.png"),
    frame02: path.join(snapshotsDirectory, "frame-02-at-15s.png"),
  };
  await writeFile(snapshots.frame00, frameBytes(0));
  await writeFile(snapshots.frame01, frameBytes(1));
  await writeFile(snapshots.frame02, frameBytes(2));
  // snapshot 目录里还有非场景产物：字典序排在 frame-* 之前，必须被排除。
  await writeFile(path.join(snapshotsDirectory, "contact-sheet-1.jpg"), frameBytes(9));
  await writeFile(path.join(snapshotsDirectory, "contact-sheet-2.jpg"), frameBytes(9));
  return { storageRoot, snapshotsDirectory, snapshots, input: noteInput() };
}

function notePackageRecord(
  result: Awaited<ReturnType<PublishingAssetService["createNotePackageAssets"]>>,
  overrides: Partial<DeliveryPackage> = {},
): DeliveryPackage {
  return {
    id: "package-1",
    sourceJobId: "job-1",
    version: 1,
    state: "active",
    title: "发布包标题",
    packagePath: result.packagePath,
    // note 包的 video* 字段「不适用」，用图片清单哈希充当等价完整性凭据。
    videoSha256: result.imageManifestSha256,
    videoSize: result.imageSize,
    videoMethod: "copy",
    assetHealth: result.assetHealth,
    contentType: "note",
    imagePaths: [...result.imagePaths],
    noteCopy: { title: "抖音图文标题", description: "抖音图文正文", hashtags: ["内容创作", "效率"] },
    createdBy: ACTOR,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function noteService(storageRoot: string): PublishingAssetService {
  return new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("图文打包不应调用任何外部命令"); },
  });
}

test("packages one cloned MP4 with safe manifest and shared platform projections", async () => {
  const { storageRoot, input } = await fixture();
  const copyModes: number[] = [];
  (input.actor as ActorSnapshot & { apiKey: string }).apiKey = "must-not-be-projected";
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    copyFile: async (source, destination, mode = 0) => {
      copyModes.push(mode);
      await fsCopyFile(source, destination, constants.COPYFILE_EXCL);
    },
    runCommand: async (_command, args) => {
      await writeFile(args.at(-1)!, "cover bytes");
      return { stdout: "", stderr: "" };
    },
  });

  const result = await service.createPackageAssets(input);
  const files = await listFiles(result.packagePath);
  const manifest = JSON.parse(await readFile(path.join(result.packagePath, "manifest.json"), "utf8")) as {
    tasks: Array<{ videoPath: string }>;
  };

  assert.equal(result.videoMethod, "clone");
  assert.equal(copyModes[0], constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  assert.equal(files.filter((file) => file.endsWith(".mp4")).length, 1);
  assert.equal(files.filter((file) => path.basename(file) === "video.mp4").length, 1);
  assert.deepEqual(manifest.tasks.map((entry) => entry.videoPath), ["video.mp4", "video.mp4"]);
  for (const platform of ["douyin", "bilibili"]) {
    assert.deepEqual(
      files.filter((file) => file.startsWith(`platforms/${platform}/`)).map((file) => path.basename(file)),
      ["description.txt", "hashtags.txt", "publish.txt", "title.txt"],
    );
  }
  assert.doesNotMatch(JSON.stringify(manifest), /api.?key|cookie|password|pin(hash|salt)?|secret|token/iu);
  assert.doesNotMatch(files.join("\n"), /api.?key|cookie|password|pin|secret|token/iu);
});

test("accepts the shared resolver canonical source path", async () => {
  const { storageRoot, input } = await fixture();
  input.sourceVideoPath = await realpath(input.sourceVideoPath);
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });

  const result = await service.createPackageAssets(input);

  assert.deepEqual(await readFile(result.videoPath), Buffer.from("source mp4 bytes"));
});

test("packages the resolver-bound source inode after its path is replaced", async () => {
  const { storageRoot, input } = await fixture();
  input.sourceVideoPath = await realpath(input.sourceVideoPath);
  const handle = await open(input.sourceVideoPath, "r");
  const opened = await handle.stat();
  const original = await readFile(input.sourceVideoPath);
  await fsRename(input.sourceVideoPath, `${input.sourceVideoPath}.original`);
  await writeFile(input.sourceVideoPath, "replacement video bytes");
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });

  try {
    const result = await service.createPackageAssets({
      ...input,
      sourceVideo: {
        path: input.sourceVideoPath,
        handle,
        size: opened.size,
        identity: { dev: opened.dev, ino: opened.ino },
      },
    } as PackageAssetInput);
    assert.deepEqual(await readFile(result.videoPath), original);
  } finally {
    await handle.close();
  }
});

test("extracts the cover from the packaged video when the source path was replaced", async () => {
  const { storageRoot, input } = await fixture();
  input.sourceVideoPath = await realpath(input.sourceVideoPath);
  const handle = await open(input.sourceVideoPath, "r");
  const opened = await handle.stat();
  const original = await readFile(input.sourceVideoPath);
  await fsRename(input.sourceVideoPath, `${input.sourceVideoPath}.original`);
  await writeFile(input.sourceVideoPath, "replacement video bytes");
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async (_command, args) => {
      await writeFile(args.at(-1)!, await readFile(args[4]));
      return { stdout: "", stderr: "" };
    },
  });

  try {
    const result = await service.createPackageAssets({
      ...input,
      sourceVideo: {
        path: input.sourceVideoPath,
        handle,
        size: opened.size,
        identity: { dev: opened.dev, ino: opened.ino },
      },
    });
    assert.deepEqual(await readFile(result.videoPath), original);
    assert.deepEqual(await readFile(result.coverPath!), original);
  } finally {
    await handle.close();
  }
});

test("rejects a runtime platform path escape before writing package assets", async () => {
  const { storageRoot, input } = await fixture({
    tasks: [{ ...task("task-escape", "douyin"), platform: "../../escaped" as PublishTask["platform"] }],
  });
  const service = new PublishingAssetService({ storageRoot, now: () => NOW });

  await assert.rejects(service.createPackageAssets(input), (error: unknown) => {
    assert.ok(error instanceof PublishingAssetError);
    assert.equal(error.code, "publish_video_unreadable");
    return true;
  });
  await assert.rejects(stat(path.join(storageRoot, "output", "publishing", "job-1", "escaped")), { code: "ENOENT" });
});

test("falls back to ordinary copy when APFS clone is unavailable", async () => {
  const { storageRoot, input } = await fixture();
  const modes: number[] = [];
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    copyFile: async (source, destination, mode = 0) => {
      modes.push(mode);
      if (mode & constants.COPYFILE_FICLONE) throw Object.assign(new Error("clone unavailable"), { code: "ENOTSUP" });
      await fsCopyFile(source, destination, mode);
    },
    runCommand: async () => { throw new Error("ffmpeg unavailable"); },
  });

  const result = await service.createPackageAssets(input);

  assert.equal(result.videoMethod, "copy");
  assert.equal(Boolean(modes[0] & constants.COPYFILE_FICLONE), true);
  assert.equal(modes[1], constants.COPYFILE_EXCL);
  assert.deepEqual(await readFile(result.videoPath), await readFile(input.sourceVideoPath));
  assert.equal(result.assetHealth, "missing_cover");
});

test("removes temporary assets and never exposes a formal directory when handle copy fails", async () => {
  const { storageRoot, input } = await fixture();
  input.sourceVideoPath = await realpath(input.sourceVideoPath);
  const handle = await open(input.sourceVideoPath, "r");
  const opened = await handle.stat();
  let readsFromStart = 0;
  const failingHandle = interceptHandleReads(handle, async (position) => {
    readsFromStart += position === 0 ? 1 : 0;
    if (readsFromStart === 2) throw Object.assign(new Error("disk failure"), { code: "EIO" });
  });
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    copyFile: async () => { throw Object.assign(new Error("copy failed"), { code: "EIO" }); },
  });

  try {
    await assert.rejects(service.createPackageAssets({
      ...input,
      sourceVideo: {
        path: input.sourceVideoPath,
        handle: failingHandle,
        size: opened.size,
        identity: { dev: opened.dev, ino: opened.ino },
      },
    }), (error: unknown) => {
      assert.ok(error instanceof PublishingAssetError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "publish_clone_failed");
      assert.equal(error.message, "成片复制失败，请检查磁盘空间和文件权限");
      return true;
    });
  } finally {
    await handle.close();
  }

  const sourceDirectory = path.join(storageRoot, "output", "publishing", input.sourceJobId);
  const entries = await readdir(sourceDirectory).catch(() => []);
  assert.deepEqual(entries, []);
});

test("maps setup storage failures to a stable Simplified Chinese error", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    rm: async () => { throw Object.assign(new Error("device full"), { code: "ENOSPC" }); },
  });

  await assert.rejects(service.createPackageAssets(input), (error: unknown) => {
    assert.ok(error instanceof PublishingAssetError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "publish_storage_full");
    assert.equal(error.message, "存储空间不足，无法创建发布包");
    return true;
  });
});

test("returned rollback removes a promoted package without touching the source video", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);

  await result.rollback();
  await result.rollback();

  await assert.rejects(stat(result.packagePath), { code: "ENOENT" });
  assert.deepEqual(await readFile(input.sourceVideoPath), Buffer.from("source mp4 bytes"));
});

test("post-promotion failure removes only the package inode promoted by this create", async () => {
  const { storageRoot, input } = await fixture();
  const packagePath = path.join(
    await realpath(storageRoot),
    "output",
    "publishing",
    input.sourceJobId,
    `v${input.version}-${input.packageId}`,
  );
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    rename: async (source, destination) => {
      await fsRename(source, destination);
      if (destination.toString() === packagePath) throw new Error("post-promotion identity failure");
    },
    runCommand: async () => { throw new Error("no cover"); },
  });

  await assert.rejects(service.createPackageAssets(input));
  await assert.rejects(stat(packagePath), { code: "ENOENT" });
  assert.deepEqual(await readFile(input.sourceVideoPath), Buffer.from("source mp4 bytes"));
});

test("rejects a pre-existing source publishing directory symlink without touching outside bytes", async () => {
  const { storageRoot, input } = await fixture();
  const publishingRoot = path.join(storageRoot, "output", "publishing");
  const outside = await mkdtemp(path.join(tmpdir(), "publishing-parent-outside-"));
  await writeFile(path.join(outside, "sentinel.bin"), Buffer.from([0, 1, 2, 255]));
  const before = await directoryBytes(outside);
  await mkdir(publishingRoot, { recursive: true });
  await symlink(outside, path.join(publishingRoot, input.sourceJobId), "dir");
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });

  await assert.rejects(service.createPackageAssets(input), (error: unknown) => {
    assert.ok(error instanceof PublishingAssetError);
    assert.equal(error.code, "publish_video_unreadable");
    return true;
  });
  assert.deepEqual(await directoryBytes(outside), before);
});

test("rejects a bound source whose expected identity does not match its handle", async () => {
  const { storageRoot, input } = await fixture();
  input.sourceVideoPath = await realpath(input.sourceVideoPath);
  const handle = await open(input.sourceVideoPath, "r");
  const opened = await handle.stat();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });

  try {
    await assert.rejects(service.createPackageAssets({
      ...input,
      sourceVideo: {
        path: input.sourceVideoPath,
        handle,
        size: opened.size,
        identity: { dev: opened.dev, ino: opened.ino + 1 },
      },
    }), (error: unknown) => {
      assert.ok(error instanceof PublishingAssetError);
      assert.equal(error.code, "publish_video_unreadable");
      return true;
    });
  } finally {
    await handle.close();
  }
  const publishingSource = path.join(storageRoot, "output", "publishing", input.sourceJobId);
  assert.deepEqual(await readdir(publishingSource).catch(() => []), []);
});

test("destination parent symlink swap cannot modify existing outside bytes", async () => {
  const { storageRoot, input } = await fixture();
  input.sourceVideoPath = await realpath(input.sourceVideoPath);
  const outside = await mkdtemp(path.join(tmpdir(), "publishing-destination-race-"));
  await writeFile(path.join(outside, "video.mp4"), "existing outside video");
  await writeFile(path.join(outside, "sentinel.bin"), Buffer.from([0, 1, 2, 255]));
  const outsideBefore = await directoryBytes(outside);
  const sourceHandle = await open(input.sourceVideoPath, "r");
  const opened = await sourceHandle.stat();
  let readsFromStart = 0;
  const boundHandle = interceptHandleReads(sourceHandle, async (position) => {
    readsFromStart += position === 0 ? 1 : 0;
    if (readsFromStart === 2) {
      const parent = path.join(storageRoot, "output", "publishing", input.sourceJobId, `.next-${input.packageId}`);
      await fsRename(parent, `${parent}.held`);
      await symlink(outside, parent, "dir");
    }
  });
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });

  try {
    await assert.rejects(service.createPackageAssets({
      ...input,
      sourceVideo: {
        path: input.sourceVideoPath,
        handle: boundHandle,
        size: opened.size,
        identity: { dev: opened.dev, ino: opened.ino },
      },
    }), (error: unknown) => {
      assert.ok(error instanceof PublishingAssetError);
      assert.equal(error.code, "publish_video_unreadable");
      return true;
    });
    const sourceDirectory = path.join(await realpath(storageRoot), "output", "publishing", input.sourceJobId);
    assert.equal((await readdir(sourceDirectory)).some((entry) => entry.startsWith("v1-")), false);
    assert.deepEqual(await directoryBytes(outside), outsideBefore);
  } finally {
    await sourceHandle.close();
  }
});

test("reuses a readable local cover without invoking FFmpeg", async () => {
  const { storageRoot, input } = await fixture();
  const sourceCoverPath = path.join(storageRoot, "output", "covers", "job-1.jpg");
  await mkdir(path.dirname(sourceCoverPath), { recursive: true });
  await writeFile(sourceCoverPath, "local cover bytes");
  input.sourceCoverPath = sourceCoverPath;
  let commands = 0;
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => {
      commands += 1;
      throw new Error("must not run");
    },
  });

  const result = await service.createPackageAssets(input);

  assert.equal(commands, 0);
  assert.equal(result.assetHealth, "healthy");
  assert.deepEqual(await readFile(result.coverPath!), await readFile(sourceCoverPath));
  assert.deepEqual(await service.readPackageCover(packageRecord(result)), await readFile(sourceCoverPath));
});

test("keeps the package usable with missing_cover when FFmpeg extraction fails", async () => {
  const { storageRoot, input } = await fixture();
  const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async (command, args, options) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      throw new Error("extract failed");
    },
  });

  const result = await service.createPackageAssets(input);

  assert.equal(result.assetHealth, "missing_cover");
  assert.equal(result.coverPath, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ffmpeg");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-y", "-ss", "1", "-i"]);
  assert.match(calls[0].args[4], /\.next-package-1[\\/]video\.mp4$/u);
  await assert.rejects(stat(path.join(result.packagePath, "cover.jpg")), { code: "ENOENT" });
});

test("projection commit swaps all text and rollback restores exact prior bytes", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const platformsPath = path.join(result.packagePath, "platforms");
  await writeFile(path.join(platformsPath, "douyin", "legacy.bin"), Buffer.from([0, 1, 2, 255]));
  const before = await directoryBytes(platformsPath);
  const changedTasks = input.tasks.map((entry) => ({ ...entry, title: `已编辑 ${entry.title}` }));
  const detail: PublishingPackageDetail = {
    package: packageRecord(result),
    tasks: changedTasks,
    audit: [],
  };

  const transaction = await service.stageTextProjection(detail);
  assert.deepEqual(await directoryBytes(platformsPath), before);
  await transaction.commit();
  assert.equal(await readFile(path.join(platformsPath, "douyin", "title.txt"), "utf8"), "已编辑 douyin 标题");
  assert.equal((await listFiles(platformsPath)).includes("douyin/legacy.bin"), false);

  await transaction.rollback();
  assert.deepEqual(await directoryBytes(platformsPath), before);
});

test("projection pre-commit failure after promotion restores exact old bytes", async () => {
  const { storageRoot, input } = await fixture();
  const creator = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await creator.createPackageAssets(input);
  const platformsPath = path.join(result.packagePath, "platforms");
  await writeFile(path.join(platformsPath, "douyin", "legacy.bin"), Buffer.from([0, 1, 2, 255]));
  const before = await directoryBytes(platformsPath);
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    rename: async (source, destination) => {
      await fsRename(source, destination);
      if (path.basename(source.toString()).startsWith(".next-platforms-")) {
        throw new Error("post-rename verification failed");
      }
    },
  });
  const transaction = await service.stageTextProjection({
    package: packageRecord(result),
    tasks: input.tasks.map((entry) => ({ ...entry, title: `未提交 ${entry.title}` })),
    audit: [],
  });

  await assert.rejects(transaction.commit());
  assert.deepEqual(await directoryBytes(platformsPath), before);
  assert.equal((await readdir(result.packagePath)).some((entry) => entry.startsWith(".previous-platforms-")), false);
  assert.equal((await readdir(result.packagePath)).some((entry) => entry.startsWith(".next-platforms-")), false);
});

test("projection commit uses CAS and keeps its disk backup until finalize", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const pkg = packageRecord(result);
  const first = await service.stageTextProjection({
    package: pkg,
    tasks: input.tasks.map((entry) => ({ ...entry, title: `第一版 ${entry.title}` })),
    audit: [],
  });
  const stale = await service.stageTextProjection({
    package: pkg,
    tasks: input.tasks.map((entry) => ({ ...entry, title: `过期版 ${entry.title}` })),
    audit: [],
  });

  await first.commit();
  const afterCommit = await readdir(result.packagePath);
  assert.equal(afterCommit.filter((entry) => entry.startsWith(".previous-platforms-")).length, 1);
  await assert.rejects(stale.commit(), (error: unknown) => {
    assert.ok(error instanceof PublishingAssetError);
    assert.equal(error.code, "publish_revision_conflict");
    return true;
  });
  assert.equal(await readFile(path.join(result.packagePath, "platforms", "douyin", "title.txt"), "utf8"), "第一版 douyin 标题");

  await first.finalize();
  assert.equal((await readdir(result.packagePath)).some((entry) => entry.startsWith(".previous-platforms-")), false);
  await stale.rollback();
});

test("startup scan removes an abandoned projection backup only after matching the index", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const pkg = packageRecord(result);
  const committedTasks = input.tasks.map((entry) => ({ ...entry, title: `索引版本 ${entry.title}` }));
  const transaction = await service.stageTextProjection({ package: pkg, tasks: committedTasks, audit: [] });
  await transaction.commit();
  const formalBeforeScan = await directoryBytes(path.join(result.packagePath, "platforms"));
  assert.equal((await readdir(result.packagePath)).filter((entry) => entry.startsWith(".previous-platforms-")).length, 1);
  const index: PublishingIndex = {
    schemaVersion: 1,
    revision: 2,
    nextVersionBySource: { "job-1": 2 },
    packages: { [pkg.id]: pkg },
    tasks: Object.fromEntries(committedTasks.map((entry) => [entry.id, entry])),
    audit: [],
    tombstones: {},
  };

  await new PublishingAssetService({ storageRoot, now: () => NOW }).scanAndRepair(index);

  assert.deepEqual(await directoryBytes(path.join(result.packagePath, "platforms")), formalBeforeScan);
  assert.equal((await readdir(result.packagePath)).some((entry) => entry.startsWith(".previous-platforms-")), false);
});

test("an older projection rollback cannot overwrite a later committed generation", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const pkg = packageRecord(result);
  const first = await service.stageTextProjection({
    package: pkg,
    tasks: input.tasks.map((entry) => ({ ...entry, title: `第一版 ${entry.title}` })),
    audit: [],
  });
  await first.commit();
  const later = await service.stageTextProjection({
    package: pkg,
    tasks: input.tasks.map((entry) => ({ ...entry, title: `第二版 ${entry.title}` })),
    audit: [],
  });
  await later.commit();

  await assert.rejects(first.rollback(), (error: unknown) => {
    assert.ok(error instanceof PublishingAssetError);
    assert.equal(error.code, "publish_revision_conflict");
    return true;
  });
  assert.equal(await readFile(path.join(result.packagePath, "platforms", "douyin", "title.txt"), "utf8"), "第二版 douyin 标题");

  await later.rollback();
  assert.equal(await readFile(path.join(result.packagePath, "platforms", "douyin", "title.txt"), "utf8"), "第一版 douyin 标题");
  await first.finalize();
});

test("projection commit rejects when its package inode is replaced after staging", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const transaction = await service.stageTextProjection({
    package: packageRecord(result),
    tasks: input.tasks.map((entry) => ({ ...entry, title: `待提交 ${entry.title}` })),
    audit: [],
  });
  const moved = `${result.packagePath}.moved`;
  const outside = await mkdtemp(path.join(tmpdir(), "publishing-stage-race-"));
  await fsRename(result.packagePath, moved);
  await symlink(outside, result.packagePath, "dir");

  await assert.rejects(transaction.commit(), (error: unknown) => error instanceof PublishingAssetError);
  assert.deepEqual(await readdir(outside), []);
});

test("package rollback refuses a replacement inode at the same formal path", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const moved = `${result.packagePath}.moved`;
  await fsRename(result.packagePath, moved);
  await mkdir(result.packagePath);
  await writeFile(path.join(result.packagePath, "later.bin"), "later bytes");

  await assert.rejects(result.rollback(), (error: unknown) => error instanceof PublishingAssetError);
  assert.equal(await readFile(path.join(result.packagePath, "later.bin"), "utf8"), "later bytes");
});

test("refuses to stage projections through a package-directory symlink", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "publishing-assets-link-"));
  const outsidePackage = await mkdtemp(path.join(tmpdir(), "publishing-assets-outside-"));
  const linkedPackage = path.join(storageRoot, "output", "publishing", "job-1", "v1-package-1");
  await mkdir(path.dirname(linkedPackage), { recursive: true });
  await mkdir(path.join(outsidePackage, "platforms", "douyin"), { recursive: true });
  await writeFile(path.join(outsidePackage, "platforms", "douyin", "title.txt"), "outside original");
  await symlink(outsidePackage, linkedPackage, "dir");
  const service = new PublishingAssetService({ storageRoot, now: () => NOW });
  const detail: PublishingPackageDetail = {
    package: {
      id: "package-1",
      sourceJobId: "job-1",
      version: 1,
      state: "active",
      title: "标题",
      packagePath: linkedPackage,
      videoPath: path.join(linkedPackage, "video.mp4"),
      videoSha256: "hash",
      videoSize: 1,
      videoMethod: "copy",
      assetHealth: "healthy",
      createdBy: ACTOR,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    tasks: [task("task-1", "douyin")],
    audit: [],
  };

  await assert.rejects(service.stageTextProjection(detail), (error: unknown) => {
    assert.ok(error instanceof PublishingAssetError);
    assert.equal(error.code, "publish_video_unreadable");
    return true;
  });
  assert.equal(await readFile(path.join(outsidePackage, "platforms", "douyin", "title.txt"), "utf8"), "outside original");
  assert.equal((await readdir(outsidePackage)).some((entry) => entry.startsWith(".next-")), false);
});

test("refuses to read or swap a platform projection symlink outside the package", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const platformsPath = path.join(result.packagePath, "platforms");
  const outsidePlatforms = await mkdtemp(path.join(tmpdir(), "publishing-platforms-outside-"));
  await writeFile(path.join(outsidePlatforms, "sentinel"), "outside original");
  await rm(platformsPath, { recursive: true });
  await symlink(outsidePlatforms, platformsPath, "dir");

  await assert.rejects(service.stageTextProjection({
    package: packageRecord(result),
    tasks: input.tasks,
    audit: [],
  }), (error: unknown) => {
    assert.ok(error instanceof PublishingAssetError);
    assert.equal(error.code, "publish_video_unreadable");
    return true;
  });
  assert.equal(await readFile(path.join(outsidePlatforms, "sentinel"), "utf8"), "outside original");
});

test("verifies checksum and size, rejects escaped package video, and purges only package assets", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const pkg = packageRecord(result);

  assert.equal(await service.verifyPackageVideo(pkg), "missing_cover");
  await writeFile(result.videoPath, "changed bytes");
  assert.equal(await service.verifyPackageVideo(pkg), "broken_video");
  pkg.videoPath = input.sourceVideoPath;
  assert.equal(await service.verifyPackageVideo(pkg), "broken_video");

  pkg.videoPath = result.videoPath;
  await service.purgeAssets(pkg);
  await assert.rejects(stat(result.packagePath), { code: "ENOENT" });
  assert.deepEqual(await readFile(input.sourceVideoPath), Buffer.from("source mp4 bytes"));
});

test("rejects package A records that point at package B for verify, stage, and purge", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const packageA = await service.createPackageAssets(input);
  const packageBInput: PackageAssetInput = {
    ...input,
    packageId: "package-b",
    version: 2,
    tasks: [task("task-b", "douyin", "package-b")],
  };
  const packageB = await service.createPackageAssets(packageBInput);
  const forgedA = packageRecord(packageB, {
    id: "package-1",
    sourceJobId: "job-1",
    version: 1,
  });

  assert.equal(await service.verifyPackageVideo(forgedA), "broken_video");
  await assert.rejects(service.stageTextProjection({
    package: forgedA,
    tasks: input.tasks,
    audit: [],
  }), (error: unknown) => error instanceof PublishingAssetError);
  await assert.rejects(service.purgeAssets(forgedA), (error: unknown) => error instanceof PublishingAssetError);
  assert.equal((await stat(packageA.packagePath)).isDirectory(), true);
  assert.equal((await stat(packageB.packagePath)).isDirectory(), true);
});

test("purge rejects a source directory or sibling path derived from forged package metadata", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const result = await service.createPackageAssets(input);
  const pkg = packageRecord(result);
  const sourceDirectory = path.dirname(result.packagePath);

  for (const forgedPath of [sourceDirectory, path.join(sourceDirectory, "v9-sibling")]) {
    const forged = { ...pkg, packagePath: forgedPath, videoPath: path.join(forgedPath, "video.mp4") };
    await assert.rejects(service.purgeAssets(forged), (error: unknown) => error instanceof PublishingAssetError);
  }
  assert.equal((await stat(result.packagePath)).isDirectory(), true);
});

test("startup asset scan removes only stale temps and repairs files without store-owned transitions", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const healthyResult = await service.createPackageAssets(input);
  const healthyPackage = packageRecord(healthyResult);
  await writeFile(path.join(healthyResult.packagePath, "platforms", "douyin", "title.txt"), "stale");

  const brokenInput = { ...input, packageId: "package-broken", version: 2, tasks: [task("task-broken", "douyin", "package-broken")] };
  const brokenResult = await service.createPackageAssets(brokenInput);
  const brokenPackage = { ...packageRecord(brokenResult), id: "package-broken", version: 2 };
  await writeFile(brokenResult.videoPath, "corrupt");

  const trashInput = { ...input, packageId: "package-trash", version: 3, tasks: [task("task-trash", "bilibili", "package-trash")] };
  const trashResult = await service.createPackageAssets(trashInput);
  const trashPackage: DeliveryPackage = {
    ...packageRecord(trashResult),
    id: "package-trash",
    version: 3,
    state: "trashed",
    purgeAt: "2026-08-09T08:00:00.000Z",
  };
  const publishingRoot = path.join(storageRoot, "output", "publishing");
  const staleTemp = path.join(publishingRoot, "job-1", ".next-stale");
  const freshTemp = path.join(publishingRoot, "job-1", ".next-fresh");
  const orphan = path.join(publishingRoot, "job-orphan", "v1-orphan-package");
  await mkdir(staleTemp, { recursive: true });
  await writeFile(path.join(staleTemp, "partial"), "partial");
  await mkdir(freshTemp, { recursive: true });
  await writeFile(path.join(freshTemp, "partial"), "fresh");
  await utimes(staleTemp, new Date(NOW.getTime() - 2 * 60 * 60 * 1000), new Date(NOW.getTime() - 2 * 60 * 60 * 1000));
  await utimes(freshTemp, new Date(NOW.getTime() - 60 * 1000), new Date(NOW.getTime() - 60 * 1000));
  await mkdir(orphan, { recursive: true });
  await writeFile(path.join(orphan, "video.mp4"), "orphan");

  const index: PublishingIndex = {
    schemaVersion: 1,
    revision: 1,
    nextVersionBySource: { "job-1": 4 },
    packages: {
      [healthyPackage.id]: healthyPackage,
      [brokenPackage.id]: brokenPackage,
      [trashPackage.id]: trashPackage,
    },
    tasks: Object.fromEntries([...input.tasks, ...brokenInput.tasks, ...trashInput.tasks].map((entry) => [entry.id, entry])),
    audit: [],
    tombstones: {},
  };
  const taskStatesBefore = Object.fromEntries(Object.values(index.tasks).map((entry) => [entry.id, entry.status]));

  const report = await service.scanAndRepair(index);
  const canonicalPublishingRoot = await realpath(publishingRoot);

  assert.deepEqual(report.removedTempPaths, [path.join(canonicalPublishingRoot, "job-1", ".next-stale")]);
  assert.equal((await stat(freshTemp)).isDirectory(), true);
  assert.deepEqual(report.orphanPaths, [path.join(canonicalPublishingRoot, "job-orphan", "v1-orphan-package")]);
  assert.deepEqual(report.repairedPackageIds, ["package-1"]);
  assert.deepEqual(report.brokenPackageIds, ["package-broken"]);
  assert.deepEqual(report.notifications, []);
  assert.deepEqual(report.purgedPackageIds, []);
  assert.deepEqual(report.purgeFailures, []);
  assert.equal(index.packages["package-broken"].assetHealth, "broken_video");
  assert.equal(await readFile(path.join(healthyResult.packagePath, "platforms", "douyin", "title.txt"), "utf8"), "douyin 标题");
  assert.equal((await stat(trashResult.packagePath)).isDirectory(), true);
  assert.deepEqual(
    Object.fromEntries(Object.values(index.tasks).map((entry) => [entry.id, entry.status])),
    taskStatesBefore,
  );
});

test("startup scan waits for a live package creation instead of deleting its temp directory", async () => {
  const { storageRoot, input } = await fixture();
  input.sourceVideoPath = await realpath(input.sourceVideoPath);
  const handle = await open(input.sourceVideoPath, "r");
  const opened = await handle.stat();
  let releaseCopy!: () => void;
  const copyReleased = new Promise<void>((resolve) => { releaseCopy = resolve; });
  let copyStarted!: () => void;
  const didStartCopy = new Promise<void>((resolve) => { copyStarted = resolve; });
  let readsFromStart = 0;
  const blockedHandle = interceptHandleReads(handle, async (position) => {
    readsFromStart += position === 0 ? 1 : 0;
    if (readsFromStart === 2) {
      copyStarted();
      await copyReleased;
    }
  });
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const index: PublishingIndex = {
    schemaVersion: 1,
    revision: 0,
    nextVersionBySource: {},
    packages: {},
    tasks: {},
    audit: [],
    tombstones: {},
  };

  const creating = service.createPackageAssets({
    ...input,
    sourceVideo: {
      path: input.sourceVideoPath,
      handle: blockedHandle,
      size: opened.size,
      identity: { dev: opened.dev, ino: opened.ino },
    },
  });
  await didStartCopy;
  const scanning = service.scanAndRepair(index);
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseCopy();

  try {
    const [created, report] = await Promise.all([creating, scanning]);
    assert.equal((await stat(created.packagePath)).isDirectory(), true);
    assert.deepEqual(report.removedTempPaths, []);
  } finally {
    await handle.close();
  }
});

test("startup scan isolates a bad package and continues later verification and repair", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => { throw new Error("no cover"); },
  });
  const firstInput: PackageAssetInput = {
    ...input,
    packageId: "a-good",
    version: 1,
    tasks: [task("task-a", "douyin", "a-good")],
  };
  const lastInput: PackageAssetInput = {
    ...input,
    packageId: "z-good",
    version: 2,
    tasks: [task("task-z", "bilibili", "z-good")],
  };
  const first = await service.createPackageAssets(firstInput);
  const last = await service.createPackageAssets(lastInput);
  await writeFile(path.join(first.packagePath, "platforms", "douyin", "title.txt"), "stale first");
  await writeFile(path.join(last.packagePath, "platforms", "bilibili", "title.txt"), "stale last");

  const outside = await mkdtemp(path.join(tmpdir(), "publishing-scan-outside-"));
  const badPath = path.join(await realpath(storageRoot), "output", "publishing", "job-1", "v3-m-bad");
  await symlink(outside, badPath, "dir");
  const bad: DeliveryPackage = {
    ...packageRecord(first),
    id: "m-bad",
    version: 3,
    packagePath: badPath,
    videoPath: path.join(badPath, "video.mp4"),
  };
  const index: PublishingIndex = {
    schemaVersion: 1,
    revision: 0,
    nextVersionBySource: {},
    packages: {
      "a-good": packageRecord(first, { id: "a-good", version: 1 }),
      "m-bad": bad,
      "z-good": packageRecord(last, { id: "z-good", version: 2 }),
    },
    tasks: Object.fromEntries([...firstInput.tasks, task("task-bad", "douyin", "m-bad"), ...lastInput.tasks].map((entry) => [entry.id, entry])),
    audit: [],
    tombstones: {},
  };

  const report = await service.scanAndRepair(index);

  assert.deepEqual(report.repairedPackageIds, ["a-good", "z-good"]);
  assert.ok(report.brokenPackageIds.includes("m-bad"));
  assert.deepEqual(report.repairFailures.map((failure) => failure.packageId), ["m-bad"]);
  assert.equal(await readFile(path.join(first.packagePath, "platforms", "douyin", "title.txt"), "utf8"), "douyin 标题");
  assert.equal(await readFile(path.join(last.packagePath, "platforms", "bilibili", "title.txt"), "utf8"), "bilibili 标题");
});

test("collects scene snapshots in scene order and skips non-scene snapshot artifacts", async () => {
  const { storageRoot, snapshotsDirectory, snapshots } = await noteFixture();
  const frame10 = path.join(snapshotsDirectory, "frame-10-at-58.2s.png");
  await writeFile(frame10, frameBytes(10));
  await writeFile(path.join(snapshotsDirectory, "notes.txt"), "not an image");
  const service = noteService(storageRoot);

  const collected = await collectSceneSnapshots(storageRoot, "job-1");

  // contact-sheet-*.jpg 字典序在 frame-* 之前，纯 readdir().sort() 会把它们排到最前；
  // frame-10 也必须排在 frame-02 之后（按场景号数值序，不是字典序）。
  assert.deepEqual(collected, [snapshots.frame00, snapshots.frame01, snapshots.frame02, frame10]);
  assert.deepEqual(await collectSceneSnapshots(await emptyNoteStorageRoot(), "job-1"), []);
  assert.deepEqual(await collectSceneSnapshots(storageRoot, "job-absent"), []);

  // 目录里只有非场景产物 → 同样视为没有图。
  const onlySheets = await emptyNoteStorageRoot();
  const onlySheetsDirectory = path.join(onlySheets, "output", "videos", "job-1", "hyperframes", "snapshots");
  await mkdir(onlySheetsDirectory, { recursive: true });
  await writeFile(path.join(onlySheetsDirectory, "contact-sheet-1.jpg"), frameBytes(9));
  assert.deepEqual(await collectSceneSnapshots(onlySheets, "job-1"), []);

  // 打包侧自动收集：包内图片就是按场景序的静帧（frame-10 排在最末，contact sheet 不在内）。
  const result = await service.createNotePackageAssets(noteInput());
  assert.deepEqual(result.imagePaths, ["images/01.png", "images/02.png", "images/03.png", "images/04.png"]);
  assert.deepEqual(await readFile(path.join(result.packagePath, "images", "04.png")), frameBytes(10));
});

test("packages note snapshots in order with an ordered image manifest hash", async () => {
  const { storageRoot, snapshots, input } = await noteFixture();
  const service = noteService(storageRoot);

  const result = await service.createNotePackageAssets(input);
  const files = await listFiles(result.packagePath);
  const manifest = JSON.parse(await readFile(path.join(result.packagePath, "manifest.json"), "utf8")) as {
    contentType: string;
    assetHealth: string;
    images: { paths: string[]; count: number; size: number; manifestSha256: string };
    tasks: Array<{ imagePaths: string[] }>;
  };

  assert.equal(result.contentType, "note");
  assert.equal(result.assetHealth, "healthy");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.imagePaths, ["images/01.png", "images/02.png", "images/03.png"]);
  assert.equal(result.imageCount, 3);
  assert.equal(result.imageSize, frameBytes(0).length * 3);
  assert.deepEqual(files.filter((file) => file.startsWith("images/")), [
    "images/01.png",
    "images/02.png",
    "images/03.png",
  ]);
  // note 包里没有成片与封面。
  assert.equal(files.includes("video.mp4"), false);
  assert.equal(files.includes("cover.jpg"), false);
  // 01 对应 frame-00、03 对应 frame-02：场景序而不是传入顺序的偶然巧合。
  assert.deepEqual(await readFile(path.join(result.packagePath, "images", "01.png")), frameBytes(0));
  assert.deepEqual(await readFile(path.join(result.packagePath, "images", "02.png")), frameBytes(1));
  assert.deepEqual(await readFile(path.join(result.packagePath, "images", "03.png")), frameBytes(2));
  // 平台文案投影与视频包一致（共用同一套写法）。
  assert.equal(await readFile(path.join(result.packagePath, "platforms", "douyin", "title.txt"), "utf8"), "douyin 标题");
  assert.equal(
    await readFile(path.join(result.packagePath, "platforms", "douyin", "hashtags.txt"), "utf8"),
    "#内容创作 #效率",
  );

  assert.equal(manifest.contentType, "note");
  assert.equal(manifest.assetHealth, "healthy");
  assert.deepEqual(manifest.images.paths, result.imagePaths);
  assert.equal(manifest.images.count, 3);
  assert.equal(manifest.images.size, result.imageSize);
  assert.equal(manifest.images.manifestSha256, result.imageManifestSha256);
  assert.deepEqual(manifest.tasks.map((entry) => entry.imagePaths), [result.imagePaths]);

  // 清单哈希 = 各图 sha256 有序拼接后再哈希（用包内真实字节独立重算）。
  const packageHashes = await Promise.all(
    result.imagePaths.map(async (relativePath) => sha256Of(await readFile(path.join(result.packagePath, relativePath)))),
  );
  assert.deepEqual(packageHashes, [frameBytes(0), frameBytes(1), frameBytes(2)].map(sha256Of));
  assert.equal(result.imageManifestSha256, manifestHashOf(packageHashes));

  assert.doesNotMatch(JSON.stringify(manifest), /api.?key|cookie|password|pin(hash|salt)?|secret|token/iu);
  assert.doesNotMatch(files.join("\n"), /api.?key|cookie|password|pin|secret|token/iu);
  assert.deepEqual(await publishingEntries(storageRoot), ["v1-package-1"]);
});

test("changing any image or reordering the list changes the image manifest hash", async () => {
  const { storageRoot, snapshots, input } = await noteFixture();
  const service = noteService(storageRoot);

  const original = await service.createNotePackageAssets({
    ...input,
    sourceImagePaths: [snapshots.frame00, snapshots.frame01],
  });
  const reordered = await service.createNotePackageAssets(noteInputFor("package-b", 2, {
    sourceImagePaths: [snapshots.frame01, snapshots.frame00],
  }));
  // 同样的两张图，仅调换顺序：清单哈希必须改变，且包内 01 换成原来的 frame-01。
  assert.notEqual(reordered.imageManifestSha256, original.imageManifestSha256);
  assert.deepEqual(original.imagePaths, ["images/01.png", "images/02.png"]);
  assert.deepEqual(await readFile(path.join(original.packagePath, "images", "01.png")), frameBytes(0));
  assert.deepEqual(await readFile(path.join(reordered.packagePath, "images", "01.png")), frameBytes(1));
  assert.deepEqual(await readFile(path.join(reordered.packagePath, "images", "02.png")), frameBytes(0));

  // 改动其中一张图的内容：清单哈希同样必须改变。
  await writeFile(snapshots.frame01, frameBytes(7));
  const changed = await service.createNotePackageAssets(noteInputFor("package-c", 3, {
    sourceImagePaths: [snapshots.frame00, snapshots.frame01],
  }));
  assert.notEqual(changed.imageManifestSha256, original.imageManifestSha256);
  assert.notEqual(changed.imageManifestSha256, reordered.imageManifestSha256);
  assert.deepEqual(await readFile(path.join(changed.packagePath, "images", "02.png")), frameBytes(7));
});

test("keeps a note package usable with missing_images and an explicit warning when there are no images", async () => {
  const storageRoot = await emptyNoteStorageRoot();
  const service = noteService(storageRoot);

  const discovered = await service.createNotePackageAssets(noteInput());
  const explicit = await service.createNotePackageAssets(noteInputFor("package-b", 2, { sourceImagePaths: [] }));

  for (const result of [discovered, explicit]) {
    assert.equal(result.contentType, "note");
    assert.equal(result.assetHealth, "missing_images");
    assert.equal(result.imageCount, 0);
    assert.deepEqual(result.imagePaths, []);
    assert.equal(result.imageSize, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "publish_images_missing");
    assert.match(result.warnings[0].message, /图片|素材/u);
    // 包仍然自包含地建出来（文案与清单可用），只是资产不健康。
    assert.equal(await readFile(path.join(result.packagePath, "platforms", "douyin", "title.txt"), "utf8"), "douyin 标题");
    assert.equal((await listFiles(result.packagePath)).some((file) => file.startsWith("images/")), false);
    const manifest = JSON.parse(await readFile(path.join(result.packagePath, "manifest.json"), "utf8")) as {
      assetHealth: string;
      images: { paths: string[]; count: number };
    };
    assert.equal(manifest.assetHealth, "missing_images");
    assert.deepEqual(manifest.images.paths, []);
    assert.equal(manifest.images.count, 0);
    assert.equal(await service.verifyPackageImages(notePackageRecord(result)), "missing_images");
  }

  assert.deepEqual(await publishingEntries(storageRoot), [
    "v1-package-1",
    "v2-package-b",
  ]);
});

test("verifies note package images and reports missing_images for absent, forged, or altered images", async () => {
  const { storageRoot, input } = await noteFixture();
  const service = noteService(storageRoot);
  const result = await service.createNotePackageAssets(input);
  const record = notePackageRecord(result);

  assert.equal(await service.verifyPackageImages(record), "healthy");
  // 调换记录里的顺序 → 与包内容指纹不符。
  assert.equal(await service.verifyPackageImages({
    ...record,
    imagePaths: [...record.imagePaths!].reverse(),
  }), "missing_images");
  // 包内少一张。
  await rm(path.join(result.packagePath, "images", "02.png"));
  assert.equal(await service.verifyPackageImages(record), "missing_images");
  // 内容被改写。
  await writeFile(path.join(result.packagePath, "images", "02.png"), frameBytes(77));
  assert.equal(await service.verifyPackageImages(record), "missing_images");
  // 还原成原字节后重新健康 —— 证明上面的判定不是「恒为 missing_images」。
  await writeFile(path.join(result.packagePath, "images", "02.png"), frameBytes(1));
  assert.equal(await service.verifyPackageImages(record), "healthy");
  // 声明越出包目录的路径。
  for (const forged of ["../video.mp4", "images/../manifest.json", "images/../../job-1/v1-package-1/images/01.png", "/etc/passwd"]) {
    assert.equal(await service.verifyPackageImages({ ...record, imagePaths: [forged] }), "missing_images");
  }
  // 包目录外带符号链接的图片名。
  await symlink(path.join(storageRoot, "outside.png"), path.join(result.packagePath, "images", "09.png"), "file");
  assert.equal(await service.verifyPackageImages({ ...record, imagePaths: ["images/09.png"] }), "missing_images");
  // 记录指向另一个包。
  assert.equal(await service.verifyPackageImages({
    ...record,
    version: 9,
  }), "missing_images");
});

test("rejects note packing above the 35 image limit before writing anything", async () => {
  const storageRoot = await emptyNoteStorageRoot();
  const snapshotsDirectory = path.join(storageRoot, "frames");
  await mkdir(snapshotsDirectory, { recursive: true });
  const imagePaths: string[] = [];
  for (let index = 0; index < 36; index += 1) {
    const imagePath = path.join(snapshotsDirectory, `frame-${String(index).padStart(2, "0")}-at-1s.png`);
    await writeFile(imagePath, frameBytes(index));
    imagePaths.push(imagePath);
  }
  const service = noteService(storageRoot);

  await assert.rejects(service.createNotePackageAssets(noteInput({ sourceImagePaths: imagePaths })), (error: unknown) => {
    assert.ok(error instanceof PublishingAssetError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "publish_too_many_images");
    return true;
  });

  assert.deepEqual(await publishingEntries(storageRoot).catch(() => []), []);
});

test("keeps the video package manifest byte-identical and reports contentType video without note parameters", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    // 固定走 copy 分支，让 manifest 里的 method 与哈希可逐字节比对。
    copyFile: async (source, destination, mode = 0) => {
      if (mode & constants.COPYFILE_FICLONE) throw Object.assign(new Error("clone unavailable"), { code: "ENOTSUP" });
      await fsCopyFile(source, destination, mode);
    },
    runCommand: async () => { throw new Error("no cover"); },
  });

  const result = await service.createPackageAssets(input);

  assert.equal(result.contentType, "video");
  assert.deepEqual(await listFiles(result.packagePath), [
    "manifest.json",
    "platforms/bilibili/description.txt",
    "platforms/bilibili/hashtags.txt",
    "platforms/bilibili/publish.txt",
    "platforms/bilibili/title.txt",
    "platforms/douyin/description.txt",
    "platforms/douyin/hashtags.txt",
    "platforms/douyin/publish.txt",
    "platforms/douyin/title.txt",
    "video.mp4",
  ]);
  // 2026-09-17 改动前的实现产物，逐字节固定：视频包 manifest 不得被图文打包改动。
  const baseline = `{
  "schemaVersion": 1,
  "package": {
    "id": "package-1",
    "sourceJobId": "job-1",
    "version": 1,
    "title": "发布包标题",
    "createdBy": {
      "userId": "user-1",
      "displayName": "发布员",
      "role": "publisher"
    },
    "createdAt": "2026-08-10T08:00:00.000Z"
  },
  "video": {
    "path": "video.mp4",
    "sha256": "e93091cd173f65c449034403ad0c0339263d8e65ab499eff88b5f8681c8cb063",
    "size": 16,
    "method": "copy"
  },
  "cover": null,
  "assetHealth": "missing_cover",
  "tasks": [
    {
      "id": "task-douyin",
      "platform": "douyin",
      "videoPath": "video.mp4",
      "title": "douyin 标题",
      "description": "douyin 正文",
      "hashtags": [
        "内容创作",
        "效率"
      ],
      "copySource": "ai",
      "status": "ready",
      "contentRevision": 1
    },
    {
      "id": "task-bilibili",
      "platform": "bilibili",
      "videoPath": "video.mp4",
      "title": "bilibili 标题",
      "description": "bilibili 正文",
      "hashtags": [
        "内容创作",
        "效率"
      ],
      "copySource": "ai",
      "status": "ready",
      "contentRevision": 1
    }
  ]
}`;
  const manifestBytes = await readFile(path.join(result.packagePath, "manifest.json"));
  assert.equal(manifestBytes.toString("utf8"), baseline);
  assert.equal(sha256Of(manifestBytes), "469ba17f14e73a7a3cac710572ebdf6eb44adccca7e100b2e00750f431bb8722");
  assert.deepEqual(await readFile(result.videoPath), await readFile(input.sourceVideoPath));
});

// ─── 微信公众号文章包（article）──────────────────────────────────────────────
//
// 与 note 包的关键差别：文章包的**正文是渲染好的 HTML**（走 `article.html`），
// 配图是**正文插图**而不是内容主体，所以「一张图都没有」是合法状态，
// 但「正文里有占位符却没有对应图片」是**必然发不出去**的包，必须在打包阶段拦掉。

const ARTICLE_HTML = [
  '<section style="margin:0;">',
  '<h2 style="font-size:19px;">一、前三秒</h2>',
  '<p style="margin:0;">观众划走只需要 0.8 秒。</p>',
  '<img src="{{wechat-image-1}}" style="max-width:100%;">',
  "</section>",
].join("\n");

function articleInput(overrides: Partial<ArticlePackageAssetInput> = {}): ArticlePackageAssetInput {
  return {
    packageId: "package-1",
    sourceJobId: "job-1",
    version: 1,
    articleHtml: ARTICLE_HTML,
    articleCopy: { title: "为什么没人看完", digest: "前三秒决定生死。", author: "抖创工坊" },
    title: "发布包标题",
    tasks: [task("task-wechat", "wechat_mp")],
    actor: ACTOR,
    ...overrides,
  };
}

async function articleFixture() {
  const storageRoot = await realpath(await mkdtemp(path.join(tmpdir(), "publishing-articles-")));
  const sourceDirectory = path.join(storageRoot, "output", "videos", "job-1");
  await mkdir(sourceDirectory, { recursive: true });
  // 正文图这里用「已经被 wechat-media 压过」的产物形态（jpg、有序）：
  // 打包层只负责复制与哈希，不负责转码（转码在 wechat-media.ts，Task 4）。
  const body01 = path.join(sourceDirectory, "body-01.jpg");
  const body02 = path.join(sourceDirectory, "body-02.jpg");
  const cover = path.join(sourceDirectory, "wechat-cover.jpg");
  await writeFile(body01, frameBytes(1));
  await writeFile(body02, frameBytes(2));
  await writeFile(cover, frameBytes(3));
  return { storageRoot, body01, body02, cover, input: articleInput() };
}

function articleService(storageRoot: string): PublishingAssetService {
  return new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    runCommand: async () => {
      throw new Error("文章打包不应调用任何外部命令（转码发生在 wechat-media）");
    },
  });
}

/** 发布目录内容；目录不存在时返回空数组（创建中途失败时它可能压根没被建出来）。 */
async function publishingEntries(storageRoot: string): Promise<string[]> {
  try {
    return (await readdir(path.join(storageRoot, "output", "publishing", "job-1"))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("packages an article package with html, ordered images and cover", async () => {
  const { storageRoot, body01, body02, cover } = await articleFixture();
  const service = articleService(storageRoot);

  const result = await service.createArticlePackageAssets({
    ...articleInput(),
    sourceImagePaths: [body01, body02],
    sourceCoverPath: cover,
  });
  const files = await listFiles(result.packagePath);
  const manifest = JSON.parse(await readFile(path.join(result.packagePath, "manifest.json"), "utf8")) as {
    contentType: string;
    article: { title: string; digest?: string; author?: string; htmlSha256: string; path: string };
    images: { paths: string[]; count: number; size: number; manifestSha256: string };
  };

  assert.equal(result.contentType, "article");
  assert.equal(result.assetHealth, "healthy");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.imagePaths, ["images/01.jpg", "images/02.jpg"]);
  assert.equal(result.coverPath, path.join(result.packagePath, "cover.jpg"));
  assert.equal(result.articlePath, path.join(result.packagePath, "article.html"));

  // 正文 HTML 逐字节落盘，且哈希是包内真实字节的哈希（可在包外独立重算）。
  const htmlBytes = await readFile(result.articlePath);
  assert.deepEqual(htmlBytes, Buffer.from(ARTICLE_HTML));
  assert.equal(result.htmlSha256, sha256Of(htmlBytes));
  assert.match(result.htmlSha256, /^[0-9a-f]{64}$/u);

  // 顺序即传入顺序，图片内容可逐字节核对。
  assert.deepEqual(await readFile(path.join(result.packagePath, "images", "01.jpg")), frameBytes(1));
  assert.deepEqual(await readFile(path.join(result.packagePath, "images", "02.jpg")), frameBytes(2));
  assert.deepEqual(await readFile(path.join(result.packagePath, "cover.jpg")), frameBytes(3));

  const packageHashes = await Promise.all(
    result.imagePaths.map(async (relativePath) => sha256Of(await readFile(path.join(result.packagePath, relativePath)))),
  );
  assert.equal(result.imageManifestSha256, manifestHashOf(packageHashes));

  assert.equal(manifest.contentType, "article");
  assert.equal(manifest.article.title, "为什么没人看完");
  assert.equal(manifest.article.digest, "前三秒决定生死。");
  assert.equal(manifest.article.author, "抖创工坊");
  assert.equal(manifest.article.htmlSha256, result.htmlSha256);
  assert.deepEqual(manifest.images.paths, result.imagePaths);

  // 文章包不含成片；封面与正文图都在。
  assert.equal(files.includes("video.mp4"), false);
  assert.equal(files.includes("article.html"), true);
  assert.equal(files.includes("cover.jpg"), true);
  assert.doesNotMatch(JSON.stringify(manifest), /api.?key|cookie|password|pin(hash|salt)?|secret|token/iu);
  assert.deepEqual(await publishingEntries(storageRoot), ["v1-package-1"]);
});

test("keeps the article package usable with missing_cover when no cover is given", async () => {
  const { storageRoot, body01 } = await articleFixture();
  const service = articleService(storageRoot);

  // 封面必填是**提交**阶段的约束：打包仍然把包自包含地建出来（与视频缺封面同一口径）。
  const result = await service.createArticlePackageAssets({
    ...articleInput(),
    sourceImagePaths: [body01],
  });

  assert.equal(result.assetHealth, "missing_cover");
  assert.equal(result.coverPath, undefined);
  assert.equal((await listFiles(result.packagePath)).includes("cover.jpg"), false);
  assert.deepEqual(result.imagePaths, ["images/01.jpg"]);
});

test("allows an article with no images when the html has no placeholders", async () => {
  const { storageRoot } = await articleFixture();
  const service = articleService(storageRoot);

  // 正文插图是可选的（文章的内容是文字），所以既不该报错也不该标 missing_images ——
  // 与 note 包不同：图文包的图片就是内容本身。
  const result = await service.createArticlePackageAssets({
    ...articleInput({ articleHtml: "<section><p>纯文字正文。</p></section>" }),
  });

  assert.equal(result.assetHealth, "missing_cover");
  assert.deepEqual(result.imagePaths, []);
  assert.deepEqual(result.warnings, []);
});

test("rejects an article whose html expects images that were not provided", async () => {
  const { storageRoot } = await articleFixture();
  const service = articleService(storageRoot);

  // ARTICLE_HTML 里有 {{wechat-image-1}}：没有图就**永远提交不了**，
  // 与其在提交时报错，不如在这里就不让这种包产生。
  await assert.rejects(
    () => service.createArticlePackageAssets(articleInput()),
    (error: unknown) => {
      assert.ok(error instanceof PublishingAssetError);
      assert.equal(error.code, "publish_images_missing");
      return true;
    },
  );
  // 失败不得留下包目录或临时目录。
  assert.deepEqual(await publishingEntries(storageRoot), []);
});

test("rejects an article when images do not cover every placeholder slot", async () => {
  const { storageRoot, body01 } = await articleFixture();
  const service = articleService(storageRoot);

  // 正文要两张（slot 1 与 2），只给一张 → 同样提交不了。
  const html = `${ARTICLE_HTML}\n<img src="{{wechat-image-2}}" style="max-width:100%;">`;
  await assert.rejects(
    () => service.createArticlePackageAssets({
      ...articleInput({ articleHtml: html }),
      sourceImagePaths: [body01],
    }),
    (error: unknown) => {
      assert.ok(error instanceof PublishingAssetError);
      assert.equal(error.code, "publish_images_missing");
      return true;
    },
  );
});

test("reordering article images changes the manifest hash and the packaged order", async () => {
  const { storageRoot, body01, body02 } = await articleFixture();
  const service = articleService(storageRoot);

  const original = await service.createArticlePackageAssets({
    ...articleInput(),
    sourceImagePaths: [body01, body02],
  });
  // 换包号/版本时必须同时换 tasks 的 packageId（`validateProjectionTasks` 校验任务归属）。
  const reordered = await service.createArticlePackageAssets({
    ...articleInput({
      packageId: "package-b",
      version: 2,
      tasks: [task("task-package-b", "wechat_mp", "package-b")],
    }),
    sourceImagePaths: [body02, body01],
  });

  assert.notEqual(original.imageManifestSha256, reordered.imageManifestSha256);
  // 同样两张图，仅调换顺序：包内 01 换成原来的第二张。
  assert.deepEqual(await readFile(path.join(reordered.packagePath, "images", "01.jpg")), frameBytes(2));
  assert.deepEqual(await readFile(path.join(reordered.packagePath, "images", "02.jpg")), frameBytes(1));
});

test("rejects an unreadable article image without leaving a temp directory", async () => {
  const { storageRoot, body01 } = await articleFixture();
  const service = articleService(storageRoot);

  await assert.rejects(
    () => service.createArticlePackageAssets({
      ...articleInput(),
      sourceImagePaths: [body01, path.join(storageRoot, "output", "videos", "job-1", "not-there.jpg")],
    }),
    (error: unknown) => {
      assert.ok(error instanceof PublishingAssetError);
      assert.equal(error.code, "publish_image_unreadable");
      return true;
    },
  );
  assert.deepEqual(await publishingEntries(storageRoot), []);
});

// ─── 文章包的资产体检与 article.html 读取（本轮新增的分支）────────────────────

/**
 * article 包**不能走视频分支**：它没有 `video.mp4`，走视频分支会一律判成 `broken_video`。
 * 本模块新增的 article 分支口径：正文图清单（有图才查）→ 封面（头条必填）→ healthy。
 *
 * 正文 HTML 的完整性**刻意不在这里查**：那是「提交那一刻」的事，由服务层比对
 * `articleCopy.htmlSha256`（那里失败还能说出人话，这里只会变成一个健康值）。
 */
test("article 包的体检走 article 分支：有封面 healthy", async () => {
  const { storageRoot, cover } = await articleFixture();
  const service = articleService(storageRoot);

  // 用**按内容类型分派**的入口；`verifyPackageVideo` / `verifyPackageImages` 是「只按那一种口径查」
  // 的专用入口（`verifyPackageImages` 对 0 张图直接判 missing_images，那是图文包的口径，
  // 而文章包 0 张正文图是合法的）。
  const withCover = await service.createArticlePackageAssets({
    ...articleInput({ articleHtml: "<section><p>纯文字正文。</p></section>" }),
    sourceCoverPath: cover,
  });
  assert.equal(await service.verifyPackageHealth(articlePackageRecord(withCover)), "healthy");
});

test("article 包缺封面时报 missing_cover（不是 broken_video）", async () => {
  // 单独一个夹具：包目录名带 packageId + version，同一个 storage 里不能建两次同一个包。
  const { storageRoot } = await articleFixture();
  const service = articleService(storageRoot);

  const withoutCover = await service.createArticlePackageAssets({
    ...articleInput({ articleHtml: "<section><p>纯文字正文。</p></section>" }),
  });
  // 走视频分支的话这里会是 broken_video —— 那正是本次新增分支要避免的误判。
  assert.equal(await service.verifyPackageHealth(articlePackageRecord(withoutCover)), "missing_cover");
});

test("article 包声明了正文图时仍会校验图片清单；图片被改动 → missing_images", async () => {
  const { storageRoot, body01, cover } = await articleFixture();
  const service = articleService(storageRoot);

  // ARTICLE_HTML 里有 {{wechat-image-1}}，所以这里必须给一张图。
  const result = await service.createArticlePackageAssets({
    ...articleInput(),
    sourceImagePaths: [body01],
    sourceCoverPath: cover,
  });
  const record = articlePackageRecord(result);
  assert.equal(await service.verifyPackageHealth(record), "healthy");

  // 改一个字节：清单哈希对不上 → 必须报 missing_images（article 包也不能豁免完整性校验）。
  await writeFile(path.join(result.packagePath, "images", "01.jpg"), frameBytes(9));
  assert.equal(await service.verifyPackageHealth(record), "missing_images");
});

test("readPackageArticle 读回包内 article.html 的字节；文件被删掉时返回 null", async () => {
  const { storageRoot, cover } = await articleFixture();
  const service = articleService(storageRoot);
  const html = "<section><p>纯文字正文。</p></section>";

  const result = await service.createArticlePackageAssets({
    ...articleInput({ articleHtml: html }),
    sourceCoverPath: cover,
  });
  const record = articlePackageRecord(result);

  const bytes = await service.readPackageArticle(record);
  assert.equal(bytes?.toString("utf8"), html);
  // 与封面同一套纪律：包路径必须与记录一致，不一致直接抛错（路由层映射成 422），
  // **不是**静默返回 null —— 「按记录里的路径直接读」正是要防的那件事。
  await assert.rejects(
    () => service.readPackageArticle({ ...record, packagePath: `${record.packagePath}-evil` }),
    (error: unknown) => error instanceof PublishingAssetError,
  );

  await rm(path.join(result.packagePath, "article.html"), { force: true });
  assert.equal(await service.readPackageArticle(record), null);
});

/** article 包记录（`video*` 字段按 note 包口径承载图片清单哈希）。 */
function articlePackageRecord(
  result: Awaited<ReturnType<PublishingAssetService["createArticlePackageAssets"]>>,
): DeliveryPackage {
  return {
    id: "package-1",
    sourceJobId: "job-1",
    version: 1,
    state: "active",
    title: "发布包标题",
    packagePath: result.packagePath,
    ...(result.coverPath ? { coverPath: result.coverPath } : {}),
    videoSha256: result.imageManifestSha256,
    videoSize: result.imageSize,
    videoMethod: "copy",
    assetHealth: result.assetHealth,
    contentType: "article",
    imagePaths: [...result.imagePaths],
    articleCopy: { title: "为什么没人看完", htmlSha256: result.htmlSha256 },
    createdBy: ACTOR,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}
