import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ActorSnapshot,
  CreatePublishingPackageInput,
  JobRecord,
  PublishPlatform,
  PublishingPackageDetail,
} from "../types.js";
import { PublishingAssetService } from "./publishing-assets.js";
import { PublishingService, PublishingServiceError } from "./publishing-service.js";
import { PublishingStore } from "./publishing-store.js";
import { LocalStorage } from "./storage.js";
import { resolveJobVideo } from "./video-output.js";

const START = new Date("2026-08-10T02:00:00.000Z");
const ACTOR: ActorSnapshot = {
  userId: "publisher-1",
  displayName: "发布员",
  role: "publisher",
};
const ADMIN: ActorSnapshot = {
  userId: "admin-1",
  displayName: "管理员",
  role: "admin",
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "publishing-service-"));
  const storage = new LocalStorage(storageRoot);
  await storage.ensureBaseDirs();
  const clock = { now: new Date(START) };
  const store = new PublishingStore(storage, () => new Date(clock.now));
  await store.init();
  const jobs = new Map<string, JobRecord>();

  async function addJob(jobId: string) {
    const videoPath = path.join(storageRoot, "output", "videos", jobId, "video.mp4");
    const scriptPath = path.join(storageRoot, "processed", "scripts", `${jobId}.json`);
    const cleanedPath = path.join(storageRoot, "processed", "cleaned", `${jobId}.json`);
    const coverPath = path.join(storageRoot, "output", "covers", `${jobId}.jpg`);
    await mkdir(path.dirname(videoPath), { recursive: true });
    await writeFile(videoPath, Buffer.from(`mp4:${jobId}:content`));
    await writeFile(coverPath, Buffer.from(`cover:${jobId}`));
    await writeFile(scriptPath, JSON.stringify({
      title: `${jobId} 标题`,
      hyperframesVideo: {
        videoPath,
        width: 1080,
        height: 1920,
        duration: 42,
      },
    }));
    await writeFile(cleanedPath, JSON.stringify({
      output: {
        title: `${jobId} 标题`,
        summary: `${jobId} 摘要`,
        keyPoints: ["要点"],
        shortVideoScript: "短视频脚本",
        tags: ["效率"],
      },
    }));
    const job: JobRecord = {
      id: jobId,
      sourceUrl: `https://example.com/${jobId}`,
      topic: `${jobId} 主题`,
      status: "done",
      stage: "rendered",
      storagePath: path.relative(storageRoot, scriptPath),
      videoOutputPath: videoPath,
      createdAt: START.toISOString(),
      updatedAt: START.toISOString(),
    };
    jobs.set(jobId, job);
    return { videoPath, scriptPath, cleanedPath, coverPath };
  }

  const primary = await addJob("job-1");
  const assets = new PublishingAssetService({
    storageRoot,
    now: () => new Date(clock.now),
    runCommand: async () => { throw new Error("ffmpeg should not be needed"); },
  });
  const copy = {
    async previewAll(_cleaned: unknown, platforms: PublishPlatform[]) {
      return {
        copies: Object.fromEntries(platforms.map((platform) => [platform, {
          title: `${platform} 标题`,
          description: `${platform} 正文`,
          hashtags: ["效率", platform],
          copySource: "ai" as const,
        }])),
      };
    },
  };
  const jobReader = { get: async (jobId: string) => jobs.get(jobId) ?? null };
  const service = new PublishingService({
    storageRoot,
    jobs: jobReader,
    store,
    assets,
    copy,
    now: () => new Date(clock.now),
  });

  return { storageRoot, storage, store, assets, copy, jobReader, service, clock, jobs, addJob, ...primary };
}

async function createPackage(
  f: Fixture,
  platforms: PublishPlatform[] = ["douyin"],
  schedules: Partial<Record<PublishPlatform, string>> = {},
): Promise<PublishingPackageDetail> {
  const preview = await f.service.preview("job-1", platforms);
  const input: CreatePublishingPackageInput = {
    sourceJobId: "job-1",
    previewRevision: preview.previewRevision,
    title: "发布包标题",
    platforms: platforms.map((platform) => ({
      platform,
      copy: preview.copies[platform]!,
      copySource: preview.copies[platform]!.copySource,
      ...(schedules[platform] ? { scheduledAt: schedules[platform] } : {}),
    })),
  };
  return f.service.create(input, ACTOR);
}

