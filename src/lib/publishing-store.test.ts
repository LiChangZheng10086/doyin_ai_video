import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalStorage } from "./storage.js";
import { SYSTEM_ACTOR } from "./local-users.js";
import type {
  ActorSnapshot,
  DeliveryPackage,
  PublishTask,
  PublishTaskStatus,
  PublishingIndex,
  PublishingTombstone,
} from "../types.js";
import { PublishingError, PublishingStore } from "./publishing-store.js";

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
const NOW = "2026-08-10T08:00:00.000Z";

async function fixture(now = new Date("2026-08-10T08:00:00.000Z")) {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-"));
  const storage = new LocalStorage(root);
  const store = new PublishingStore(storage, () => new Date(now));
  await store.init();
  return { root, storage, store };
}

function packageRecord(overrides: Partial<DeliveryPackage> = {}): DeliveryPackage {
  return {
    id: "package-1",
    sourceJobId: "job-1",
    version: 1,
    state: "active",
    title: "测试作品",
    packagePath: "/tmp/publishing/job-1/v1-package-1",
    videoPath: "/tmp/publishing/job-1/v1-package-1/video.mp4",
    videoSha256: "sha256",
    videoSize: 1024,
    videoMethod: "clone",
    assetHealth: "healthy",
    createdBy: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function taskRecord(
  status: PublishTaskStatus = "ready",
  overrides: Partial<PublishTask> = {}
): PublishTask {
  return {
    id: "task-1",
    packageId: "package-1",
    platform: "douyin",
    title: "标题",
    description: "正文",
    hashtags: ["AI"],
    copySource: "ai",
    status,
    contentRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function seededIndex(
  packages: DeliveryPackage[],
  tasks: PublishTask[],
  revision = 2
): PublishingIndex {
  return {
    schemaVersion: 1,
    revision,
    nextVersionBySource: { "job-1": 2 },
    packages: Object.fromEntries(packages.map((item) => [item.id, item])),
    tasks: Object.fromEntries(tasks.map((item) => [item.id, item])),
    audit: [],
    tombstones: {},
  };
}

async function seededFixture(status: PublishTaskStatus = "ready") {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-seeded-"));
  const storage = new LocalStorage(root);
  await storage.writeJsonAtomic(
    "cache/publishing-index.json",
    seededIndex([packageRecord()], [taskRecord(status)])
  );
  const store = new PublishingStore(storage, () => new Date(NOW));
  await store.init();
  return {
    root,
    storage,
    store,
    readIndexBytes: () => readFile(path.join(root, "cache", "publishing-index.json")),
  };
}

test("allocates unique monotonically increasing versions for one source", async () => {
  const { store } = await fixture();

  const versions = await Promise.all(
    Array.from({ length: 8 }, () => store.reserveVersion("job-1"))
  );

  assert.deepEqual([...versions].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await store.snapshot()).nextVersionBySource["job-1"], 9);
});

test("changes status and appends actor audit in one persisted revision", async () => {
  const { store, storage } = await seededFixture("ready");

  await store.markPublished("task-1", ACTOR, NOW);

  const index = await store.snapshot();
  const persisted = await storage.readJson<PublishingIndex>("cache/publishing-index.json");
  assert.equal(index.revision, 3);
  assert.equal(index.tasks["task-1"].status, "published");
  assert.equal(index.tasks["task-1"].publishedAt, NOW);
  assert.equal(index.audit.at(-1)?.action, "task.mark_published");
  assert.deepEqual(index.audit.at(-1)?.actor, ACTOR);
  assert.deepEqual(persisted, index);
});

test("rejects published to failed without writing", async () => {
  const { store, readIndexBytes } = await seededFixture("published");
  const before = await readIndexBytes();

  await assert.rejects(
    () => store.recordFailure("task-1", "平台拒绝", ACTOR),
    (error: PublishingError) => error.code === "publish_invalid_transition"
  );

  assert.deepEqual(await readIndexBytes(), before);
});

test("rejects a stale content revision without overwriting content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-revision-"));
  const storage = new LocalStorage(root);
  await storage.writeJsonAtomic(
    "cache/publishing-index.json",
    seededIndex([packageRecord()], [taskRecord("ready", { contentRevision: 2 })], 7)
  );
  const store = new PublishingStore(storage, () => new Date(NOW));
  await store.init();
  const indexPath = path.join(root, "cache", "publishing-index.json");
  const before = await readFile(indexPath);

  await assert.rejects(
    () => store.updateContent("task-1", {
      title: "旧客户端标题",
      description: "旧客户端正文",
      hashtags: ["旧标签"],
      expectedRevision: 1,
    }, ACTOR),
    (error: PublishingError) => error.code === "publish_revision_conflict"
  );

  assert.deepEqual(await readFile(indexPath), before);
  assert.equal((await store.getTask("task-1"))?.title, "标题");
});

