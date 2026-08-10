import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createExpressApp } from "../app.js";
import type { JobRecord } from "../types.js";
import {
  resolveJobVideo,
  VideoOutputError,
  type ResolvedVideoFile,
} from "./video-output.js";

function job(id: string, videoOutputPath?: string): JobRecord {
  return {
    id,
    sourceUrl: "https://example.test/video",
    topic: "测试成片",
    status: "done",
    stage: "rendered",
    storagePath: path.join("processed", "scripts", `${id}.json`),
    videoOutputPath,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

async function storageFixture(id = "job-1") {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "video-output-"));
  const scriptPath = path.join(storageRoot, "processed", "scripts", `${id}.json`);
  await mkdir(path.dirname(scriptPath), { recursive: true });
  return { storageRoot, scriptPath };
}

async function assertVideoError(
  operation: Promise<unknown>,
  expected: { code: string; message: string },
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof VideoOutputError);
    assert.equal(error.status, 422);
    assert.equal(error.code, expected.code);
    assert.equal(error.message, expected.message);
    return true;
  });
}

test("resolves the current HyperFrames MP4 to its canonical path and exact size", async () => {
  const { storageRoot, scriptPath } = await storageFixture();
  const fallbackPath = path.join(storageRoot, "output", "videos", "job-1", "fallback.mp4");
  const videoPath = path.join(storageRoot, "output", "videos", "job-1", "hyperframes", "renders", "video.mp4");
  const bytes = Buffer.from("current hyperframes mp4 bytes");
  await mkdir(path.dirname(videoPath), { recursive: true });
  await writeFile(videoPath, bytes);
  await writeFile(fallbackPath, "fallback");
  await writeFile(scriptPath, JSON.stringify({
    hyperframesVideo: { videoPath: path.relative(storageRoot, videoPath) },
  }));

  const resolved = await resolveJobVideo(storageRoot, job("job-1", fallbackPath));

  assert.deepEqual(resolved, {
    path: await realpath(videoPath),
    size: bytes.byteLength,
    mimeType: "video/mp4",
  });
});

test("reports a stable missing-video error when no output was generated", async () => {
  const { storageRoot, scriptPath } = await storageFixture();
  await writeFile(scriptPath, JSON.stringify({}));

  await assertVideoError(resolveJobVideo(storageRoot, job("job-1")), {
    code: "publish_video_missing",
    message: "未找到可用成片，请重新生成视频",
  });
});

test("reports a stable unreadable error for malformed persisted video paths", async () => {
  const { storageRoot, scriptPath } = await storageFixture();
  await writeFile(scriptPath, JSON.stringify({ hyperframesVideo: { videoPath: { invalid: true } } }));

  await assertVideoError(resolveJobVideo(storageRoot, job("job-1")), {
    code: "publish_video_unreadable",
    message: "成片文件不可读取，请检查文件权限后重试",
  });
});

test("reports a stable missing-video error for an absent or empty MP4", async () => {
  for (const kind of ["absent", "empty"] as const) {
    const { storageRoot, scriptPath } = await storageFixture(kind);
    const videoPath = path.join(storageRoot, "output", "videos", kind, "video.mp4");
    await mkdir(path.dirname(videoPath), { recursive: true });
    if (kind === "empty") await writeFile(videoPath, "");
    await writeFile(scriptPath, JSON.stringify({ hyperframesVideo: { videoPath } }));

    await assertVideoError(resolveJobVideo(storageRoot, job(kind)), {
      code: "publish_video_missing",
      message: "未找到可用成片，请重新生成视频",
    });
  }
});

test("rejects non-MP4 and storage-root escape candidates with a stable unreadable error", async () => {
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "video-output-outside-"));
  const outsideVideo = path.join(outsideRoot, "outside.mp4");
  await writeFile(outsideVideo, "outside bytes");

  for (const candidate of ["video.mov", outsideVideo]) {
    const id = path.extname(candidate) === ".mov" ? "wrong-extension" : "escaped";
    const { storageRoot, scriptPath } = await storageFixture(id);
    const videoPath = path.isAbsolute(candidate)
      ? candidate
      : path.join(storageRoot, "output", "videos", id, candidate);
    if (!path.isAbsolute(candidate)) {
      await mkdir(path.dirname(videoPath), { recursive: true });
      await writeFile(videoPath, "not an mp4");
    }
    await writeFile(scriptPath, JSON.stringify({ hyperframesVideo: { videoPath } }));

    await assertVideoError(resolveJobVideo(storageRoot, job(id)), {
      code: "publish_video_unreadable",
      message: "成片文件不可读取，请检查文件权限后重试",
    });
  }
});

