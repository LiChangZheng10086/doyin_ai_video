import assert from "node:assert/strict";
import { test } from "node:test";
import { getCleanArtifactDecision, getCleanArtifactLoadError } from "./jobArtifacts.js";
import type { Job, PipelineStepState } from "../types/index.js";

function job(clean: PipelineStepState): Job {
  return {
    id: "job",
    status: clean.status === "failed" ? "failed" : "queued",
    stage: clean.status === "failed" ? "failed" : "transcribed",
    workflowMode: "manual",
    steps: {
      transcribe: { status: "succeeded", attempts: 1 },
      clean,
      generate_video_prompts: { status: "pending", attempts: 0 },
      generate_video: { status: "pending", attempts: 0 }
    },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z"
  };
}

test("failed cleaning uses the step error and skips the cleaned request", () => {
  assert.deepEqual(
    getCleanArtifactDecision(job({ status: "failed", attempts: 3, lastError: "AI 域名无法解析" })),
    { shouldLoad: false, error: "AI 域名无法解析" }
  );
});

test("a missing artifact after successful cleaning is reported as data loss", () => {
  const succeeded = job({ status: "succeeded", attempts: 1 });
  assert.equal(
    getCleanArtifactLoadError(succeeded, 404, "cleaned result not found"),
    "任务记录显示 AI 洗稿已完成，但洗稿产物文件不存在。"
  );
});

test("pending and running cleaning skip the cleaned request without an error", () => {
  assert.deepEqual(getCleanArtifactDecision(job({ status: "pending", attempts: 0 })), { shouldLoad: false });
  assert.deepEqual(getCleanArtifactDecision(job({ status: "running", attempts: 1 })), { shouldLoad: false });
});

test("succeeded and legacy jobs load the cleaned artifact", () => {
  assert.deepEqual(getCleanArtifactDecision(job({ status: "succeeded", attempts: 1 })), { shouldLoad: true });
  assert.deepEqual(getCleanArtifactDecision({ ...job({ status: "pending", attempts: 0 }), steps: undefined }), { shouldLoad: true });
});