async function indexBytes(f: Fixture): Promise<Buffer> {
  return readFile(path.join(f.storageRoot, "cache", "publishing-index.json"));
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("preview validates assets and returns copy without persistence or formal directories", async () => {
  const f = await fixture();
  const before = await indexBytes(f);

  const preview = await f.service.preview("job-1", ["bilibili", "douyin"]);

  assert.equal(preview.video.width, 1080);
  assert.equal(preview.video.height, 1920);
  assert.equal(preview.video.duration, 42);
  assert.equal(preview.video.coverAvailable, true);
  assert.deepEqual(await indexBytes(f), before);
  assert.equal(await exists(preview.expectedPackagePath), false);
  assert.equal(await exists(path.join(f.storageRoot, "output", "publishing")), false);
});

test("preview revision includes canonical video metadata, cleaned mtime and sorted platforms", async () => {
  const f = await fixture();
  const first = await f.service.preview("job-1", ["douyin", "bilibili"]);
  const reordered = await f.service.preview("job-1", ["bilibili", "douyin"]);
  const videoPath = await realpath(f.videoPath);
  const video = await stat(videoPath);
  const cleaned = await stat(f.cleanedPath);
  const expected = createHash("sha256")
    .update("job-1")
    .update(videoPath)
    .update(String(video.size))
    .update(String(video.mtimeMs))
    .update(String(cleaned.mtimeMs))
    .update("bilibili,douyin")
    .digest("hex");

  assert.equal(first.previewRevision, expected);
  assert.equal(reordered.previewRevision, expected);

  const changedTime = new Date(cleaned.mtimeMs + 10_000);
  await utimes(f.cleanedPath, changedTime, changedTime);
  const changed = await f.service.preview("job-1", ["douyin", "bilibili"]);
  assert.notEqual(changed.previewRevision, expected);
});

test("preview and create close resolver resources after use", async () => {
  const f = await fixture();
  let closes = 0;
  const service = new PublishingService({
    storageRoot: f.storageRoot,
    jobs: f.jobReader,
    store: f.store,
    assets: f.assets,
    copy: f.copy,
    now: () => new Date(f.clock.now),
    resolveVideo: async (storageRoot, job) => {
      const resolved = await resolveJobVideo(storageRoot, job);
      return {
        ...resolved,
        async close() {
          closes += 1;
          await resolved.close();
          throw new Error("close cleanup failed");
        },
      };
    },
  });

  const preview = await service.preview("job-1", ["douyin"]);
  assert.equal(closes, 1);
  await service.create({
    sourceJobId: "job-1",
    previewRevision: preview.previewRevision,
    title: "关闭资源测试",
    platforms: [{ platform: "douyin", copy: preview.copies.douyin!, copySource: "ai" }],
  }, ACTOR);
  assert.equal(closes, 2);
});

test("preview revision uses the opened video inode when its path is replaced", async () => {
  const f = await fixture();
  let openedMtimeMs = 0;
  let openedPath = "";
  const service = new PublishingService({
    storageRoot: f.storageRoot,
    jobs: f.jobReader,
    store: f.store,
    assets: f.assets,
    copy: f.copy,
    now: () => new Date(f.clock.now),
    resolveVideo: async (storageRoot, job) => {
      const resolved = await resolveJobVideo(storageRoot, job);
      openedPath = resolved.path;
      openedMtimeMs = (await resolved.handle.stat()).mtimeMs;
      await rename(resolved.path, `${resolved.path}.original`);
      await writeFile(resolved.path, "replacement mp4 with different metadata");
      return resolved;
    },
  });

  const preview = await service.preview("job-1", ["douyin"]);
  const cleaned = await stat(f.cleanedPath);
  const expected = createHash("sha256")
    .update("job-1")
    .update(openedPath)
    .update(String(Buffer.byteLength("mp4:job-1:content")))
    .update(String(openedMtimeMs))
    .update(String(cleaned.mtimeMs))
    .update("douyin")
    .digest("hex");

  assert.equal(preview.previewRevision, expected);
});

test("create copies the same opened source video instance used for revision validation", async () => {
  const f = await fixture();
  const originalBytes = await readFile(f.videoPath);
  const preview = await f.service.preview("job-1", ["douyin"]);
  const originalCreateAssets = f.assets.createPackageAssets.bind(f.assets);
  f.assets.createPackageAssets = async (input) => {
    await rename(f.videoPath, `${f.videoPath}.validated`);
    await writeFile(f.videoPath, "replacement after revision validation");
    return originalCreateAssets(input);
  };

  const created = await f.service.create({
    sourceJobId: "job-1",
    previewRevision: preview.previewRevision,
    title: "发布包",
    platforms: [{ platform: "douyin", copy: preview.copies.douyin!, copySource: "ai" }],
  }, ACTOR);

  assert.deepEqual(await readFile(created.package.videoPath!), originalBytes);
});

test("create revalidates preview before reserving a version or writing assets", async () => {
  const f = await fixture();
  const preview = await f.service.preview("job-1", ["douyin"]);
  await writeFile(f.videoPath, "changed source mp4");
  const before = await indexBytes(f);

  await assert.rejects(
    f.service.create({
      sourceJobId: "job-1",
      previewRevision: preview.previewRevision,
      title: "发布包",
      platforms: [{
        platform: "douyin",
        copy: preview.copies.douyin!,
        copySource: "ai",
      }],
    }, ACTOR),
    (error: unknown) => {
      assert.ok(error instanceof PublishingServiceError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "publish_revision_conflict");
      assert.match(error.message, /预览.*变化/u);
      return true;
    },
  );

  assert.deepEqual(await indexBytes(f), before);
  assert.equal((await f.store.snapshot()).nextVersionBySource["job-1"], undefined);
  assert.equal(await exists(path.join(f.storageRoot, "output", "publishing")), false);
});

test("create rolls back a promoted directory when index commit fails and keeps the version consumed", async () => {
  const f = await fixture();
  const preview = await f.service.preview("job-1", ["douyin"]);
  const originalCommit = f.store.commitPackage.bind(f.store);
  f.store.commitPackage = async () => { throw new Error("index commit failed"); };

  await assert.rejects(f.service.create({
    sourceJobId: "job-1",
    previewRevision: preview.previewRevision,
    title: "发布包",
    platforms: [{ platform: "douyin", copy: preview.copies.douyin!, copySource: "ai" }],
  }, ACTOR), /发布索引写入失败/u);

  const snapshot = await f.store.snapshot();
  assert.equal(snapshot.nextVersionBySource["job-1"], 2);
  assert.deepEqual(snapshot.packages, {});
  assert.deepEqual(
    snapshot.audit.find((event) => event.action === "source.reserve_version")?.actor,
    ACTOR,
  );
  assert.deepEqual(await findFormalPackages(f.storageRoot), []);

  f.store.commitPackage = originalCommit;
  const created = await createPackage(f);
  assert.equal(created.package.version, 2);
});

test("create reports index and rollback failure while leaving an orphan for startup recovery", async () => {
  const f = await fixture();
  const preview = await f.service.preview("job-1", ["douyin"]);
  const originalCreateAssets = f.assets.createPackageAssets.bind(f.assets);
  f.assets.createPackageAssets = async (input) => {
    const result = await originalCreateAssets(input);
    return {
      ...result,
      async rollback() {
        throw new Error("rollback failed at private path");
      },
    };
  };
  f.store.commitPackage = async () => { throw new Error("index failed at private path"); };

  await assert.rejects(f.service.create({
    sourceJobId: "job-1",
    previewRevision: preview.previewRevision,
    title: "发布包",
    platforms: [{ platform: "douyin", copy: preview.copies.douyin!, copySource: "ai" }],
  }, ACTOR), (error: unknown) => {
    assert.ok(error instanceof PublishingServiceError);
    assert.equal(error.status, 500);
    assert.equal(error.code, "publish_consistency_failed");
    assert.match(error.message, /索引写入失败.*资产回滚失败.*重启/u);
    assert.deepEqual(error.details, {
      failedStages: ["index_commit", "asset_rollback"],
      recovery: "startup_scan",
    });
    assert.doesNotMatch(JSON.stringify(error), /private path/u);
    return true;
  });

  const orphanPath = await realpath((await findFormalPackages(f.storageRoot))[0]);
  const report = await f.service.recoverOnStartup();
  assert.deepEqual(report.orphanPaths, [orphanPath]);
});

test("create normalizes current or past schedules into ready tasks without stale schedule fields", async () => {
  const f = await fixture();
  const past = new Date(f.clock.now.getTime() - 60_000).toISOString();

  const created = await createPackage(f, ["douyin"], { douyin: past });

  assert.equal(created.tasks[0].status, "ready");
  assert.equal(created.tasks[0].scheduledAt, undefined);
});

test("createVersion copies platform content but never copies terminal states", async () => {
  const f = await fixture();
  const original = await createPackage(f, ["douyin", "xiaohongshu", "bilibili"]);
  await f.service.markPublished(original.tasks.find((task) => task.platform === "douyin")!.id, ACTOR);
  await f.service.recordFailure(
    original.tasks.find((task) => task.platform === "xiaohongshu")!.id,
    "平台拒绝",
    ACTOR,
  );
  await f.service.cancel(original.tasks.find((task) => task.platform === "bilibili")!.id, ACTOR);
  const future = new Date(f.clock.now.getTime() + 60_000).toISOString();

  const next = await f.service.createVersion(original.package.id, {
    schedules: { bilibili: future },
  }, ACTOR);

  assert.equal(next.package.version, 2);
  assert.deepEqual(next.tasks.map((task) => task.platform).sort(), ["bilibili", "douyin", "xiaohongshu"]);
  assert.deepEqual(
    next.tasks.map((task) => [task.platform, task.title]).sort(),
    original.tasks.map((task) => [task.platform, task.title]).sort(),
  );
  assert.equal(next.tasks.find((task) => task.platform === "douyin")!.status, "ready");
  assert.equal(next.tasks.find((task) => task.platform === "xiaohongshu")!.status, "ready");
  assert.equal(next.tasks.find((task) => task.platform === "bilibili")!.status, "scheduled");
  assert.ok(next.tasks.every((task) => !task.publishedAt && !task.lastError && !task.dueNotifiedAt));
});

test("createVersion copies the same opened package video instance used for validation", async () => {
  const f = await fixture();
  const original = await createPackage(f);
  const originalBytes = await readFile(original.package.videoPath!);
  const originalCreateAssets = f.assets.createPackageAssets.bind(f.assets);
  f.assets.createPackageAssets = async (input) => {
    await rename(original.package.videoPath!, `${original.package.videoPath}.validated`);
    await writeFile(original.package.videoPath!, "replacement after package validation");
    return originalCreateAssets(input);
  };

  const next = await f.service.createVersion(original.package.id, {}, ACTOR);

  assert.deepEqual(await readFile(next.package.videoPath!), originalBytes);
});

test("markPublished persists broken video health without publishing the task", async () => {
  const f = await fixture();
  const created = await createPackage(f);
  const task = created.tasks[0];
  await writeFile(created.package.videoPath!, "broken");

  await assert.rejects(f.service.markPublished(task.id, ACTOR), (error: unknown) => {
    assert.ok(error instanceof PublishingServiceError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "publish_asset_broken");
    return true;
  });

  assert.equal((await f.store.getTask(task.id))!.status, task.status);
  assert.equal((await f.store.getTask(task.id))!.publishedAt, undefined);
  assert.equal((await f.store.getPackage(created.package.id))!.package.assetHealth, "broken_video");
});

test("published content is rejected before projection staging with byte-for-byte no-write semantics", async () => {
  const f = await fixture();
  const created = await createPackage(f);
  const published = await f.service.markPublished(created.tasks[0].id, ACTOR);
  const beforeIndex = await indexBytes(f);
  const projection = path.join(created.package.packagePath, "platforms", "douyin", "title.txt");
  const beforeProjection = await readFile(projection);
  let stageCalls = 0;
  const originalStage = f.assets.stageTextProjection.bind(f.assets);
  f.assets.stageTextProjection = async (detail) => {
    stageCalls += 1;
    return originalStage(detail);
  };

  await assert.rejects(
    f.service.updateContent(published.id, {
      title: "不应写入",
      description: "正文",
      hashtags: ["标签"],
      expectedRevision: published.contentRevision,
    }, ACTOR),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /已发布/u);
      return true;
    },
  );

  assert.equal(stageCalls, 0);
  assert.deepEqual(await indexBytes(f), beforeIndex);
  assert.deepEqual(await readFile(projection), beforeProjection);
  assert.equal((await f.store.getTask(published.id))!.contentRevision, published.contentRevision);
});

