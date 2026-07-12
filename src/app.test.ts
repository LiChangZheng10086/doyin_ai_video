import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createExpressApp } from "./app.js";

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
