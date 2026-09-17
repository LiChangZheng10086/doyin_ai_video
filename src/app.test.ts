import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createExpressApp } from "./app.js";
import { PublishingAssetService } from "./lib/publishing-assets.js";
import { PublishingStore } from "./lib/publishing-store.js";
import { SauRunner } from "./lib/sau-runner.js";
import { LocalStorage } from "./lib/storage.js";
import type { DeliveryPackage, PublishTask } from "./types.js";

type JsonResponse = {
  response: Response;
  body: Record<string, any>;
};

async function serveApp(
  storageRoot: string,
  overrides: Partial<Parameters<typeof createExpressApp>[0]> = {},
) {
  const app = await createExpressApp({ storagePath: storageRoot, rootDir: storageRoot, ...overrides });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function appFixture(options: { publishingIndex?: unknown } = {}) {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "app-local-users-"));
  if (options.publishingIndex !== undefined) {
    await mkdir(path.join(storageRoot, "cache"), { recursive: true });
    await writeFile(
      path.join(storageRoot, "cache", "publishing-index.json"),
      JSON.stringify(options.publishingIndex),
      "utf8"
    );
  }

  const served = await serveApp(storageRoot);

  return {
    ...served,
    storageRoot,
    async readUserIndexBytes() {
      return readFile(path.join(storageRoot, "cache", "local-users.json"));
    },
    async readPublishingBytes() {
      return readFile(path.join(storageRoot, "cache", "publishing-index.json"));
    },
  };
}

async function jsonFetch(
  baseUrl: string,
  pathname: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { "X-Local-Session": options.token } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    response,
    body: response.headers.get("content-type")?.includes("application/json") && text
      ? JSON.parse(text) as Record<string, any>
      : {},
  };
}

async function identityApiFixture(options: { publishingIndex?: unknown } = {}) {
  const fixture = await appFixture(options);
  const boot = await jsonFetch(fixture.baseUrl, "/api/local-users/bootstrap", {
    method: "POST",
    body: { displayName: "主管", pin: "123456" },
  });
  assert.equal(boot.response.status, 201);
  const adminToken = boot.body.session.token as string;
  const publisher = await jsonFetch(fixture.baseUrl, "/api/local-users", {
    method: "POST",
    token: adminToken,
    body: { displayName: "发布者", role: "publisher" },
  });
  assert.equal(publisher.response.status, 201);
  const publisherSession = await jsonFetch(fixture.baseUrl, "/api/local-sessions", {
    method: "POST",
    body: { userId: publisher.body.user.id },
  });
  assert.equal(publisherSession.response.status, 201);

  return {
    ...fixture,
    admin: boot.body.user as { id: string },
    publisher: publisher.body.user as { id: string },
    adminToken,
    publisherToken: publisherSession.body.session.token as string,
    openAdmin() {
      return jsonFetch(fixture.baseUrl, "/api/local-sessions", {
        method: "POST",
        body: { userId: boot.body.user.id, pin: "123456" },
      });
    },
    getCurrent(token: string) {
      return jsonFetch(fixture.baseUrl, "/api/local-sessions/current", { token });
    },
  };
}

/** 合法最小 1×1 PNG；图文打包与场景静帧夹具共用。 */
const NOTE_PNG_LATE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function publishingApiFixture(
  overrides: Partial<Parameters<typeof createExpressApp>[0]> = {},
  options: {
    cleanedTitle?: string;
    sauStub?: {
      check?: { stdout?: string; exitCode?: number };
      upload?: { stdout?: string; exitCode?: number };
    };
  } = {},
) {
  const storageRoot = await realpath(await mkdtemp(path.join(tmpdir(), "app-publishing-")));
  const jobId = "publish-job";
  const videoPath = path.join(storageRoot, "output", "videos", jobId, "video.mp4");
  await Promise.all([
    mkdir(path.dirname(videoPath), { recursive: true }),
    mkdir(path.join(storageRoot, "output", "covers"), { recursive: true }),
    mkdir(path.join(storageRoot, "processed", "cleaned"), { recursive: true }),
    mkdir(path.join(storageRoot, "processed", "scripts"), { recursive: true }),
    mkdir(path.join(storageRoot, "cache"), { recursive: true }),
  ]);
  await writeFile(videoPath, Buffer.from("publishable mp4 bytes"));
  await writeFile(path.join(storageRoot, "output", "covers", `${jobId}.jpg`), Buffer.from("cover"));
  await writeFile(path.join(storageRoot, "cache", "jobs-index.json"), JSON.stringify({
    [jobId]: {
      id: jobId,
      sourceUrl: "https://example.com/publish",
      topic: "发布测试作品",
      status: "done",
      stage: "rendered",
      workflowMode: "manual",
      steps: {},
      storagePath: path.join("processed", "scripts", `${jobId}.json`),
      videoOutputPath: videoPath,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  }), "utf8");
  await writeFile(path.join(storageRoot, "cache", "publishing-index.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    nextVersionBySource: {},
    packages: {},
    tasks: {},
    audit: [],
    tombstones: {},
  }, null, 2), "utf8");
  await writeFile(path.join(storageRoot, "processed", "scripts", `${jobId}.json`), JSON.stringify({
    title: "发布测试作品",
    hyperframesVideo: {
      provider: "hyperframes",
      projectPath: path.dirname(videoPath),
      videoPath,
      manifestPath: path.join(path.dirname(videoPath), "video-output.json"),
      createdAt: "2026-08-10T00:00:00.000Z",
      duration: 56,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      scenes: [],
    },
  }), "utf8");
  // 场景静帧：图文打包的素材来源（与 real 流程同一位置）
  await mkdir(path.join(path.dirname(videoPath), "hyperframes", "snapshots"), { recursive: true });
  await writeFile(path.join(path.dirname(videoPath), "hyperframes", "snapshots", "frame-00-at-3s.png"), Buffer.concat([NOTE_PNG_LATE, Buffer.from([0])]));
  await writeFile(path.join(path.dirname(videoPath), "hyperframes", "snapshots", "frame-01-at-9s.png"), Buffer.concat([NOTE_PNG_LATE, Buffer.from([1])]));
  await writeFile(path.join(storageRoot, "processed", "cleaned", `${jobId}.json`), JSON.stringify({
    output: {
      title: options.cleanedTitle ?? "发布测试作品",
      summary: "这是一段用于验证发布中心接口的简体中文摘要。",
      keyPoints: ["先审核平台文案", "再完成人工发布"],
      shortVideoScript: "发布前先检查内容，再按平台要求完成人工上传。",
      tags: ["内容创作", "发布流程"],
    },
  }), "utf8");

  let sauRunner: SauRunner | undefined;
  if (options.sauStub) {
    const sauBaseDir = path.join(storageRoot, "sau");
    await mkdir(sauBaseDir, { recursive: true });
    const cookieFilePath = path.join(storageRoot, "douyin-cookie.txt");
    await writeFile(cookieFilePath, "sessionid=fake-session; sid_guard=fake-guard", "utf8");
    sauRunner = new SauRunner({
      sauBinary: await writeStubCli(storageRoot, options.sauStub),
      sauBaseDir,
      cookieFilePath,
      accountName: "mine",
    });
  }
  const served = await serveApp(storageRoot, sauRunner ? { ...overrides, sauRunner } : overrides);
  const boot = await jsonFetch(served.baseUrl, "/api/local-users/bootstrap", {
    method: "POST",
    body: { displayName: "主管", pin: "123456" },
  });
  assert.equal(boot.response.status, 201);
  const publisher = await jsonFetch(served.baseUrl, "/api/local-users", {
    method: "POST",
    token: boot.body.session.token,
    body: { displayName: "发布者", role: "publisher" },
  });
  assert.equal(publisher.response.status, 201);
  const publisherSession = await jsonFetch(served.baseUrl, "/api/local-sessions", {
    method: "POST",
    body: { userId: publisher.body.user.id },
  });
  assert.equal(publisherSession.response.status, 201);

  return {
    ...served,
    storageRoot,
    jobId,
    videoPath,
    hasSau: Boolean(sauRunner),
    admin: boot.body.user as { id: string },
    publisherToken: publisherSession.body.session.token as string,
    publisher: publisher.body.user as { id: string; displayName: string; role: string },
    openAdmin() {
      return jsonFetch(served.baseUrl, "/api/local-sessions", {
        method: "POST",
        body: { userId: boot.body.user.id, pin: "123456" },
      });
    },
    async readPublishingBytes() {
      return readFile(path.join(storageRoot, "cache", "publishing-index.json"));
    },
  };
}

async function previewAndCreatePackage(
  fixture: Awaited<ReturnType<typeof publishingApiFixture>>,
  token = fixture.publisherToken,
) {
  const previewResponse = await jsonFetch(
    fixture.baseUrl,
    `/api/jobs/${fixture.jobId}/publishing/preview`,
    { method: "POST", token, body: { platforms: ["douyin"] } },
  );
  assert.equal(previewResponse.response.status, 200);
  const preview = previewResponse.body.preview as Record<string, any>;
  const copy = preview.copies.douyin as Record<string, unknown>;
  const created = await jsonFetch(fixture.baseUrl, "/api/publishing/packages", {
    method: "POST",
    token,
    body: {
      sourceJobId: fixture.jobId,
      previewRevision: preview.previewRevision,
      title: "发布测试作品",
      platforms: [{ platform: "douyin", copy, copySource: copy.copySource }],
    },
  });
  assert.equal(created.response.status, 201);
  return created.body.package as Record<string, any>;
}