test("content edit restores exact projection and index bytes when index commit fails", async () => {
  const f = await fixture();
  const created = await createPackage(f);
  const task = created.tasks[0];
  const beforeIndex = await indexBytes(f);
  const projectionRoot = path.join(created.package.packagePath, "platforms");
  const beforeProjection = await snapshotBytes(projectionRoot);
  f.store.updateContent = async () => { throw new Error("atomic index rename failed"); };

  await assert.rejects(f.service.updateContent(task.id, {
    title: "新标题",
    description: "新正文",
    hashtags: ["新标签"],
    expectedRevision: task.contentRevision,
  }, ACTOR), /发布索引写入失败/u);

  assert.deepEqual(await indexBytes(f), beforeIndex);
  assert.deepEqual(await snapshotBytes(projectionRoot), beforeProjection);
});

test("content edit finalizes projection backup only after the index commit succeeds", async () => {
  const f = await fixture();
  const created = await createPackage(f);
  const task = created.tasks[0];
  const originalStage = f.assets.stageTextProjection.bind(f.assets);
  let finalizeCalls = 0;
  f.assets.stageTextProjection = async (detail) => {
    const transaction = await originalStage(detail);
    return {
      ...transaction,
      async finalize() {
        finalizeCalls += 1;
        await (transaction as { finalize?: () => Promise<void> }).finalize?.();
      },
    };
  };

  const updated = await f.service.updateContent(task.id, {
    title: "提交后的新标题",
    description: "正文",
    hashtags: ["标签"],
    expectedRevision: task.contentRevision,
  }, ACTOR);

  assert.equal(updated.title, "提交后的新标题");
  assert.equal(finalizeCalls, 1);
});

