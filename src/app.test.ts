import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createExpressApp } from "./app.js";

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

async function publishingApiFixture(
  overrides: Partial<Parameters<typeof createExpressApp>[0]> = {},
) {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "app-publishing-"));
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
  await writeFile(path.join(storageRoot, "processed", "cleaned", `${jobId}.json`), JSON.stringify({
    output: {
      title: "发布测试作品",
      summary: "这是一段用于验证发布中心接口的简体中文摘要。",
      keyPoints: ["先审核平台文案", "再完成人工发布"],
      shortVideoScript: "发布前先检查内容，再按平台要求完成人工上传。",
      tags: ["内容创作", "发布流程"],
    },
  }), "utf8");

  const served = await serveApp(storageRoot, overrides);
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

test("publisher can create, edit, schedule, cancel, restore and record action errors with server actor", async () => {
  const fixture = await publishingApiFixture();
  try {
    const created = await previewAndCreatePackage(fixture);
    const task = created.tasks[0] as Record<string, any>;
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

test("due check is session-free, rejects actor overrides and records the system actor once", async () => {
  const fixture = await publishingApiFixture();
  try {
    const created = await previewAndCreatePackage(fixture);
    const taskId = created.tasks[0].id as string;
    const scheduledAt = new Date(Date.now() + 25).toISOString();
    const scheduled = await jsonFetch(fixture.baseUrl, `/api/publishing/tasks/${taskId}/schedule`, {
      method: "PATCH",
      token: fixture.publisherToken,
      body: { scheduledAt },
    });
    assert.equal(scheduled.response.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const rejected = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", {
      method: "POST",
      body: { actor: { role: "admin" }, status: "published" },
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.code, "publish_validation_failed");

    const first = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.notifications.length, 1);
    const second = await jsonFetch(fixture.baseUrl, "/api/publishing/due/check", { method: "POST" });
    assert.equal(second.response.status, 200);
    assert.equal(second.body.notifications.length, 0);

    const adminSession = await fixture.openAdmin();
    const detail = await jsonFetch(fixture.baseUrl, `/api/publishing/packages/${created.package.id}`, {
      token: adminSession.body.session.token,
    });
    const dueAudit = detail.body.package.audit.find((event: Record<string, any>) => event.action === "task.due");
    assert.deepEqual(dueAudit.actor, { userId: "system", displayName: "系统", role: "system" });
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