test("accepts a canonical in-storage path when the configured storage root is a symlink", async () => {
  const actualRoot = await mkdtemp(path.join(tmpdir(), "video-output-real-root-"));
  const storageRoot = `${actualRoot}-link`;
  await symlink(actualRoot, storageRoot, "dir");
  const id = "canonical-job";
  const scriptPath = path.join(actualRoot, "processed", "scripts", `${id}.json`);
  const videoPath = path.join(actualRoot, "output", "videos", id, "video.mp4");
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await mkdir(path.dirname(videoPath), { recursive: true });
  await writeFile(videoPath, "canonical bytes");
  await writeFile(scriptPath, JSON.stringify({
    hyperframesVideo: { videoPath: await realpath(videoPath) },
  }));

  const resolved = await resolveJobVideo(storageRoot, job(id));

  assert.equal(resolved.path, await realpath(videoPath));
});

test("stream and download share the injected resolver without changing headers or ranges", async () => {
  const { storageRoot } = await storageFixture("endpoint-job");
  const videoPath = path.join(storageRoot, "output", "videos", "endpoint-job", "video.mp4");
  const bytes = Buffer.from("0123456789");
  await mkdir(path.dirname(videoPath), { recursive: true });
  await mkdir(path.join(storageRoot, "cache"), { recursive: true });
  await writeFile(videoPath, bytes);
  await writeFile(path.join(storageRoot, "cache", "jobs-index.json"), JSON.stringify({
    "endpoint-job": job("endpoint-job"),
  }));

  const calls: Array<{ storageRoot: string; jobId: string }> = [];
  const injectedResolver = async (root: string, record: JobRecord): Promise<ResolvedVideoFile> => {
    calls.push({ storageRoot: root, jobId: record.id });
    return { path: await realpath(videoPath), size: bytes.length, mimeType: "video/mp4" };
  };
  const app = await createExpressApp({
    storagePath: storageRoot,
    rootDir: storageRoot,
    resolveJobVideo: injectedResolver,
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const stream = await fetch(`${baseUrl}/api/jobs/endpoint-job/video/stream`);
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("content-type"), "video/mp4");
    assert.equal(stream.headers.get("content-disposition"), "inline");
    assert.equal(stream.headers.get("accept-ranges"), "bytes");
    assert.equal(stream.headers.get("content-length"), String(bytes.length));
    assert.equal(await stream.text(), bytes.toString());

    const streamRange = await fetch(`${baseUrl}/api/jobs/endpoint-job/video/stream`, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(streamRange.status, 206);
    assert.equal(streamRange.headers.get("content-range"), `bytes 2-5/${bytes.length}`);
    assert.equal(streamRange.headers.get("accept-ranges"), "bytes");
    assert.equal(streamRange.headers.get("content-length"), "4");
    assert.equal(await streamRange.text(), "2345");

    const download = await fetch(`${baseUrl}/api/jobs/endpoint-job/video/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/u);
    assert.equal(download.headers.get("accept-ranges"), "bytes");
    assert.equal(download.headers.get("content-length"), String(bytes.length));

    const downloadRange = await fetch(`${baseUrl}/api/jobs/endpoint-job/video/download`, {
      headers: { Range: "bytes=6-8" },
    });
    assert.equal(downloadRange.status, 206);
    assert.equal(downloadRange.headers.get("content-range"), `bytes 6-8/${bytes.length}`);
    assert.match(downloadRange.headers.get("content-disposition") ?? "", /^attachment;/u);
    assert.equal(await downloadRange.text(), "678");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  assert.deepEqual(calls, Array.from({ length: 4 }, () => ({
    storageRoot,
    jobId: "endpoint-job",
  })));
});