test("content edit returns the committed update when projection cleanup fails", async () => {
  const f = await fixture();
  const created = await createPackage(f);
  const task = created.tasks[0];
  const originalStage = f.assets.stageTextProjection.bind(f.assets);
  f.assets.stageTextProjection = async (detail) => {
    const transaction = await originalStage(detail);
    return {
      ...transaction,
      async finalize() {
        throw new Error("stale backup cleanup failed");
      },
    };
  };

  const updated = await f.service.updateContent(task.id, {
    title: "已经提交的新标题",
    description: "已经提交的新正文",
    hashtags: ["已提交"],
    expectedRevision: task.contentRevision,
  }, ACTOR);

  assert.equal(updated.title, "已经提交的新标题");
  assert.equal((await f.store.getTask(task.id))!.title, "已经提交的新标题");
  assert.equal(
    await readFile(path.join(created.package.packagePath, "platforms", "douyin", "title.txt"), "utf8"),
    "已经提交的新标题",
  );
});

test("startup recovery reports asset phases before due handling and purge", async () => {
  const f = await fixture();
  const future = new Date(f.clock.now.getTime() + 60_000).toISOString();
  const due = await createPackage(f, ["douyin"], { douyin: future });
  const broken = await createPackage(f, ["bilibili"]);
  const trash = await createPackage(f, ["wechat_channels"]);
  await f.service.trashPackage(trash.package.id, ADMIN);

  await rm(path.join(due.package.packagePath, "platforms"), { recursive: true });
  await rm(broken.package.videoPath!);
  const staleTemp = path.join(f.storageRoot, "output", "publishing", "job-1", ".next-stale");
  const orphan = path.join(f.storageRoot, "output", "publishing", "job-1", "v99-orphan");
  await mkdir(staleTemp, { recursive: true });
  await mkdir(orphan, { recursive: true });
  const canonicalSourceDirectory = await realpath(path.dirname(staleTemp));
  const canonicalStaleTemp = path.join(canonicalSourceDirectory, path.basename(staleTemp));
  const canonicalOrphan = path.join(canonicalSourceDirectory, path.basename(orphan));
  f.clock.now = new Date(START.getTime() + 31 * 24 * 60 * 60 * 1000);
  const recoveryOrder: string[] = [];
  const originalScan = f.assets.scanAndRepair.bind(f.assets);
  const originalDue = f.store.processDue.bind(f.store);
  const originalPurge = f.assets.purgeAssets.bind(f.assets);
  f.assets.scanAndRepair = async (index) => {
    recoveryOrder.push("temp-orphan-video-projection");
    return originalScan(index);
  };
  f.store.processDue = async (now) => {
    recoveryOrder.push("due");
    return originalDue(now);
  };
  f.assets.purgeAssets = async (pkg) => {
    recoveryOrder.push("purge");
    return originalPurge(pkg);
  };

  const report = await f.service.recoverOnStartup();

  assert.deepEqual(recoveryOrder, ["temp-orphan-video-projection", "due", "purge"]);
  assert.deepEqual(report.removedTempPaths, [canonicalStaleTemp]);
  assert.deepEqual(report.orphanPaths, [canonicalOrphan]);
  assert.deepEqual(report.repairedPackageIds, [due.package.id]);
  assert.deepEqual(report.brokenPackageIds, [broken.package.id]);
  assert.deepEqual(report.notifications.map((item) => item.packageId), [due.package.id]);
  assert.deepEqual(report.purgedPackageIds, [trash.package.id]);
  assert.deepEqual(report.purgeFailures, []);
  assert.deepEqual(report.repairFailures, []);
  assert.deepEqual(report.scanFailures, []);
  assert.equal((await f.store.getPackage(broken.package.id))!.package.assetHealth, "broken_video");
  assert.equal((await f.store.getTask(due.tasks[0].id))!.status, "ready");
  const purged = (await f.store.getPackage(trash.package.id))!;
  assert.equal(purged.package.state, "purged");
  assert.equal(purged.tombstone!.videoSha256, trash.package.videoSha256);
  assert.deepEqual(purged.audit.at(-1)!.actor, {
    userId: "system",
    displayName: "系统",
    role: "system",
  });
});