test("records an action error without changing task status or content revision", async () => {
  const { store, storage } = await seededFixture("ready");
  const before = await store.getTask("task-1");

  await store.recordActionError(
    "task-1",
    "open_platform",
    "无法打开创作平台",
    ACTOR
  );

  const after = await store.getTask("task-1");
  const persisted = await storage.readJson<PublishingIndex>("cache/publishing-index.json");
  assert.equal(after?.status, before?.status);
  assert.equal(after?.contentRevision, before?.contentRevision);
  assert.equal(persisted.revision, 3);
  assert.deepEqual(persisted.audit.at(-1), {
    id: persisted.audit.at(-1)?.id,
    packageId: "package-1",
    taskId: "task-1",
    action: "task.action_error",
    actor: ACTOR,
    reason: "无法打开创作平台",
    metadata: { action: "open_platform" },
    createdAt: NOW,
  });
});

test("processes only newly due tasks from active packages with the system actor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-due-"));
  const storage = new LocalStorage(root);
  const activePackage = packageRecord();
  const notifiedPackage = packageRecord({ id: "package-2", version: 2 });
  const trashedPackage = packageRecord({
    id: "package-3",
    version: 3,
    state: "trashed",
    deletedAt: "2026-08-01T00:00:00.000Z",
    purgeAt: "2026-08-31T00:00:00.000Z",
  });
  const dueAt = "2026-08-10T07:55:00.000Z";
  const due = taskRecord("scheduled", { scheduledAt: dueAt });
  const notified = taskRecord("scheduled", {
    id: "task-2",
    packageId: "package-2",
    scheduledAt: dueAt,
    dueNotifiedAt: "2026-08-10T07:56:00.000Z",
  });
  const trashed = taskRecord("scheduled", {
    id: "task-3",
    packageId: "package-3",
    scheduledAt: dueAt,
  });
  await storage.writeJsonAtomic(
    "cache/publishing-index.json",
    seededIndex(
      [activePackage, notifiedPackage, trashedPackage],
      [due, notified, trashed]
    )
  );
  const store = new PublishingStore(storage, () => new Date(NOW));
  await store.init();

  const notifications = await store.processDue();
  const index = await store.snapshot();

  assert.deepEqual(notifications, [{
    taskId: "task-1",
    packageId: "package-1",
    platform: "douyin",
    platformLabel: "抖音",
    title: "标题",
    scheduledAt: dueAt,
    becameReadyAt: NOW,
    overdueMs: 300_000,
  }]);
  assert.equal(index.tasks["task-1"].status, "ready");
  assert.equal(index.tasks["task-1"].dueNotifiedAt, NOW);
  assert.equal(index.tasks["task-2"].status, "scheduled");
  assert.equal(index.tasks["task-3"].status, "scheduled");
  assert.deepEqual(index.audit.at(-1)?.actor, SYSTEM_ACTOR);
  assert.equal(index.audit.at(-1)?.action, "task.due");
  const beforeNoop = await readFile(path.join(root, "cache", "publishing-index.json"));
  assert.deepEqual(await store.processDue(), []);
  assert.deepEqual(
    await readFile(path.join(root, "cache", "publishing-index.json")),
    beforeNoop
  );
});