test("publishing preview requires a session and leaves the index and formal assets unchanged", async () => {
  const fixture = await publishingApiFixture();
  try {
    const before = await fixture.readPublishingBytes();
    const unauthenticated = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", body: { platforms: ["douyin"] } },
    );
    assert.equal(unauthenticated.response.status, 401);
    assert.deepEqual(unauthenticated.body, {
      code: "local_session_required",
      message: "请选择当前操作者",
    });

    const assets = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/assets`,
      { token: fixture.publisherToken },
    );
    assert.equal(assets.response.status, 200);
    assert.equal(assets.body.assets.size, (await stat(fixture.videoPath)).size);
    assert.equal(assets.body.assets.coverAvailable, true);
    assert.equal(assets.body.assets.estimatedAdditionalBytes, assets.body.assets.size);

    const response = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: { platforms: ["douyin", "bilibili"] } },
    );
    assert.equal(response.response.status, 200);
    assert.equal(response.body.preview.sourceJobId, fixture.jobId);
    assert.ok(response.body.preview.previewRevision);
    assert.deepEqual(await fixture.readPublishingBytes(), before);

    const publishingRoot = path.join(fixture.storageRoot, "output", "publishing");
    const entries = await readdir(publishingRoot, { recursive: true }).catch(() => []);
    assert.equal(entries.some((entry) => /^v\d+-/u.test(path.basename(String(entry)))), false);
  } finally {
    await fixture.close();
  }
});

test("server marks unverified client copy as user edited", async () => {
  const fixture = await publishingApiFixture();
  try {
    const previewResponse = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: { platforms: ["douyin"] } },
    );
    const preview = previewResponse.body.preview as Record<string, any>;
    const submitted = { ...preview.copies.douyin, title: "客户端修改后仍伪装为 AI" };
    const created = await jsonFetch(fixture.baseUrl, "/api/publishing/packages", {
      method: "POST",
      token: fixture.publisherToken,
      body: {
        sourceJobId: fixture.jobId,
        previewRevision: preview.previewRevision,
        title: "来源校验",
        platforms: [{ platform: "douyin", copy: submitted, copySource: "ai" }],
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.package.tasks[0].copySource, "user_edited");
  } finally {
    await fixture.close();
  }
});

test("publisher can create, edit, schedule, cancel, restore and record action errors with server actor", async () => {
  const fixture = await publishingApiFixture();
  try {
    const created = await previewAndCreatePackage(fixture);
    const task = created.tasks[0] as Record<string, any>;
    const cover = await fetch(`${fixture.baseUrl}/api/publishing/packages/${created.package.id}/cover`, {
      headers: { "X-Local-Session": fixture.publisherToken },
    });
    assert.equal(cover.status, 200);
    assert.match(cover.headers.get("content-type") ?? "", /^image\/jpeg/u);
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), Buffer.from("cover"));
    assert.deepEqual(created.package.createdBy, {
      userId: fixture.publisher.id,
      displayName: fixture.publisher.displayName,
      role: "publisher",
    });

    const edited = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${task.id}/content`, {
      method: "PATCH",
      token: fixture.publisherToken,
      body: {
        title: "人工审核后的标题",
        description: "人工审核后的正文",
        hashtags: ["人工审核"],
        expectedRevision: task.contentRevision,
        actor: { userId: "forged", displayName: "伪造管理员", role: "admin" },
      },
    });
    assert.equal(edited.response.status, 400);
    assert.equal(edited.body.code, "publish_validation_failed");

    const validEdit = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${task.id}/content`, {
      method: "PATCH",
      token: fixture.publisherToken,
      body: {
        title: "人工审核后的标题",
        description: "人工审核后的正文",
        hashtags: ["人工审核"],
        expectedRevision: task.contentRevision,
      },
    });
    assert.equal(validEdit.response.status, 200);
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${task.id}/schedule`, {
      method: "PATCH",
      token: fixture.publisherToken,
      body: { scheduledAt },
    });
    assert.equal(scheduled.response.status, 200);
    assert.equal(scheduled.body.task.status, "scheduled");

    const cancelled = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${task.id}/cancel`, {
      method: "POST",
      token: fixture.publisherToken,
      body: { confirmation: true },
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.task.status, "cancelled");
    const restored = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${task.id}/restore`, {
      method: "POST",
      token: fixture.publisherToken,
      body: { scheduledAt },
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.task.status, "scheduled");

    const beforeAction = restored.body.task;
    const actionError = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${task.id}/action-error`, {
      method: "POST",
      token: fixture.publisherToken,
      body: { action: "open_platform", message: "浏览器暂时不可用" },
    });
    assert.equal(actionError.response.status, 204);

    const detail = await jsonFetch(fixture.baseUrl, `/api/publishing/packages/${created.package.id}`, {
      token: fixture.publisherToken,
    });
    assert.equal(detail.response.status, 200);
    const afterAction = detail.body.package.tasks[0];
    for (const field of ["status", "scheduledAt", "contentRevision", "lastError"]) {
      assert.equal(afterAction[field], beforeAction[field]);
    }
    const actionAudit = detail.body.package.audit.find((event: Record<string, any>) => event.action === "task.action_error");
    assert.equal(actionAudit.metadata.action, "open_platform");
    assert.deepEqual(actionAudit.actor, {
      userId: fixture.publisher.id,
      displayName: fixture.publisher.displayName,
      role: "publisher",
    });

    const failed = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${task.id}/record-failure`, {
      method: "POST",
      token: fixture.publisherToken,
      body: { reason: "平台审核未通过" },
    });
    assert.equal(failed.response.status, 200);
    assert.equal(failed.body.task.status, "failed");
    assert.equal(failed.body.task.lastError, "平台审核未通过");

    const listed = await jsonFetch(fixture.baseUrl, "/api/publishing/packages?status=all&platform=douyin", {
      token: fixture.publisherToken,
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.packages.length, 1);
  } finally {
    await fixture.close();
  }
});

test("publisher admin-only requests are byte-stable while admin can publish, withdraw, trash and restore", async () => {
  const fixture = await publishingApiFixture();
  try {
    const created = await previewAndCreatePackage(fixture);
    const packageId = created.package.id as string;
    const taskId = created.tasks[0].id as string;

    for (const request of [
      { path: `/api/publishing/tasks/${taskId}/withdraw`, method: "POST", body: { confirmation: true, reason: "纠正记录" } },
      { path: `/api/publishing/packages/${packageId}`, method: "DELETE", body: { confirmation: true } },
      { path: `/api/publishing/packages/${packageId}/restore`, method: "POST", body: {} },
    ]) {
      const before = await fixture.readPublishingBytes();
      const denied = await jsonFetch(fixture.baseUrl, request.path, {
        method: request.method,
        token: fixture.publisherToken,
        body: request.body,
      });
      assert.equal(denied.response.status, 403);
      assert.equal(denied.body.code, "publish_permission_denied");
      assert.deepEqual(await fixture.readPublishingBytes(), before);
    }

    const adminSession = await fixture.openAdmin();
    assert.equal(adminSession.response.status, 201);
    const adminToken = adminSession.body.session.token as string;
    const missingConfirmation = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/mark-published`, {
      method: "POST",
      token: adminToken,
      body: {},
    });
    assert.equal(missingConfirmation.response.status, 400);

    const published = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/mark-published`, {
      method: "POST",
      token: adminToken,
      body: { confirmation: true },
    });
    assert.equal(published.response.status, 200);
    assert.equal(published.body.task.status, "published");

    const missingReason = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/withdraw`, {
      method: "POST",
      token: adminToken,
      body: { confirmation: true, reason: "" },
    });
    assert.equal(missingReason.response.status, 400);
    const withdrawn = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/withdraw`, {
      method: "POST",
      token: adminToken,
      body: { confirmation: true, reason: "纠正本地发布记录" },
    });
    assert.equal(withdrawn.response.status, 200);
    assert.equal(withdrawn.body.task.status, "ready");

    const missingDeleteConfirmation = await jsonFetch(fixture.baseUrl, `/api/publishing/packages/${packageId}`, {
      method: "DELETE",
      token: adminToken,
      body: {},
    });
    assert.equal(missingDeleteConfirmation.response.status, 400);
    const trashed = await jsonFetch(fixture.baseUrl, `/api/publishing/packages/${packageId}`, {
      method: "DELETE",
      token: adminToken,
      body: { confirmation: true },
    });
    assert.equal(trashed.response.status, 200);
    assert.equal(trashed.body.package.state, "trashed");
    const restored = await jsonFetch(fixture.baseUrl, `/api/publishing/packages/${packageId}/restore`, {
      method: "POST",
      token: adminToken,
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.package.state, "active");
    assert.ok(Array.isArray(restored.body.notifications));

    const version = await jsonFetch(fixture.baseUrl, `/api/publishing/packages/${packageId}/versions`, {
      method: "POST",
      token: adminToken,
    });
    assert.equal(version.response.status, 201);
    assert.equal(version.body.package.package.version, 2);
  } finally {
    await fixture.close();
  }
});

test("due check is session-free, deduplicates each schedule cycle and records the system actor", async () => {
  const fixture = await publishingApiFixture();
  try {
    const created = await previewAndCreatePackage(fixture);
    const taskId = created.tasks[0].id as string;
    const scheduledAt = new Date(Date.now() + 50).toISOString();
    const scheduled = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/schedule`, {
      method: "PATCH",
      token: fixture.publisherToken,
      body: { scheduledAt },
    });
    assert.equal(scheduled.response.status, 200);
    assert.equal(scheduled.body.task.dueNotifiedAt, undefined);

    await new Promise((resolve) => setTimeout(resolve, 75));
    const rejected = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", {
      method: "POST",
      body: { actor: { role: "admin" }, status: "published" },
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.code, "publish_validation_failed");

    const first = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.notifications.length, 1);
    assert.equal(first.body.notifications[0].taskId, taskId);
    const second = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(second.response.status, 200);
    assert.equal(second.body.notifications.length, 0);

    const nextScheduledAt = new Date(Date.now() + 50).toISOString();
    const rescheduled = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/schedule`, {
      method: "PATCH",
      token: fixture.publisherToken,
      body: { scheduledAt: nextScheduledAt },
    });
    assert.equal(rescheduled.response.status, 200);
    assert.equal(rescheduled.body.task.status, "scheduled");
    assert.equal(rescheduled.body.task.dueNotifiedAt, undefined);

    await new Promise((resolve) => setTimeout(resolve, 75));
    const nextCycle = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(nextCycle.response.status, 200);
    assert.equal(nextCycle.body.notifications.length, 1);
    assert.equal(nextCycle.body.notifications[0].taskId, taskId);
    const nextCycleRepeat = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(nextCycleRepeat.body.notifications.length, 0);

    const adminSession = await fixture.openAdmin();
    const detail = await jsonFetch(fixture.baseUrl, `/api/publishing/packages/${created.package.id}`, {
      token: adminSession.body.session.token,
    });
    const dueAudits = detail.body.package.audit.filter((event: Record<string, any>) => event.action === "task.due");
    assert.equal(dueAudits.length, 2);
    for (const dueAudit of dueAudits) {
      assert.deepEqual(dueAudit.actor, { userId: "system", displayName: "系统", role: "system" });
    }
  } finally {
    await fixture.close();
  }
});

