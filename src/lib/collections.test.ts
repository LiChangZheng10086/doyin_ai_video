import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CollectionStore } from "./collections.js";
import { LocalStorage } from "./storage.js";
import type { JobRecord } from "../types.js";

test("CollectionStore keeps a crawled cover URL when creating child jobs", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "collections-cover-"));
  const storage = new LocalStorage(storageRoot);
  const capturedInputs: Array<{ coverUrl?: string }> = [];
  const jobStore = {
    async create(input: { sourceUrl?: string; topic?: string; coverUrl?: string }) {
      capturedInputs.push(input);
      return {
        id: "job-1",
        sourceUrl: input.sourceUrl ?? "",
        topic: input.topic ?? "",
        status: "queued",
        stage: "submitted",
        workflowMode: "manual",
        storagePath: "processed/scripts/job-1.json",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z"
      } as JobRecord;
    },
    async get() {
      return null;
    }
  };
  const collections = new CollectionStore(storage, jobStore);
  await collections.init();
  await storage.writeJson("cache/collections-index.json", {
    collection: {
      id: "collection",
      sourcePageUrl: "https://www.douyin.com/user/test",
      secUid: "sec-uid",
      nickname: "测试作者",
      avatarUrl: "",
      crawlResult: {
        items: [{
          awemeId: "video-1",
          desc: "测试视频",
          coverUrl: "https://cdn.example.com/video-1.jpg",
          videoUrl: "",
          duration: 10,
          createTime: 0,
          statistics: { diggCount: 0, commentCount: 0, shareCount: 0, playCount: 0 }
        }],
        totalCollected: 1,
        hasMore: false,
        nextCursor: 0
      },
      childJobIds: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z"
    }
  });

  await collections.createChildJobs("collection", ["video-1"]);
  assert.equal(capturedInputs[0]?.coverUrl, "https://cdn.example.com/video-1.jpg");
});