test("restoring a trashed package immediately returns notifications for overdue schedules", async () => {
  const f = await fixture();
  const future = new Date(f.clock.now.getTime() + 60_000).toISOString();
  const created = await createPackage(f, ["douyin"], { douyin: future });
  const unrelated = await createPackage(f, ["bilibili"], { bilibili: future });
  await f.service.trashPackage(created.package.id, ADMIN);
  f.clock.now = new Date(f.clock.now.getTime() + 2 * 60 * 60 * 1000);

  const restored = await f.service.restorePackage(created.package.id, ADMIN);

  assert.equal(restored.package.state, "active");
  assert.equal(restored.notifications.length, 1);
  assert.equal(restored.notifications[0].taskId, created.tasks[0].id);
  const task = await f.store.getTask(created.tasks[0].id);
  assert.equal(task!.status, "ready");
  assert.ok(task!.dueNotifiedAt);
  assert.equal((await f.store.getTask(unrelated.tasks[0].id))!.status, "scheduled");
  assert.equal((await f.store.getTask(unrelated.tasks[0].id))!.dueNotifiedAt, undefined);
});

test("a created package stays verifiable and Finder-safe after source artifacts are deleted", async () => {
  const f = await fixture();
  const created = await createPackage(f);
  await rm(path.dirname(f.videoPath), { recursive: true, force: true });
  await rm(f.scriptPath, { force: true });
  await rm(f.cleanedPath, { force: true });
  f.jobs.delete("job-1");

  assert.equal(await f.assets.verifyPackageVideo(created.package), "healthy");
  assert.equal(await f.service.getFinderVideoPath(created.package.id), created.package.videoPath);
  assert.deepEqual(await readFile(created.package.videoPath!), Buffer.from("mp4:job-1:content"));
});