test("delivers due notifications recovered during startup exactly once", async () => {
  const fixture = await publishingApiFixture();
  const created = await previewAndCreatePackage(fixture);
  const taskId = created.tasks[0].id as string;
  const scheduledAt = new Date(Date.now() + 50).toISOString();
  const scheduled = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/schedule`, {
    method: "PATCH",
    token: fixture.publisherToken,
    body: { scheduledAt },
  });
  assert.equal(scheduled.response.status, 200);
  await fixture.close();
  await new Promise((resolve) => setTimeout(resolve, 75));

  const restarted = await serveApp(fixture.storageRoot);
  try {
    const first = await jsonFetch(restarted.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.notifications.length, 1);
    assert.equal(first.body.notifications[0].taskId, taskId);

    const second = await jsonFetch(restarted.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(second.response.status, 200);
    assert.deepEqual(second.body.notifications, []);
  } finally {
    await restarted.close();
  }
});

test("due check leaves cancelled and trashed scheduled tasks untouched", async () => {
  const fixture = await publishingApiFixture();
  try {
    const created = await previewAndCreatePackage(fixture);
    const packageId = created.package.id as string;
    const taskId = created.tasks[0].id as string;
    const cancelledAt = new Date(Date.now() + 50).toISOString();
    await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/schedule`, {
      method: "PATCH",
      token: fixture.publisherToken,
      body: { scheduledAt: cancelledAt },
    });
    const cancelled = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/cancel`, {
      method: "POST",
      token: fixture.publisherToken,
      body: { confirmation: true },
    });
    assert.equal(cancelled.body.task.status, "cancelled");

    await new Promise((resolve) => setTimeout(resolve, 75));
    const beforeCancelledCheck = await fixture.readPublishingBytes();
    const cancelledDue = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.deepEqual(cancelledDue.body.notifications, []);
    assert.deepEqual(await fixture.readPublishingBytes(), beforeCancelledCheck);

    const trashedAt = new Date(Date.now() + 50).toISOString();
    const restored = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/restore`, {
      method: "POST",
      token: fixture.publisherToken,
      body: { scheduledAt: trashedAt },
    });
    assert.equal(restored.body.task.status, "scheduled");
    const adminSession = await fixture.openAdmin();
    const trashed = await jsonFetch(fixture.baseUrl, `/api/publishing/packages/${packageId}`, {
      method: "DELETE",
      token: adminSession.body.session.token,
      body: { confirmation: true },
    });
    assert.equal(trashed.body.package.state, "trashed");

    await new Promise((resolve) => setTimeout(resolve, 75));
    const beforeTrashedCheck = await fixture.readPublishingBytes();
    const trashedDue = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.deepEqual(trashedDue.body.notifications, []);
    assert.deepEqual(await fixture.readPublishingBytes(), beforeTrashedCheck);
  } finally {
    await fixture.close();
  }
});

test("publishing api maps validation, missing, conflict, asset and malformed JSON errors", async () => {
  const fixture = await publishingApiFixture();
  try {
    const missing = await jsonFetch(fixture.baseUrl, "/api/publishing/packages/not-found", {
      token: fixture.publisherToken,
    });
    assert.equal(missing.response.status, 404);
    assert.deepEqual(missing.body, { code: "publish_package_not_found", message: "未找到发布包" });

    const badFilter = await jsonFetch(fixture.baseUrl, "/api/publishing/packages?status=uploading", {
      token: fixture.publisherToken,
    });
    assert.equal(badFilter.response.status, 400);
    assert.equal(badFilter.body.code, "publish_validation_failed");

    const created = await previewAndCreatePackage(fixture);
    const conflict = await jsonFetch(
      fixture.baseUrl,
      `/api/publishing/tasks/${created.tasks[0].id}/restore`,
      { method: "POST", token: fixture.publisherToken, body: { scheduledAt: null } },
    );
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, "publish_invalid_transition");

    await writeFile(fixture.videoPath, Buffer.alloc(0));
    const broken = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: { platforms: ["douyin"] } },
    );
    assert.equal(broken.response.status, 422);
    assert.equal(broken.body.code, "publish_video_missing");

    const malformed = await fetch(`${fixture.baseUrl}/api/publishing/due/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"actor":',
    });
    assert.equal(malformed.status, 400);
    const malformedText = await malformed.text();
    assert.deepEqual(JSON.parse(malformedText), {
      code: "publish_validation_failed",
      message: "请求 JSON 格式无效",
    });
    assert.doesNotMatch(malformedText, /SyntaxError|stack|apiKey|pinHash/i);
  } finally {
    await fixture.close();
  }
});

test("publishing recovery failure keeps creative APIs alive and exposes read-only health", async () => {
  const fixture = await appFixture({ publishingIndex: { unexpected: true } });
  try {
    const health = await jsonFetch(fixture.baseUrl, "/health");
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.body.publishing, {
      ok: false,
      readOnly: true,
      message: "发布数据恢复失败，当前发布中心处于只读保护状态",
    });

    const boot = await jsonFetch(fixture.baseUrl, "/api/local-users/bootstrap", {
      method: "POST",
      body: { displayName: "主管", pin: "123456" },
    });
    assert.equal(boot.response.status, 201);
    const publishing = await jsonFetch(fixture.baseUrl, "/api/publishing/packages", {
      token: boot.body.session.token,
    });
    assert.equal(publishing.response.status, 200);
    assert.deepEqual(publishing.body, { packages: [] });

    const blockedWrite = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(blockedWrite.response.status, 500);
    assert.deepEqual(blockedWrite.body, {
      code: "publish_index_corrupt",
      message: "发布数据恢复失败，当前发布中心处于只读保护状态",
    });
    assert.doesNotMatch(JSON.stringify(blockedWrite.body), /publishing-index\.json|stack|apiKey|pinHash/i);

    const jobs = await jsonFetch(fixture.baseUrl, "/api/jobs");
    assert.equal(jobs.response.status, 200);
  } finally {
    await fixture.close();
  }
});

test("publishing health read-only mode permits preview but blocks publishing writes", async () => {
  const fixture = await publishingApiFixture();
  try {
    fixture.app.locals.publishingHealth = {
      ok: false,
      readOnly: true,
      message: "发布数据恢复失败，当前发布中心处于只读保护状态",
    };
    const preview = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: { platforms: ["douyin"] } },
    );
    assert.equal(preview.response.status, 200);

    const before = await fixture.readPublishingBytes();
    const due = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(due.response.status, 500);
    assert.deepEqual(due.body, {
      code: "publish_index_corrupt",
      message: "发布数据恢复失败，当前发布中心处于只读保护状态",
    });
    assert.deepEqual(await fixture.readPublishingBytes(), before);
  } finally {
    await fixture.close();
  }
});

test("publishing copy resolves the current AI configuration for every preview", async () => {
  let resolutions = 0;
  const fixture = await publishingApiFixture({
    resolveAiConfig: async () => {
      resolutions += 1;
      return null;
    },
  });
  try {
    for (const platform of ["douyin", "bilibili"]) {
      const preview = await jsonFetch(
        fixture.baseUrl,
        `/api/jobs/${fixture.jobId}/publishing/preview`,
        { method: "POST", token: fixture.publisherToken, body: { platforms: [platform] } },
      );
      assert.equal(preview.response.status, 200);
    }
    assert.equal(resolutions, 2);
  } finally {
    await fixture.close();
  }
});

test("publishing registration does not add auth or alter the four manual step endpoints", async () => {
  const fixture = await appFixture();
  try {
    for (const step of ["transcribe", "clean", "generate-video-prompts", "generate-video"]) {
      const response = await jsonFetch(fixture.baseUrl, `/api/jobs/not-found/steps/${step}`, {
        method: "POST",
      });
      assert.equal(response.response.status, 404);
      assert.equal(response.body.message, "job not found");
    }
  } finally {
    await fixture.close();
  }
});

test("local user api bootstraps once and switches publisher/admin sessions", async () => {
  const fixture = await appFixture();
  try {
    const boot = await jsonFetch(fixture.baseUrl, "/api/local-users/bootstrap", {
      method: "POST",
      body: { displayName: "主管", pin: "123456" },
    });
    assert.equal(boot.response.status, 201);
    assert.equal(boot.body.user.role, "admin");
    assert.ok(boot.body.session.token);

    const duplicate = await jsonFetch(fixture.baseUrl, "/api/local-users/bootstrap", {
      method: "POST",
      body: { displayName: "第二位主管", pin: "654321" },
    });
    assert.equal(duplicate.response.status, 409);

    const publisher = await jsonFetch(fixture.baseUrl, "/api/local-users", {
      method: "POST",
      token: boot.body.session.token,
      body: { displayName: "发布者", role: "publisher" },
    });
    const publisherSession = await jsonFetch(fixture.baseUrl, "/api/local-sessions", {
      method: "POST",
      body: { userId: publisher.body.user.id },
    });
    assert.equal(publisherSession.response.status, 201);

    const adminSession = await jsonFetch(fixture.baseUrl, "/api/local-sessions", {
      method: "POST",
      body: { userId: boot.body.user.id, pin: "123456" },
    });
    assert.equal(adminSession.response.status, 201);
    assert.equal((await jsonFetch(fixture.baseUrl, "/api/local-sessions/current", {
      token: publisherSession.body.session.token,
    })).response.status, 401);
  } finally {
    await fixture.close();
  }
});

test("rebuilding the app invalidates an old administrator token", async () => {
  const fixture = await appFixture();
  let originalClosed = false;
  let restarted: Awaited<ReturnType<typeof serveApp>> | undefined;
  try {
    const boot = await jsonFetch(fixture.baseUrl, "/api/local-users/bootstrap", {
      method: "POST",
      body: { displayName: "主管", pin: "123456" },
    });
    assert.equal(boot.response.status, 201);
    const oldToken = boot.body.session.token as string;

    await fixture.close();
    originalClosed = true;
    restarted = await serveApp(fixture.storageRoot);

    const current = await jsonFetch(restarted.baseUrl, "/api/local-sessions/current", { token: oldToken });
    assert.equal(current.response.status, 401);
    assert.deepEqual(current.body, {
      code: "local_session_required",
      message: "请选择当前操作者",
    });
  } finally {
    if (restarted) await restarted.close();
    else if (!originalClosed) await fixture.close();
  }
});

test("publisher cannot manage users and admin can", async () => {
  const fixture = await identityApiFixture();
  try {
    const before = await fixture.readUserIndexBytes();
    const denied = await jsonFetch(fixture.baseUrl, "/api/local-users", {
      method: "POST",
      token: fixture.publisherToken,
      body: { displayName: "新用户", role: "publisher" },
    });
    assert.equal(denied.response.status, 403);
    assert.deepEqual(denied.body, {
      code: "local_role_forbidden",
      message: "当前操作者无权执行此操作",
    });
    assert.deepEqual(await fixture.readUserIndexBytes(), before);

    const adminSession = await fixture.openAdmin();
    assert.equal(adminSession.response.status, 201);
    const created = await jsonFetch(fixture.baseUrl, "/api/local-users", {
      method: "POST",
      token: adminSession.body.session.token,
      body: { displayName: "新用户", role: "publisher" },
    });
    assert.equal(created.response.status, 201);
  } finally {
    await fixture.close();
  }
});

test("last active administrator demotion returns 409 without changing user bytes", async () => {
  const fixture = await appFixture();
  try {
    const boot = await jsonFetch(fixture.baseUrl, "/api/local-users/bootstrap", {
      method: "POST",
      body: { displayName: "唯一管理员", pin: "123456" },
    });
    assert.equal(boot.response.status, 201);
    const before = await fixture.readUserIndexBytes();

    const denied = await jsonFetch(fixture.baseUrl, `/api/local-users/${boot.body.user.id}`, {
      method: "PATCH",
      token: boot.body.session.token,
      body: { role: "publisher" },
    });

    assert.equal(denied.response.status, 409);
    assert.deepEqual(denied.body, {
      code: "local_user_last_admin",
      message: "至少保留一个启用的管理员",
    });
    assert.deepEqual(await fixture.readUserIndexBytes(), before);
  } finally {
    await fixture.close();
  }
});

test("user routes enforce the secure role-change contract and session close is idempotent", async () => {
  const fixture = await identityApiFixture();
  try {
    const adminSession = await fixture.openAdmin();
    assert.equal(adminSession.response.status, 201);
    const missingPin = await jsonFetch(fixture.baseUrl, `/api/local-users/${fixture.publisher.id}`, {
      method: "PATCH",
      token: adminSession.body.session.token,
      body: { role: "admin" },
    });
    assert.equal(missingPin.response.status, 400);
    assert.equal(missingPin.body.code, "local_user_admin_pin_required");

    const promoted = await jsonFetch(fixture.baseUrl, `/api/local-users/${fixture.publisher.id}`, {
      method: "PATCH",
      token: adminSession.body.session.token,
      body: { role: "admin", pin: "654321" },
    });
    assert.equal(promoted.response.status, 200);
    assert.equal(promoted.body.user.role, "admin");

    const reset = await jsonFetch(fixture.baseUrl, `/api/local-users/${fixture.publisher.id}/reset-pin`, {
      method: "POST",
      token: adminSession.body.session.token,
      body: { pin: "111111" },
    });
    assert.equal(reset.response.status, 204);

    const closed = await fetch(`${fixture.baseUrl}/api/local-sessions/current`, {
      method: "DELETE",
      headers: { "X-Local-Session": fixture.publisherToken },
    });
    assert.equal(closed.status, 204);
    const closedAgain = await fetch(`${fixture.baseUrl}/api/local-sessions/current`, { method: "DELETE" });
    assert.equal(closedAgain.status, 204);
  } finally {
    await fixture.close();
  }
});

test("recovery invalidates the old session and preserves publishing bytes", async () => {
  const fixture = await identityApiFixture({
    publishingIndex: {
      schemaVersion: 1,
      packages: {
        "package-1": {
          id: "package-1",
          audit: [{
            id: "audit-1",
            action: "created",
            actor: {
              userId: "publisher-original",
              displayName: "原发布者",
              role: "publisher",
            },
            createdAt: "2026-08-09T12:00:00.000Z",
          }],
        },
      },
    },
  });
  try {
    const adminSession = await fixture.openAdmin();
    assert.equal(adminSession.response.status, 201);
    const before = await fixture.readPublishingBytes();
    const recovered = await jsonFetch(fixture.baseUrl, "/api/local-users/recover", {
      method: "POST",
      body: { confirmation: "重置本地用户", displayName: "恢复管理员", pin: "654321" },
    });
    assert.equal(recovered.response.status, 201);
    assert.equal(recovered.body.user.role, "admin");
    assert.ok(recovered.body.session.token);
    assert.equal((await fixture.getCurrent(adminSession.body.session.token)).response.status, 401);
    assert.deepEqual(await fixture.readPublishingBytes(), before);
  } finally {
    await fixture.close();
  }
});

test("identity responses never expose pin secrets and CORS allows identity requests", async () => {
  const fixture = await identityApiFixture();
  try {
    const users = await jsonFetch(fixture.baseUrl, "/api/local-users");
    const current = await fixture.getCurrent(fixture.publisherToken);
    const invalidPin = await jsonFetch(fixture.baseUrl, "/api/local-sessions", {
      method: "POST",
      body: { userId: fixture.admin.id, pin: "000000" },
    });
    assert.equal(invalidPin.response.status, 401);
    assert.deepEqual(invalidPin.body, {
      code: "local_user_pin_invalid",
      message: "PIN 不正确",
    });

    for (const body of [users.body, current.body, invalidPin.body]) {
      const serialized = JSON.stringify(body);
      assert.doesNotMatch(serialized, /123456|pinHash|pinSalt/);
    }

    const options = await fetch(`${fixture.baseUrl}/api/local-users`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    assert.match(options.headers.get("access-control-allow-methods") ?? "", /PATCH/);
    assert.match(options.headers.get("access-control-allow-headers") ?? "", /X-Local-Session/);
  } finally {
    await fixture.close();
  }
});

test("identity error boundary returns safe JSON for malformed request bodies", async () => {
  const fixture = await appFixture();
  try {
    const response = await fetch(`${fixture.baseUrl}/api/local-users/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"displayName":',
    });
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.code, "local_user_invalid_json");
    assert.equal(body.message, "请求 JSON 格式无效");
    assert.doesNotMatch(text, /SyntaxError|body-parser|<html|stack/i);
  } finally {
    await fixture.close();
  }
});