test("trashes a package for exactly 30 days without changing task states", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-trash-"));
  const storage = new LocalStorage(root);
  const scheduled = taskRecord("scheduled", {
    scheduledAt: "2026-08-20T08:00:00.000Z",
  });
  const published = taskRecord("published", {
    id: "task-2",
    publishedAt: "2026-08-09T08:00:00.000Z",
  });
  await storage.writeJsonAtomic(
    "cache/publishing-index.json",
    seededIndex([packageRecord()], [scheduled, published])
  );
  const store = new PublishingStore(storage, () => new Date(NOW));
  await store.init();

  const trashed = await store.trashPackage("package-1", ACTOR);
  const index = await store.snapshot();

  assert.equal(trashed.state, "trashed");
  assert.equal(trashed.deletedAt, NOW);
  assert.equal(trashed.purgeAt, "2026-09-09T08:00:00.000Z");
  assert.equal(index.tasks["task-1"].status, "scheduled");
  assert.equal(index.tasks["task-2"].status, "published");
  assert.equal(index.audit.at(-1)?.action, "package.trash");
  assert.deepEqual(index.audit.at(-1)?.actor, ACTOR);

  const restored = await store.restorePackage("package-1", ACTOR);
  assert.equal(restored.state, "active");
  assert.equal(restored.deletedAt, undefined);
  assert.equal(restored.purgeAt, undefined);
  const restoredIndex = await store.snapshot();
  assert.equal(restoredIndex.tasks["task-1"].status, "scheduled");
  assert.equal(restoredIndex.tasks["task-2"].status, "published");
  assert.deepEqual(restoredIndex.audit.map((event) => event.action), [
    "package.trash",
    "package.restore",
  ]);
});

test("preserves a malformed index and protects every subsequent mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-corrupt-"));
  const indexPath = path.join(root, "cache", "publishing-index.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  const malformed = Buffer.from('{"schemaVersion":1,"packages":');
  await writeFile(indexPath, malformed);
  const store = new PublishingStore(new LocalStorage(root), () => new Date(NOW));

  await store.init();

  assert.deepEqual(await readFile(indexPath), malformed);
  assert.deepEqual(await store.snapshot(), {
    schemaVersion: 1,
    revision: 0,
    nextVersionBySource: {},
    packages: {},
    tasks: {},
    audit: [],
    tombstones: {},
  });
  for (const mutation of [
    () => store.reserveVersion("job-1"),
    () => store.recordActionError("task-1", "open_platform", "失败", ACTOR),
    () => store.trashPackage("package-1", ACTOR),
  ]) {
    await assert.rejects(
      mutation,
      (error: PublishingError) => error.code === "publish_index_corrupt"
    );
    assert.deepEqual(await readFile(indexPath), malformed);
  }
});

test("treats structurally malformed JSON as a read-only corrupt index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-invalid-shape-"));
  const storage = new LocalStorage(root);
  const malformed = {
    schemaVersion: 1,
    revision: 2,
    nextVersionBySource: { "job-1": "two" },
    packages: {},
    tasks: {},
    audit: [],
    tombstones: {},
  };
  await storage.writeJsonAtomic("cache/publishing-index.json", malformed);
  const indexPath = path.join(root, "cache", "publishing-index.json");
  const before = await readFile(indexPath);
  const store = new PublishingStore(storage, () => new Date(NOW));

  await store.init();

  await assert.rejects(
    () => store.reserveVersion("job-1"),
    (error: PublishingError) => error.code === "publish_index_corrupt"
  );
  assert.deepEqual(await readFile(indexPath), before);
});