test("invalid drafts fail in Simplified Chinese without consuming versions or staging assets", async () => {
  const f = await fixture();
  const preview = await f.service.preview("job-1", ["douyin"]);
  const before = await indexBytes(f);

  await assert.rejects(f.service.create({
    sourceJobId: "job-1",
    previewRevision: preview.previewRevision,
    title: "发布包",
    platforms: [{ platform: "douyin", copy: { title: "", description: "", hashtags: [] }, copySource: "ai" }],
  }, ACTOR), (error: unknown) => {
    assert.ok(error instanceof PublishingServiceError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "publish_validation_failed");
    assert.match(error.message, /标题不能为空/u);
    return true;
  });

  assert.deepEqual(await indexBytes(f), before);
  assert.equal((await f.store.snapshot()).nextVersionBySource["job-1"], undefined);
  assert.equal(await exists(path.join(f.storageRoot, "output", "publishing")), false);
});

test("missing entities return stable Simplified Chinese errors without index writes", async () => {
  const f = await fixture();
  const before = await indexBytes(f);

  await assert.rejects(f.service.cancel("missing-task", ACTOR), (error: unknown) => {
    assert.ok(error instanceof PublishingServiceError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "publish_task_not_found");
    assert.equal(error.message, "未找到发布任务");
    return true;
  });

  assert.deepEqual(await indexBytes(f), before);
});

test("publishing service does not expose the unused debug index hash API", async () => {
  const f = await fixture();
  assert.equal("debugIndexHash" in f.service, false);
});

async function findFormalPackages(storageRoot: string): Promise<string[]> {
  const root = path.join(storageRoot, "output", "publishing");
  const result: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^v\d+-/u.test(entry.name)) result.push(candidate);
        else await visit(candidate);
      }
    }
  }
  await visit(root);
  return result.sort();
}

async function snapshotBytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) result[path.relative(root, candidate)] = (await readFile(candidate)).toString("base64");
    }
  }
  await visit(root);
  return result;
}