test("identity error boundary hides local user storage failures", async () => {
  const fixture = await appFixture();
  try {
    await writeFile(path.join(fixture.storageRoot, "cache", "local-users.json"), "{invalid", "utf8");
    const response = await fetch(`${fixture.baseUrl}/api/local-users`);
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.code, "local_user_service_unavailable");
    assert.equal(body.message, "本地用户服务暂时不可用");
    assert.doesNotMatch(text, /local-users\.json|SyntaxError|<html|stack/i);
  } finally {
    await fixture.close();
  }
});

test("video stream endpoint plays mp4 inline while download stays attachment", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "app-video-stream-"));
  const app = await createExpressApp({ storagePath: storageRoot, rootDir: storageRoot });
  const videoPath = path.join(storageRoot, "output", "videos", "stream-job", "video.mp4");
  await mkdir(path.dirname(videoPath), { recursive: true });
  await writeFile(videoPath, Buffer.from("fake mp4"));
  await writeFile(path.join(storageRoot, "cache", "jobs-index.json"), JSON.stringify({
    "stream-job": {
      id: "stream-job",
      sourceUrl: "https://example.com/video",
      topic: "测试视频",
      status: "done",
      stage: "rendered",
      workflowMode: "manual",
      steps: {},
      storagePath: path.join("processed", "scripts", "stream-job.json"),
      videoOutputPath: videoPath,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }
  }), "utf8");
  await writeFile(path.join(storageRoot, "processed", "scripts", "stream-job.json"), JSON.stringify({
    sourceUrl: "https://example.com/video",
    topic: "测试视频",
    hyperframesVideo: {
      provider: "hyperframes",
      projectPath: path.dirname(videoPath),
      videoPath,
      manifestPath: path.join(path.dirname(videoPath), "video-output.json"),
      createdAt: "2026-07-11T00:00:00.000Z",
      duration: 1,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      scenes: []
    }
  }), "utf8");

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const streamResponse = await fetch(`${baseUrl}/api/jobs/stream-job/video/stream`);
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get("content-type"), "video/mp4");
    assert.notEqual(streamResponse.headers.get("content-disposition")?.includes("attachment"), true);
    assert.equal(await streamResponse.text(), "fake mp4");

    const downloadResponse = await fetch(`${baseUrl}/api/jobs/stream-job/video/download`);
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get("content-disposition") ?? "", /attachment/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("video prompts endpoint returns Shot V2 and legacy compatibility fields", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "app-video-plan-"));
  const app = await createExpressApp({ storagePath: storageRoot, rootDir: storageRoot });
  await writeFile(path.join(storageRoot, "cache", "jobs-index.json"), JSON.stringify({
    plan: {
      id: "plan",
      sourceUrl: "https://example.com/video",
      topic: "测试分镜",
      status: "queued",
      stage: "scripted",
      workflowMode: "manual",
      steps: {},
      storagePath: path.join("processed", "scripts", "plan.json"),
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }
  }), "utf8");
  await writeFile(path.join(storageRoot, "processed", "scripts", "plan.json"), JSON.stringify({
    planVersion: 2,
    targetDuration: 60,
    shortVideoScript: "完整的六十秒視頻文稿",
    shortVideoShots: [{ index: 1, duration: 6, shotType: "hook", caption: "開場字幕" }],
    videoPrompts: ["歷史提示詞"],
    enhancedScenes: [{ scene: 1, videoPrompt: "历史场景" }],
    videoOutline: [{ title: "历史大纲", bullets: ["兼容"] }]
  }), "utf8");
  await writeFile(path.join(storageRoot, "processed", "cleaned", "plan.json"), JSON.stringify({
    output: { title: "推薦內容", summary: "這是歷史洗稿" }
  }), "utf8");

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/plan/video-prompts`);
    assert.equal(response.status, 200);
    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.planVersion, 2);
    assert.equal(payload.targetDuration, 60);
    assert.equal(payload.shortVideoScript, "完整的六十秒视频文稿");
    assert.equal((payload.shortVideoShots as Array<{ caption: string }>)[0]?.caption, "开场字幕");
    assert.equal((payload.videoPrompts as string[])[0], "历史提示词");
    assert.equal((payload.shortVideoShots as unknown[]).length, 1);
    assert.equal((payload.videoPrompts as unknown[]).length, 1);
    assert.equal((payload.enhancedScenes as unknown[]).length, 1);
    assert.equal((payload.videoOutline as unknown[]).length, 1);

    const cleanedResponse = await fetch(`http://127.0.0.1:${address.port}/api/jobs/plan/cleaned`);
    const cleanedPayload = await cleanedResponse.json() as { cleaned: { output: { title: string; summary: string } } };
    assert.equal(cleanedPayload.cleaned.output.title, "推荐内容");
    assert.equal(cleanedPayload.cleaned.output.summary, "这是历史洗稿");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AI step events endpoint streams SSE lifecycle events and rejects unsupported steps", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "app-ai-step-events-"));
  await mkdir(path.join(storageRoot, "cache"), { recursive: true });
  await mkdir(path.join(storageRoot, "raw", "transcripts"), { recursive: true });
  await writeFile(path.join(storageRoot, "cache", "jobs-index.json"), JSON.stringify({
    "stream-clean": {
      id: "stream-clean",
      sourceUrl: "https://example.com/video",
      topic: "流式洗稿",
      status: "queued",
      stage: "transcribed",
      workflowMode: "manual",
      steps: {
        transcribe: { status: "succeeded", attempts: 1 },
        clean: { status: "pending", attempts: 0 },
        generate_video_prompts: { status: "pending", attempts: 0 },
        generate_video: { status: "pending", attempts: 0 }
      },
      storagePath: "processed/scripts/stream-clean.json",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z"
    }
  }), "utf8");
  await writeFile(path.join(storageRoot, "raw", "transcripts", "stream-clean.json"), JSON.stringify({
    transcript: "用于测试的完整转录文本",
    text: "用于测试的完整转录文本"
  }), "utf8");
  const fixture = await serveApp(storageRoot);

  try {
    const unsupported = await fetch(`${fixture.baseUrl}/api/jobs/stream-clean/steps/transcribe/events`);
    assert.equal(unsupported.status, 400);

    const stream = await fetch(`${fixture.baseUrl}/api/jobs/stream-clean/steps/clean/events`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);

    const run = fetch(`${fixture.baseUrl}/api/jobs/stream-clean/steps/clean`, { method: "POST" });
    const body = await stream.text();
    const runResponse = await run;

    assert.equal(runResponse.status, 500);
    assert.match(body, /event: started/);
    assert.match(body, /event: error/);
    assert.match(body, /"step":"clean"/);
    assert.match(body, /^id: 1/m);

    const replay = await fetch(`${fixture.baseUrl}/api/jobs/stream-clean/steps/clean/events`, {
      headers: { "Last-Event-ID": "1" }
    });
    const replayBody = await replay.text();
    assert.doesNotMatch(replayBody, /event: started/);
    assert.match(replayBody, /event: error/);
  } finally {
    await fixture.close();
  }
});

