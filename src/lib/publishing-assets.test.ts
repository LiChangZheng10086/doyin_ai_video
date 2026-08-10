import assert from "node:assert/strict";
import {
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

test("packages one handle-copied MP4 with safe manifest and shared platform projections", async () => {
  const { storageRoot, input } = await fixture();
  (input.actor as ActorSnapshot & { apiKey: string }).apiKey = "must-not-be-projected";
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
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

  assert.equal(result.videoMethod, "copy");
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

test("uses secure handle copy without invoking path-based clone", async () => {
  const { storageRoot, input } = await fixture();
  const service = new PublishingAssetService({
    storageRoot,
    now: () => NOW,
    copyFile: async () => { throw new Error("path copy must not package video"); },
    runCommand: async () => { throw new Error("ffmpeg unavailable"); },
  });

  const result = await service.createPackageAssets(input);

  assert.equal(result.videoMethod, "copy");
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
  assert.deepEqual(calls[0].args.slice(0, 8), ["-y", "-ss", "1", "-i", await realpath(input.sourceVideoPath), "-frames:v", "1", "-q:v"]);
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