test("implements every allowed task status transition", async (context) => {
  const future = "2026-08-11T08:00:00.000Z";
  const cases: Array<{
    name: string;
    from: PublishTaskStatus;
    to: PublishTaskStatus;
    run: (store: PublishingStore) => Promise<PublishTask>;
  }> = [
    { name: "scheduled -> ready", from: "scheduled", to: "ready", run: (store) => store.updateSchedule("task-1", null, ACTOR) },
    { name: "scheduled -> cancelled", from: "scheduled", to: "cancelled", run: (store) => store.cancel("task-1", ACTOR) },
    { name: "scheduled -> failed", from: "scheduled", to: "failed", run: (store) => store.recordFailure("task-1", "准备失败", ACTOR) },
    { name: "ready -> scheduled", from: "ready", to: "scheduled", run: (store) => store.updateSchedule("task-1", future, ACTOR) },
    { name: "ready -> published", from: "ready", to: "published", run: (store) => store.markPublished("task-1", ACTOR) },
    { name: "ready -> failed", from: "ready", to: "failed", run: (store) => store.recordFailure("task-1", "发布失败", ACTOR) },
    { name: "ready -> cancelled", from: "ready", to: "cancelled", run: (store) => store.cancel("task-1", ACTOR) },
    { name: "failed -> ready", from: "failed", to: "ready", run: (store) => store.restoreTask("task-1", null, ACTOR) },
    { name: "failed -> scheduled", from: "failed", to: "scheduled", run: (store) => store.restoreTask("task-1", future, ACTOR) },
    { name: "failed -> cancelled", from: "failed", to: "cancelled", run: (store) => store.cancel("task-1", ACTOR) },
    { name: "cancelled -> ready", from: "cancelled", to: "ready", run: (store) => store.restoreTask("task-1", null, ACTOR) },
    { name: "cancelled -> scheduled", from: "cancelled", to: "scheduled", run: (store) => store.restoreTask("task-1", future, ACTOR) },
    { name: "published -> ready", from: "published", to: "ready", run: (store) => store.withdraw("task-1", "本地记录有误", ADMIN) },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "publishing-store-transition-"));
      const storage = new LocalStorage(root);
      await storage.writeJsonAtomic(
        "cache/publishing-index.json",
        seededIndex([packageRecord()], [taskRecord(item.from, {
          scheduledAt: item.from === "scheduled" ? future : undefined,
          dueNotifiedAt: item.from === "ready" ? "2026-08-09T08:00:00.000Z" : undefined,
          publishedAt: item.from === "published" ? "2026-08-09T08:00:00.000Z" : undefined,
          lastError: item.from === "failed" ? "旧错误" : undefined,
        })])
      );
      const store = new PublishingStore(storage, () => new Date(NOW));
      await store.init();

      const task = await item.run(store);
      const audit = (await store.snapshot()).audit.at(-1);

      assert.equal(task.status, item.to);
      assert.equal(audit?.fromStatus, item.from);
      assert.equal(audit?.toStatus, item.to);
      assert.ok(audit?.actor);
      if (item.to === "scheduled") assert.equal(task.dueNotifiedAt, undefined);
    });
  }
});

test("commits a reserved package with an immutable actor snapshot", async () => {
  const { store } = await fixture();
  const version = await store.reserveVersion("job-1");
  const fakeActor: ActorSnapshot = { userId: "fake", displayName: "伪造", role: "publisher" };
  const commitActor: ActorSnapshot = { ...ACTOR };

  const detail = await store.commitPackage({
    package: packageRecord({ version, createdBy: fakeActor }),
    tasks: [taskRecord()],
  }, commitActor);
  commitActor.displayName = "已改名";

  assert.equal(detail.package.version, 1);
  assert.deepEqual(detail.package.createdBy, {
    userId: "publisher-1",
    displayName: "发布员",
    role: "publisher",
  });
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.audit.at(-1)?.action, "package.create");
  assert.deepEqual(detail.audit.at(-1)?.actor, detail.package.createdBy);
});

test("rejects a duplicate source version without writing", async () => {
  const { store, readIndexBytes } = await seededFixture();
  const before = await readIndexBytes();

  await assert.rejects(
    () => store.commitPackage({
      package: packageRecord({ id: "package-duplicate-version" }),
      tasks: [taskRecord("ready", {
        id: "task-duplicate-version",
        packageId: "package-duplicate-version",
      })],
    }, ACTOR),
    (error: PublishingError) => error.code === "publish_revision_conflict"
  );

  assert.deepEqual(await readIndexBytes(), before);
});

test("updates asset health without changing task status and blocks broken publishing", async () => {
  const { store, readIndexBytes } = await seededFixture("ready");

  const packageResult = await store.setAssetHealth("package-1", "broken_video", ACTOR);
  assert.equal(packageResult.assetHealth, "broken_video");
  assert.equal((await store.getTask("task-1"))?.status, "ready");
  const beforePublish = await readIndexBytes();
  await assert.rejects(
    () => store.markPublished("task-1", ACTOR),
    (error: PublishingError) => error.code === "publish_asset_broken"
  );
  assert.deepEqual(await readIndexBytes(), beforePublish);
});