// ─── 本机操作者自动会话 ─────────────────────────────────────────────

test("local sessions auto endpoint creates and adopts a pin-less local operator", async () => {
  const fixture = await appFixture();
  try {
    const auto = await jsonFetch(fixture.baseUrl, "/api/local-sessions/auto", { method: "POST" });
    assert.equal(auto.response.status, 201);
    assert.equal(auto.body.user.role, "admin");
    assert.equal(auto.body.user.displayName, "本机用户");
    assert.equal(typeof auto.body.session.token, "string");
    assert.ok(auto.body.session.token.length > 0);

    const current = await jsonFetch(fixture.baseUrl, "/api/local-sessions/current", {
      token: auto.body.session.token as string,
    });
    assert.equal(current.response.status, 200);
    assert.equal(current.body.user.id, auto.body.user.id);
  } finally {
    await fixture.close();
  }
});

test("local sessions auto endpoint reuses an existing administrator without adding users", async () => {
  const fixture = await appFixture();
  try {
    const boot = await jsonFetch(fixture.baseUrl, "/api/local-users/bootstrap", {
      method: "POST",
      body: { displayName: "唯一管理员", pin: "123456" },
    });
    assert.equal(boot.response.status, 201);
    const before = await jsonFetch(fixture.baseUrl, "/api/local-users");
    assert.equal(before.body.users.length, 1);

    const auto = await jsonFetch(fixture.baseUrl, "/api/local-sessions/auto", { method: "POST" });

    assert.equal(auto.response.status, 201);
    assert.equal(auto.body.user.id, boot.body.user.id);
    assert.equal(auto.body.user.displayName, "唯一管理员");
    const after = await jsonFetch(fixture.baseUrl, "/api/local-users");
    assert.equal(after.body.users.length, 1);
  } finally {
    await fixture.close();
  }
});

// ─── 素材库 ─────────────────────────────────────────────────────────

/** 最小但结构正确的 PNG（仅头部，用于断言尺寸解析）。 */
function assetPngBytes(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([signature, ihdr]);
}

async function uploadAssets(
  baseUrl: string,
  kind: "images" | "audio",
  files: Array<{ name: string; data: Buffer; type?: string }>,
): Promise<Response> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", new Blob([new Uint8Array(file.data)], { type: file.type ?? "application/octet-stream" }), file.name);
  }
  return fetch(`${baseUrl}/api/assets/${kind}`, { method: "POST", body: form });
}

test("assets upload stores images and audio and lists them by kind", async () => {
  const fixture = await appFixture();
  try {
    const imageResponse = await uploadAssets(fixture.baseUrl, "images", [
      { name: "封面.png", data: assetPngBytes(1080, 1920), type: "image/png" },
    ]);
    assert.equal(imageResponse.status, 201);
    const imageBody = await imageResponse.json() as { assets: Array<Record<string, unknown>> };
    assert.equal(imageBody.assets.length, 1);
    assert.equal(imageBody.assets[0].width, 1080);
    assert.equal(imageBody.assets[0].height, 1920);
    assert.equal(imageBody.assets[0].originalName, "封面.png");
    assert.match(String(imageBody.assets[0].filename), /^[0-9a-f-]{36}\.png$/u);

    const audioResponse = await uploadAssets(fixture.baseUrl, "audio", [
      { name: "bgm.mp3", data: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]), type: "audio/mpeg" },
    ]);
    assert.equal(audioResponse.status, 201);

    const all = await jsonFetch(fixture.baseUrl, "/api/assets");
    assert.equal((all.body.assets as unknown[]).length, 2);
    const imagesOnly = await jsonFetch(fixture.baseUrl, "/api/assets?kind=image");
    assert.equal((imagesOnly.body.assets as unknown[]).length, 1);
    const audioOnly = await jsonFetch(fixture.baseUrl, "/api/assets?kind=audio");
    assert.equal((audioOnly.body.assets as unknown[]).length, 1);
  } finally {
    await fixture.close();
  }
});

test("assets upload rejects forbidden extensions and kind mismatches with 415", async () => {
  const fixture = await appFixture();
  try {
    const exe = await uploadAssets(fixture.baseUrl, "images", [
      { name: "evil.exe", data: Buffer.from("MZ") },
    ]);
    assert.equal(exe.status, 415);
    assert.equal(((await exe.json()) as { code: string }).code, "asset_extension_forbidden");

    const mismatch = await uploadAssets(fixture.baseUrl, "audio", [
      { name: "cover.png", data: assetPngBytes(4, 4) },
    ]);
    assert.equal(mismatch.status, 415);
    assert.equal(((await mismatch.json()) as { code: string }).code, "asset_kind_mismatch");
  } finally {
    await fixture.close();
  }
});

test("assets upload enforces the size and file-count limits", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "app-assets-limits-"));
  const served = await serveApp(storageRoot, {
    assetUploadLimits: { maxFileBytes: 64, maxFiles: 2 },
  });
  try {
    const tooBig = await uploadAssets(served.baseUrl, "images", [
      { name: "big.png", data: Buffer.concat([assetPngBytes(4, 4), Buffer.alloc(128)]) },
    ]);
    assert.equal(tooBig.status, 413);

    const tooMany = await uploadAssets(served.baseUrl, "images", [
      { name: "a.png", data: assetPngBytes(4, 4) },
      { name: "b.png", data: assetPngBytes(4, 4) },
      { name: "c.png", data: assetPngBytes(4, 4) },
    ]);
    assert.equal(tooMany.status, 400);
  } finally {
    await served.close();
  }
});

test("assets raw preview supports byte ranges for audio seeking", async () => {
  const fixture = await appFixture();
  try {
    const upload = await uploadAssets(fixture.baseUrl, "images", [
      { name: "range.png", data: assetPngBytes(64, 32), type: "image/png" },
    ]);
    const created = ((await upload.json()) as { assets: Array<{ id: string; bytes: number }> }).assets[0];

    const full = await fetch(`${fixture.baseUrl}/api/assets/${created.id}/raw`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "image/png");
    assert.equal(full.headers.get("content-length"), String(created.bytes));
    assert.equal(full.headers.get("accept-ranges"), "bytes");

    const ranged = await fetch(`${fixture.baseUrl}/api/assets/${created.id}/raw`, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 2-5/${created.bytes}`);
    assert.equal(ranged.headers.get("content-length"), "4");

    const head = await fetch(`${fixture.baseUrl}/api/assets/${created.id}/raw`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    await fixture.close();
  }
});

test("assets delete removes the record and the file, and unknown ids are 404", async () => {
  const fixture = await appFixture();
  try {
    const upload = await uploadAssets(fixture.baseUrl, "images", [
      { name: "gone.png", data: assetPngBytes(8, 8) },
    ]);
    const created = ((await upload.json()) as { assets: Array<{ id: string; filename: string }> }).assets[0];
    const diskPath = path.join(fixture.storageRoot, "assets", "images", created.filename);
    assert.equal((await stat(diskPath)).isFile(), true);

    const deleted = await fetch(`${fixture.baseUrl}/api/assets/${created.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    await assert.rejects(() => stat(diskPath), { code: "ENOENT" });

    const missingRaw = await fetch(`${fixture.baseUrl}/api/assets/${created.id}/raw`);
    assert.equal(missingRaw.status, 404);
    const missingDelete = await fetch(`${fixture.baseUrl}/api/assets/${created.id}`, { method: "DELETE" });
    assert.equal(missingDelete.status, 404);
    const traversal = await fetch(`${fixture.baseUrl}/api/assets/${encodeURIComponent("../../etc/passwd")}/raw`);
    assert.equal(traversal.status, 404);
  } finally {
    await fixture.close();
  }
});

// ─── 原视频流式路由 ─────────────────────────────────────────────────

function rawVideoRecord(id: string, videoPath?: string) {
  return {
    id,
    sourceUrl: "https://example.test/video",
    topic: "原视频路由测试",
    status: "queued",
    stage: "cleaned",
    storagePath: path.join("processed", "scripts", `${id}.json`),
    videoPath,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

async function rawVideoFixture(records: Record<string, unknown>) {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "app-raw-video-"));
  await mkdir(path.join(storageRoot, "cache"), { recursive: true });
  await writeFile(
    path.join(storageRoot, "cache", "jobs-index.json"),
    JSON.stringify(records),
    "utf8",
  );
  return { storageRoot, ...(await serveApp(storageRoot)) };
}

test("raw-video stream serves the downloaded source MP4 with byte ranges", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "app-raw-video-serve-"));
  const videoPath = path.join(storageRoot, "raw", "videos", "raw-video-job.mp4");
  const bytes = Buffer.from("0123456789");
  await mkdir(path.dirname(videoPath), { recursive: true });
  await mkdir(path.join(storageRoot, "cache"), { recursive: true });
  await writeFile(videoPath, bytes);
  await writeFile(
    path.join(storageRoot, "cache", "jobs-index.json"),
    JSON.stringify({ "raw-video-job": rawVideoRecord("raw-video-job", videoPath) }),
    "utf8",
  );

  const served = await serveApp(storageRoot);
  const url = `${served.baseUrl}/api/jobs/raw-video-job/raw-video/stream`;

  try {
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(full.headers.get("content-disposition"), "inline");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), String(bytes.length));
    assert.equal(await full.text(), bytes.toString());

    const ranged = await fetch(url, { headers: { Range: "bytes=2-5" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 2-5/${bytes.length}`);
    assert.equal(ranged.headers.get("content-length"), "4");
    assert.equal(await ranged.text(), "2345");

    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal(await head.text(), "");
  } finally {
    await served.close();
  }
});

test("raw-video stream maps missing job, missing source and escape candidates", async () => {
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "app-raw-video-outside-"));
  const outsideVideo = path.join(outsideRoot, "outside.mp4");
  await writeFile(outsideVideo, "outside bytes", "utf8");

  const fixture = await rawVideoFixture({
    "no-source": rawVideoRecord("no-source"),
    "escaped-source": rawVideoRecord("escaped-source", outsideVideo),
  });

  try {
    const notFound = await jsonFetch(fixture.baseUrl, "/api/jobs/absent-job/raw-video/stream");
    assert.equal(notFound.response.status, 404);

    const missing = await jsonFetch(fixture.baseUrl, "/api/jobs/no-source/raw-video/stream");
    assert.equal(missing.response.status, 422);
    assert.equal(missing.body.code, "source_video_missing");

    const escaped = await jsonFetch(fixture.baseUrl, "/api/jobs/escaped-source/raw-video/stream");
    assert.equal(escaped.response.status, 422);
    assert.equal(escaped.body.code, "source_video_unreadable");
  } finally {
    await fixture.close();
  }
});

// ─── ② 抖音图文自动发布：路由、并发互斥与验证码通路 ─────────────────────────

const NOTE_NOW = "2026-08-10T08:00:00.000Z";
const NOTE_ACTOR = { userId: "user-1", displayName: "发布员", role: "publisher" as const };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 假 CLI：临时目录里的 shell stub。**绝不联网、绝不调用真实 sau**。 */
async function writeStubCli(
  directory: string,
  options: {
    check?: { stdout?: string; exitCode?: number };
    upload?: { stdout?: string; exitCode?: number; sleepSeconds?: number };
  } = {},
): Promise<string> {
  const stubPath = path.join(directory, `sau-stub-${Math.random().toString(36).slice(2, 8)}.sh`);
  const lines = ["#!/bin/sh"];
  // 上游是 `sau douyin check ...` vs `sau douyin upload-note ...`，按 action 分支才有真实感
  lines.push('case "$*" in');
  lines.push('  *" check "*)');
  for (const line of (options.check?.stdout ?? "valid").split("\n")) {
    if (line.length > 0) lines.push(`    printf '%s\\n' ${shellQuote(line)}`);
  }
  lines.push(`    exit ${options.check?.exitCode ?? 0}`);
  lines.push("    ;;");
  lines.push("esac");
  const upload = options.upload ?? {};
  if (upload.sleepSeconds) lines.push(`sleep ${upload.sleepSeconds}`);
  for (const line of (upload.stdout ?? "").split("\n")) {
    if (line.length > 0) lines.push(`printf '%s\\n' ${shellQuote(line)}`);
  }
  lines.push(`exit ${upload.exitCode ?? 0}`);
  await writeFile(stubPath, `${lines.join("\n")}\n`, "utf8");
  await chmod(stubPath, 0o755);
  return stubPath;
}

/**
 * 图文发布夹具：用 Task 2 的真实打包产出图文包与磁盘图片，
 * 再把这一包种进索引（图文包的创建入口尚未接线，见计划 Task 5/6）。
 */
async function notePublishFixture(
  options: {
    stub?: {
      check?: { stdout?: string; exitCode?: number };
      upload?: { stdout?: string; exitCode?: number; sleepSeconds?: number };
    } | null;
    autoPublish?: PublishTask["autoPublish"];
    withoutSauRunner?: boolean;
    removeSecondImage?: boolean;
    /** 覆盖图文标题，用来构造超限文案。 */
    title?: string;
  } = {},
) {
  const storageRoot = await realpath(await mkdtemp(path.join(tmpdir(), "app-note-publish-")));
  const jobId = "note-job";
  const snapshotsDirectory = path.join(storageRoot, "output", "videos", jobId, "hyperframes", "snapshots");
  await mkdir(snapshotsDirectory, { recursive: true });
  await mkdir(path.join(storageRoot, "cache"), { recursive: true });
  await writeFile(path.join(snapshotsDirectory, "frame-00-at-3s.png"), Buffer.concat([NOTE_PNG_LATE, Buffer.from([0])]));
  await writeFile(path.join(snapshotsDirectory, "frame-01-at-9s.png"), Buffer.concat([NOTE_PNG_LATE, Buffer.from([1])]));

  const noteCopy = {
    title: options.title ?? "抖音图文标题",
    description: "抖音图文正文",
    hashtags: ["内容创作", "效率"],
  };
  const packageId = "note-package";
  const taskId = "note-task";
  const task: PublishTask = {
    id: taskId,
    packageId,
    platform: "douyin",
    title: noteCopy.title,
    description: noteCopy.description,
    hashtags: [...noteCopy.hashtags],
    copySource: "ai",
    status: "ready",
    contentRevision: 1,
    createdAt: NOTE_NOW,
    updatedAt: NOTE_NOW,
    ...(options.autoPublish ? { autoPublish: options.autoPublish } : {}),
  };

  const assets = new PublishingAssetService({ storageRoot });
  const built = await assets.createNotePackageAssets({
    packageId,
    sourceJobId: jobId,
    version: 1,
    noteCopy,
    title: "图文交付包",
    // 与下面种进索引的 task 完全一致，免得启动扫描误判投影过期而重写 platforms/
    tasks: [{ ...task }],
    actor: NOTE_ACTOR,
  });
  if (options.removeSecondImage) {
    await writeFile(path.join(built.packagePath, "images", "02.png"), Buffer.concat([NOTE_PNG_LATE, Buffer.from([9])]));
  }

  const packageRecord: DeliveryPackage = {
    id: packageId,
    sourceJobId: jobId,
    version: 1,
    state: "active",
    title: "图文交付包",
    packagePath: built.packagePath,
    videoSha256: built.imageManifestSha256,
    videoSize: built.imageSize,
    videoMethod: "copy",
    assetHealth: built.assetHealth,
    contentType: "note",
    imagePaths: [...built.imagePaths],
    noteCopy: { ...noteCopy, hashtags: [...noteCopy.hashtags] },
    createdBy: NOTE_ACTOR,
    createdAt: NOTE_NOW,
    updatedAt: NOTE_NOW,
  };
  await writeFile(path.join(storageRoot, "cache", "publishing-index.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 2,
    nextVersionBySource: { [jobId]: 2 },
    packages: { [packageId]: packageRecord },
    tasks: { [taskId]: task },
    audit: [],
    tombstones: {},
  }, null, 2), "utf8");

  const sauBaseDir = path.join(storageRoot, "sau");
  await mkdir(sauBaseDir, { recursive: true });
  const cookieFilePath = path.join(storageRoot, "douyin-cookie.txt");
  await writeFile(cookieFilePath, "sessionid=fake-session; sid_guard=fake-guard", "utf8");
  const sauBinary = options.stub === null
    ? undefined
    : await writeStubCli(storageRoot, options.stub ?? { upload: { stdout: "🥳 图文发布成功" } });
  const sauRunner = options.withoutSauRunner
    ? undefined
    : new SauRunner({
        ...(sauBinary ? { sauBinary } : {}),
        sauBaseDir,
        cookieFilePath,
        accountName: "mine",
      });

  const served = await serveApp(storageRoot, sauRunner ? { sauRunner } : {});
  const boot = await jsonFetch(served.baseUrl, "/api/local-users/bootstrap", {
    method: "POST",
    body: { displayName: "主管", pin: "123456" },
  });
  assert.equal(boot.response.status, 201);
  const adminToken = boot.body.session.token as string;
  const publisher = await jsonFetch(served.baseUrl, "/api/local-users", {
    method: "POST",
    token: adminToken,
    body: { displayName: "发布者", role: "publisher" },
  });
  assert.equal(publisher.response.status, 201);
  const session = await jsonFetch(served.baseUrl, "/api/local-sessions", {
    method: "POST",
    body: { userId: publisher.body.user.id },
  });
  assert.equal(session.response.status, 201);
  const token = session.body.session.token as string;

  const reader = new PublishingStore(new LocalStorage(storageRoot));
  await reader.init();

  return {
    ...served,
    storageRoot,
    jobId,
    taskId,
    packageId,
    noteCopy,
    sauBaseDir,
    token,
    readPublishingBytes: () => readFile(path.join(storageRoot, "cache", "publishing-index.json")),
    async readIndex() {
      return JSON.parse(await readFile(path.join(storageRoot, "cache", "publishing-index.json"), "utf8")) as {
        tasks: Record<string, PublishTask>;
      };
    },
    async previewRevision() {
      return (await reader.previewRevision(packageId))!;
    },
    publish(body: unknown) {
      return jsonFetch(served.baseUrl, `/api/publishing/tasks/${taskId}/auto-publish`, {
        method: "POST",
        token,
        body,
      });
    },
    submitCode(code: string) {
      return jsonFetch(served.baseUrl, `/api/publishing/tasks/${taskId}/auto-publish/code`, {
        method: "POST",
        token,
        body: { code },
      });
    },
    async waitForStatus(status: string) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const index = await this.readIndex();
        if (index.tasks[taskId]?.autoPublish?.status === status) return index.tasks[taskId]!;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`等待 autoPublish 进入 ${status} 超时`);
    },
  };
}

test("auto-publish refuses a video package with a clear error", async () => {
  const fixture = await publishingApiFixture();
  try {
    const created = await previewAndCreatePackage(fixture);
    const reader = new PublishingStore(new LocalStorage(fixture.storageRoot));
    await reader.init();
    const before = await fixture.readPublishingBytes();

    const response = await jsonFetch(
      fixture.baseUrl,
      `/api/publishing/tasks/${created.tasks[0].id}/auto-publish`,
      { method: "POST", token: fixture.publisherToken, body: { previewRevision: await reader.previewRevision(created.package.id) } },
    );

    assert.equal(response.response.status, 422);
    assert.equal(response.body.code, "publish_not_a_note_package");
    assert.match(response.body.message, /图文/u);
    assert.deepEqual(await fixture.readPublishingBytes(), before);
  } finally {
    await fixture.close();
  }
});

test("auto-publish requires a preview revision and writes nothing without it", async () => {
  const fixture = await notePublishFixture();
  try {
    const before = await fixture.readPublishingBytes();

    for (const body of [{}, { previewRevision: "" }, { previewRevision: "   " }]) {
      const response = await fixture.publish(body);
      assert.equal(response.response.status, 400);
      assert.equal(response.body.code, "publish_validation_failed");
      assert.match(response.body.message, /预览/u);
    }

    assert.deepEqual(await fixture.readPublishingBytes(), before);
    assert.equal((await fixture.readIndex()).tasks[fixture.taskId]!.autoPublish, undefined);
  } finally {
    await fixture.close();
  }
});

test("auto-publish rejects a preview revision that went stale after the copy was edited", async () => {
  const fixture = await notePublishFixture();
  try {
    const revision = await fixture.previewRevision();
    // 预览之后改了文案 → 旧 revision 必须失效
    const edited = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${fixture.taskId}/content`, {
      method: "PATCH",
      token: fixture.token,
      body: { title: "改过的图文标题", description: "改过的图文正文", hashtags: ["内容创作"], expectedRevision: 1 },
    });
    assert.equal(edited.response.status, 200);
    const before = await fixture.readPublishingBytes();

    const response = await fixture.publish({ previewRevision: revision });

    assert.equal(response.response.status, 409);
    assert.equal(response.body.code, "publish_revision_conflict");
    assert.match(response.body.message, /预览|重试|修改/u);
    assert.deepEqual(await fixture.readPublishingBytes(), before);
    assert.equal((await fixture.readIndex()).tasks[fixture.taskId]!.autoPublish, undefined);
  } finally {
    await fixture.close();
  }
});