test("marks trashed packages purged with a lightweight tombstone", async () => {
  const purgedAt = "2026-09-10T08:00:00.000Z";
  const tombstone: PublishingTombstone = {
    packageId: "package-1",
    sourceJobId: "job-1",
    version: 1,
    platforms: [{ platform: "douyin", finalStatus: "published" }],
    createdAt: NOW,
    publishedAt: "2026-08-11T08:00:00.000Z",
    deletedAt: "2026-08-12T08:00:00.000Z",
    purgedAt,
    videoSha256: "sha256",
    auditSummary: [],
  };
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-purge-"));
  const storage = new LocalStorage(root);
  await storage.writeJsonAtomic(
    "cache/publishing-index.json",
    seededIndex([
      packageRecord({
        state: "trashed",
        deletedAt: tombstone.deletedAt,
        purgeAt: purgedAt,
      }),
    ], [taskRecord("published", { publishedAt: tombstone.publishedAt })])
  );
  const store = new PublishingStore(storage, () => new Date(purgedAt));
  await store.init();

  await store.markPurged("package-1", tombstone, SYSTEM_ACTOR);

  const index = await store.snapshot();
  assert.equal(index.packages["package-1"].state, "purged");
  assert.equal(index.packages["package-1"].purgedAt, purgedAt);
  assert.equal(index.tasks["task-1"], undefined);
  assert.deepEqual(index.tombstones["package-1"], tombstone);
  assert.equal(index.audit.at(-1)?.action, "package.purge");
  assert.deepEqual(index.audit.at(-1)?.actor, SYSTEM_ACTOR);
});

test("records purge failures without claiming the package was purged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-purge-failure-"));
  const storage = new LocalStorage(root);
  await storage.writeJsonAtomic(
    "cache/publishing-index.json",
    seededIndex([packageRecord({ state: "trashed", deletedAt: NOW, purgeAt: NOW })], [taskRecord()])
  );
  const store = new PublishingStore(storage, () => new Date(NOW));
  await store.init();

  await store.recordPurgeFailure("package-1", "文件被占用", SYSTEM_ACTOR);

  const index = await store.snapshot();
  assert.equal(index.packages["package-1"].state, "trashed");
  assert.equal(index.audit.at(-1)?.action, "package.purge_failed");
  assert.equal(index.audit.at(-1)?.reason, "文件被占用");
});

test("lists packages using action, state, asset and field filters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publishing-store-list-"));
  const storage = new LocalStorage(root);
  const packages = [
    packageRecord({ id: "package-ready", title: "夏日 AI", createdAt: "2026-08-10T04:00:00.000Z" }),
    packageRecord({ id: "package-broken", sourceJobId: "job-2", version: 2, title: "旅行", assetHealth: "broken_video", createdBy: ADMIN, createdAt: "2026-08-10T05:00:00.000Z" }),
    packageRecord({ id: "package-published", sourceJobId: "job-3", version: 3, title: "美食", createdAt: "2026-08-10T06:00:00.000Z" }),
    packageRecord({ id: "package-trash", sourceJobId: "job-4", version: 4, title: "旧稿", state: "trashed", deletedAt: NOW, purgeAt: "2026-09-09T08:00:00.000Z", createdAt: "2026-08-10T07:00:00.000Z" }),
  ];
  const tasks = [
    taskRecord("ready", { id: "task-ready", packageId: "package-ready", title: "AI 标题" }),
    taskRecord("scheduled", { id: "task-broken", packageId: "package-broken", platform: "xiaohongshu", scheduledAt: "2026-08-11T08:00:00.000Z" }),
    taskRecord("published", { id: "task-published", packageId: "package-published", platform: "bilibili", publishedAt: NOW }),
    taskRecord("failed", { id: "task-trash", packageId: "package-trash", lastError: "失败" }),
  ];
  await storage.writeJsonAtomic(
    "cache/publishing-index.json",
    seededIndex(packages, tasks)
  );
  const store = new PublishingStore(storage, () => new Date(NOW));
  await store.init();
  const ids = async (filters: Parameters<PublishingStore["list"]>[0]) =>
    (await store.list(filters)).map((detail) => detail.package.id);

  assert.deepEqual(await ids({ status: "action" }), ["package-broken", "package-ready"]);
  assert.deepEqual(await ids({ status: "all" }), ["package-published", "package-broken", "package-ready"]);
  assert.deepEqual(await ids({ status: "published" }), ["package-published"]);
  assert.deepEqual(await ids({ status: "broken" }), ["package-broken"]);
  assert.deepEqual(await ids({ status: "trash" }), ["package-trash"]);
  assert.deepEqual(await ids({ platform: "xiaohongshu" }), ["package-broken"]);
  assert.deepEqual(await ids({ sourceJobId: "job-2", version: 2, createdBy: "admin-1" }), ["package-broken"]);
  assert.deepEqual(await ids({ search: "ai 标题" }), ["package-ready"]);
});