test("auto-publish reports a clear error when sau is not configured and writes nothing", async () => {
  const fixture = await notePublishFixture({ withoutSauRunner: true });
  try {
    const revision = await fixture.previewRevision();
    const before = await fixture.readPublishingBytes();

    const response = await fixture.publish({ previewRevision: revision });

    assert.equal(response.response.status, 422);
    assert.match(response.body.message, /未配置/u);
    assert.match(response.body.message, /sau/u);
    assert.deepEqual(await fixture.readPublishingBytes(), before);
    assert.equal((await fixture.readIndex()).tasks[fixture.taskId]!.autoPublish, undefined);
  } finally {
    await fixture.close();
  }
});

test("auto-publish refuses images that are no longer intact", async () => {
  const fixture = await notePublishFixture({ removeSecondImage: true });
  try {
    const revision = await fixture.previewRevision();
    const before = await fixture.readPublishingBytes();

    const response = await fixture.publish({ previewRevision: revision });

    assert.equal(response.response.status, 422);
    assert.match(response.body.message, /图/u);
    assert.deepEqual(await fixture.readPublishingBytes(), before);
    assert.equal((await fixture.readIndex()).tasks[fixture.taskId]!.autoPublish, undefined);
  } finally {
    await fixture.close();
  }
});

test("a running auto-publish blocks a second attempt on the same task", async () => {
  const fixture = await notePublishFixture({ stub: { upload: { stdout: "🥳 图文发布成功", sleepSeconds: 2 } } });
  try {
    const revision = await fixture.previewRevision();

    const first = fixture.publish({ previewRevision: revision });
    const running = await fixture.waitForStatus("running");

    const second = await fixture.publish({ previewRevision: revision });
    assert.equal(second.response.status, 409);
    assert.equal(second.body.code, "publish_auto_publish_in_progress");
    assert.match(second.body.message, /正在进行中|结束/u);
    // 没有产生第二条记录
    const during = (await fixture.readIndex()).tasks[fixture.taskId]!;
    assert.equal(during.autoPublish!.attemptId, running.autoPublish!.attemptId);

    const finished = await first;
    assert.equal(finished.response.status, 200);
    assert.equal(finished.body.task.autoPublish.status, "succeeded");
    const after = (await fixture.readIndex()).tasks[fixture.taskId]!;
    assert.equal(after.autoPublish!.attemptId, during.autoPublish!.attemptId);
    assert.equal(after.autoPublish!.status, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("a failed login precheck records failed while the task stays ready", async () => {
  const fixture = await notePublishFixture({ stub: { check: { stdout: "invalid", exitCode: 1 } } });
  try {
    const revision = await fixture.previewRevision();

    const response = await fixture.publish({ previewRevision: revision });

    assert.equal(response.response.status, 200);
    assert.equal(response.body.task.autoPublish.status, "failed");
    assert.equal(response.body.task.autoPublish.attemptId.length > 0, true);
    assert.ok(response.body.task.autoPublish.finishedAt);
    // 绝不写 published：预检失败只记机器动作失败
    assert.equal(response.body.task.status, "ready");
    const stored = (await fixture.readIndex()).tasks[fixture.taskId]!;
    assert.equal(stored.status, "ready");
    assert.equal(stored.publishedAt, undefined);
  } finally {
    await fixture.close();
  }
});

test("a verification code request parks the attempt and the code is written where sau reads it", async () => {
  const fixture = await notePublishFixture({
    stub: {
      upload: {
        stdout: [
          "🏃 小人开始搬运图文，共 2 张图片",
          "📱 检测到短信验证码弹窗",
          "⏳ 等待验证码输入；可在交互终端直接输入，或写入文件: /sau/verify_code.txt",
        ].join("\n"),
        exitCode: 1,
      },
    },
  });
  try {
    const revision = await fixture.previewRevision();

    const response = await fixture.publish({ previewRevision: revision });

    assert.equal(response.response.status, 200);
    assert.equal(response.body.task.autoPublish.status, "awaiting_code");
    assert.equal(response.body.task.status, "ready");

    const code = await fixture.submitCode("135790");
    assert.equal(code.response.status, 200);
    assert.equal(code.body.task.autoPublish.status, "awaiting_code");
    assert.equal(
      await readFile(path.join(fixture.sauBaseDir, "verify_code.txt"), "utf8"),
      "135790",
    );
    // 状态没被这次提交改掉，任务也仍是 ready
    assert.equal(code.body.task.status, "ready");
  } finally {
    await fixture.close();
  }
});

test("a successful upload records succeeded and never published", async () => {
  const fixture = await notePublishFixture({ stub: { upload: { stdout: "🥳 图文发布成功，小人开心收工" } } });
  try {
    const revision = await fixture.previewRevision();

    const response = await fixture.publish({ previewRevision: revision });

    assert.equal(response.response.status, 200);
    assert.equal(response.body.task.autoPublish.status, "succeeded");
    // 这是本设计最关键的一条：退出码 0 只算「已提交」
    assert.notEqual(response.body.task.status, "published");
    assert.equal(response.body.task.status, "ready");
    assert.equal(response.body.task.publishedAt, undefined);
    assert.match(response.body.task.autoPublish.message, /图文发布成功/u);
    assert.equal((await fixture.readIndex()).tasks[fixture.taskId]!.status, "ready");
  } finally {
    await fixture.close();
  }
});

// ─── ② Task 5：包级预览与图片接口（发布前必经确认的数据面） ──────────────────

test("package preview returns video metadata, per-platform copy and the revision Task 4 accepts", async () => {
  const fixture = await publishingApiFixture();
  try {
    const created = await previewAndCreatePackage(fixture);
    const reader = new PublishingStore(new LocalStorage(fixture.storageRoot));
    await reader.init();

    const response = await jsonFetch(
      fixture.baseUrl,
      `/api/publishing/packages/${created.package.id}/preview`,
      { token: fixture.publisherToken },
    );

    assert.equal(response.response.status, 200);
    const preview = response.body.preview as Record<string, any>;
    assert.equal(preview.package.contentType, "video");
    assert.equal(preview.package.id, created.package.id);
    assert.equal(preview.video.sha256, created.package.videoSha256);
    assert.equal(preview.video.size, created.package.videoSize);
    assert.equal(typeof preview.video.hasCover, "boolean");
    assert.equal(preview.imagePaths, undefined);
    // 视频包用视频口径（标题上限 55），不是图文口径
    assert.equal(preview.copyChecks.length, 1);
    assert.equal(preview.copyChecks[0].title.limit, 55);
    assert.equal(preview.copyChecks[0].violations.length, 0);
    // 预览产出的 revision 就是 store 的包级指纹
    assert.equal(preview.previewRevision, await reader.previewRevision(created.package.id));
    assert.deepEqual(preview.tasks.map((task: any) => task.platform), ["douyin"]);
  } finally {
    await fixture.close();
  }
});

test("note package preview returns ordered images and the note copy with note-policy limits", async () => {
  const fixture = await notePublishFixture();
  try {
    const response = await jsonFetch(
      fixture.baseUrl,
      `/api/publishing/packages/${fixture.packageId}/preview`,
      { token: fixture.token },
    );

    assert.equal(response.response.status, 200);
    const preview = response.body.preview as Record<string, any>;
    assert.equal(preview.package.contentType, "note");
    assert.equal(preview.package.assetHealth, "healthy");
    // 有序：与包内实际文件一一对应
    assert.deepEqual(preview.imagePaths, ["images/01.png", "images/02.png"]);
    assert.deepEqual(preview.noteCopy, fixture.noteCopy);
    assert.equal(preview.video, undefined);
    // 图文口径：标题上限 20、正文上限 1000
    assert.equal(preview.copyChecks.length, 1);
    assert.equal(preview.copyChecks[0].scope, "package");
    assert.equal(preview.copyChecks[0].title.limit, 20);
    assert.equal(preview.copyChecks[0].description.limit, 1000);
    assert.equal(preview.copyChecks[0].title.actual, fixture.noteCopy.title.length);
    assert.equal(preview.copyChecks[0].violations.length, 0);
  } finally {
    await fixture.close();
  }
});

test("note package preview flags copy that exceeds the 20 character title limit", async () => {
  // 造一份超过图文标题上限的文案，预览必须把超限显式报出来（预览是发布前最后一道校验）
  const longTitle = "这是一个明显超过二十个字上限的抖音图文标题示例文案";
  assert.ok([...longTitle].length > 20, "夹具标题必须真的超过 20 字");
  const fixture = await notePublishFixture({ title: longTitle });
  try {
    const response = await jsonFetch(
      fixture.baseUrl,
      `/api/publishing/packages/${fixture.packageId}/preview`,
      { token: fixture.token },
    );

    assert.equal(response.response.status, 200);
    const check = (response.body.preview as Record<string, any>).copyChecks[0];
    assert.equal(check.title.limit, 20);
    assert.equal(check.title.actual > 20, true);
    assert.equal(check.title.over, true);
    assert.equal(check.description.over, false);
    assert.equal(check.violations.length, 1);
    assert.equal(check.violations[0].field, "title");
    assert.match(check.violations[0].message, /20/u);
  } finally {
    await fixture.close();
  }
});

test("package preview reports a missing package", async () => {
  const fixture = await notePublishFixture();
  try {
    const response = await jsonFetch(
      fixture.baseUrl,
      "/api/publishing/packages/no-such-package/preview",
      { token: fixture.token },
    );

    assert.equal(response.response.status, 404);
    assert.equal(response.body.code, "publish_package_not_found");
  } finally {
    await fixture.close();
  }
});

test("package images map to imagePaths by index and reject out of range or bad indexes", async () => {
  const fixture = await notePublishFixture();
  try {
    const first = await fetch(`${fixture.baseUrl}/api/publishing/packages/${fixture.packageId}/images/0`, {
      headers: { "X-Local-Session": fixture.token },
    });
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /image\/png/u);
    const expected = await readFile(path.join(
      fixture.storageRoot, "output", "publishing", fixture.jobId, `v1-${fixture.packageId}`, "images", "01.png",
    ));
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), expected);

    const second = await fetch(`${fixture.baseUrl}/api/publishing/packages/${fixture.packageId}/images/1`, {
      headers: { "X-Local-Session": fixture.token },
    });
    assert.equal(second.status, 200);
    assert.notDeepEqual(Buffer.from(await second.arrayBuffer()), expected);

    for (const index of ["2", "99"]) {
      const missing = await fetch(`${fixture.baseUrl}/api/publishing/packages/${fixture.packageId}/images/${index}`, {
        headers: { "X-Local-Session": fixture.token },
      });
      assert.equal(missing.status, 404, `index ${index} 应越界 404`);
    }
    for (const index of ["-1", "abc", "1.5"]) {
      const invalid = await fetch(`${fixture.baseUrl}/api/publishing/packages/${fixture.packageId}/images/${index}`, {
        headers: { "X-Local-Session": fixture.token },
      });
      assert.equal(invalid.status, 400, `index ${index} 应参数错误 400`);
    }
  } finally {
    await fixture.close();
  }
});

test("the revision from the preview endpoint is accepted by auto-publish end to end", async () => {
  const fixture = await notePublishFixture({ stub: { upload: { stdout: "🥳 图文发布成功" } } });
  try {
    // 先预览取 revision（Task 5 产出），再带它提交（Task 4 校验）—— 这是「必经确认」的闭环
    const preview = await jsonFetch(
      fixture.baseUrl,
      `/api/publishing/packages/${fixture.packageId}/preview`,
      { token: fixture.token },
    );
    assert.equal(preview.response.status, 200);
    const revision = (preview.body.preview as Record<string, any>).previewRevision as string;
    assert.match(revision, /^[0-9a-f]{64}$/u);

    const submitted = await fixture.publish({ previewRevision: revision });

    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.body.task.autoPublish.status, "succeeded");
    assert.notEqual(submitted.body.task.status, "published");
  } finally {
    await fixture.close();
  }
});

// ─── ② Task 5.5：图文包的创建入口（补上 createNotePackageAssets 的调用方） ────

function notePreviewBody(platforms: string[] = ["douyin"]) {
  return { platforms, contentType: "note" };
}

function noteCreateBody(previewRevision: string, noteCopy: Record<string, unknown>, platforms = ["douyin"]) {
  return {
    sourceJobId: "publish-job",
    previewRevision,
    title: "图文交付包",
    contentType: "note",
    noteCopy,
    platforms: platforms.map((platform) => ({ platform })),
  };
}

test("note job preview lists the scene snapshots and a note-flavoured copy", async () => {
  const fixture = await publishingApiFixture();
  try {
    const response = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: notePreviewBody() },
    );

    assert.equal(response.response.status, 200);
    const preview = response.body.preview as Record<string, any>;
    assert.equal(preview.contentType, "note");
    assert.deepEqual(preview.images.map((image: any) => image.name), ["frame-00-at-3s.png", "frame-01-at-9s.png"]);
    // 图文口径：标题必须已被压到 20 字以内
    assert.ok([...preview.noteCopy.title].length <= 20, preview.noteCopy.title);
    assert.equal(Array.isArray(preview.noteCopy.hashtags), true);
    assert.match(preview.previewRevision, /^[0-9a-f]{64}$/u);
  } finally {
    await fixture.close();
  }
});

test("note job preview compresses an over-long source title and says so", async () => {
  const longTitle = "这是一个明显超过二十个字上限的抖音图文标题示例文案";
  const fixture = await publishingApiFixture({}, { cleanedTitle: longTitle });
  try {
    const response = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: notePreviewBody() },
    );

    assert.equal(response.response.status, 200);
    const preview = response.body.preview as Record<string, any>;
    assert.equal(preview.noteCopyTitleCompressed, true);
    assert.equal([...preview.noteCopy.title].length, 20);
  } finally {
    await fixture.close();
  }
});

test("creating a note package packs the snapshots and records note metadata", async () => {
  const fixture = await publishingApiFixture();
  try {
    const previewResponse = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: notePreviewBody() },
    );
    const preview = previewResponse.body.preview as Record<string, any>;
    const noteCopy = { title: "抖音图文标题", description: "抖音图文正文", hashtags: ["内容创作"] };

    const created = await jsonFetch(fixture.baseUrl, "/api/publishing/packages", {
      method: "POST",
      token: fixture.publisherToken,
      body: noteCreateBody(preview.previewRevision, noteCopy),
    });

    assert.equal(created.response.status, 201);
    const pkg = created.body.package.package as Record<string, any>;
    assert.equal(pkg.contentType, "note");
    assert.deepEqual(pkg.imagePaths, ["images/01.png", "images/02.png"]);
    assert.deepEqual(pkg.noteCopy, noteCopy);
    assert.equal(pkg.assetHealth, "healthy");
    // note 包的完整性凭据是图片清单哈希
    assert.match(pkg.videoSha256, /^[0-9a-f]{64}$/u);
    assert.equal(pkg.videoMethod, "copy");
    assert.ok(pkg.videoSize > 0);
    // 任务文案与包级 noteCopy 一致（不会出现「看到一份、发出去另一份」）
    const task = created.body.package.tasks[0] as Record<string, any>;
    assert.equal(task.platform, "douyin");
    assert.equal(task.title, noteCopy.title);
    assert.equal(task.description, noteCopy.description);

    // 磁盘上确实按场景序落了图，且 manifest 标注为图文
    const packagePath = path.join(fixture.storageRoot, "output", "publishing", fixture.jobId, `v1-${pkg.id}`);
    assert.deepEqual(
      (await readdir(path.join(packagePath, "images"))).sort(),
      ["01.png", "02.png"],
    );
    const manifest = JSON.parse(await readFile(path.join(packagePath, "manifest.json"), "utf8")) as {
      contentType: string;
      images: { paths: string[] };
    };
    assert.equal(manifest.contentType, "note");
    assert.deepEqual(manifest.images.paths, ["images/01.png", "images/02.png"]);
    await assert.rejects(stat(path.join(packagePath, "video.mp4")), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("creating a note package enforces the note copy policy and the supported platform", async () => {
  const fixture = await publishingApiFixture();
  try {
    const previewResponse = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: notePreviewBody() },
    );
    const revision = (previewResponse.body.preview as Record<string, any>).previewRevision as string;
    const before = await fixture.readPublishingBytes();

    const tooLongTitle = "这是一个明显超过二十个字上限的图文标题文案";
    assert.ok([...tooLongTitle].length > 20, "夹具标题必须真的超过 20 字");
    const tooLong = await jsonFetch(fixture.baseUrl, "/api/publishing/packages", {
      method: "POST",
      token: fixture.publisherToken,
      body: noteCreateBody(revision, { title: tooLongTitle, description: "正文", hashtags: [] }),
    });
    assert.equal(tooLong.response.status, 422);
    assert.match(tooLong.body.message, /20/u);

    const unsupported = await jsonFetch(fixture.baseUrl, "/api/publishing/packages", {
      method: "POST",
      token: fixture.publisherToken,
      body: noteCreateBody(revision, { title: "图文标题", description: "正文", hashtags: [] }, ["bilibili"]),
    });
    assert.equal(unsupported.response.status, 422);
    assert.match(unsupported.body.message, /图文|平台/u);

    // 两种失败都不写索引、不产包目录
    assert.deepEqual(await fixture.readPublishingBytes(), before);
    assert.deepEqual(await readdir(path.join(fixture.storageRoot, "output", "publishing")).catch(() => []), []);
  } finally {
    await fixture.close();
  }
});

test("creating a note package rejects a stale preview revision", async () => {
  const fixture = await publishingApiFixture();
  try {
    const before = await fixture.readPublishingBytes();

    const response = await jsonFetch(fixture.baseUrl, "/api/publishing/packages", {
      method: "POST",
      token: fixture.publisherToken,
      body: noteCreateBody("stale-revision", { title: "图文标题", description: "正文", hashtags: [] }),
    });

    assert.equal(response.response.status, 409);
    assert.equal(response.body.code, "publish_revision_conflict");
    assert.deepEqual(await fixture.readPublishingBytes(), before);
  } finally {
    await fixture.close();
  }
});

test("a note package created through the API can be previewed and then auto-published", async () => {
  const fixture = await publishingApiFixture({}, { sauStub: { upload: { stdout: "🥳 图文发布成功，小人开心收工" } } });
  assert.equal(fixture.hasSau, true);
  try {
    // 1) 图文预览 → 2) 创建图文包（这条链路以前不存在，createNotePackageAssets 没有调用方）
    const jobPreview = await jsonFetch(
      fixture.baseUrl,
      `/api/jobs/${fixture.jobId}/publishing/preview`,
      { method: "POST", token: fixture.publisherToken, body: notePreviewBody() },
    );
    const noteCopy = { title: "抖音图文标题", description: "抖音图文正文", hashtags: ["内容创作"] };
    const created = await jsonFetch(fixture.baseUrl, "/api/publishing/packages", {
      method: "POST",
      token: fixture.publisherToken,
      body: noteCreateBody((jobPreview.body.preview as Record<string, any>).previewRevision, noteCopy),
    });
    assert.equal(created.response.status, 201);
    const pkg = created.body.package.package as Record<string, any>;
    const taskId = (created.body.package.tasks[0] as Record<string, any>).id as string;

    // 3) 包级预览取 revision（Task 5）
    const packagePreview = await jsonFetch(
      fixture.baseUrl,
      `/api/publishing/packages/${pkg.id}/preview`,
      { token: fixture.publisherToken },
    );
    assert.equal(packagePreview.response.status, 200);
    assert.equal((packagePreview.body.preview as Record<string, any>).package.contentType, "note");

    // 4) 带 revision 提交（Task 4）
    const published = await jsonFetch(
      fixture.baseUrl,
      `/api/publishing/tasks/${taskId}/auto-publish`,
      {
        method: "POST",
        token: fixture.publisherToken,
        body: { previewRevision: (packagePreview.body.preview as Record<string, any>).previewRevision },
      },
    );

    assert.equal(published.response.status, 200);
    assert.equal(published.body.task.autoPublish.status, "succeeded");
    // 仍然绝不写 published
    assert.equal(published.body.task.status, "ready");
  } finally {
    await fixture.close();
  }
});
