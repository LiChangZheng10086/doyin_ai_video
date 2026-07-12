import type { Job } from "../types";

export function getCleanArtifactDecision(job: Job): { shouldLoad: boolean; error?: string } {
  const clean = job.steps?.clean;
  if (!clean) return { shouldLoad: true };
  if (clean.status === "failed") {
    return { shouldLoad: false, error: clean.lastError || "AI 洗稿失败，请检查模型配置后重试" };
  }
  if (clean.status === "pending" || clean.status === "running") {
    return { shouldLoad: false };
  }
  return { shouldLoad: true };
}

export function getCleanArtifactLoadError(job: Job, status: number | undefined, message: string) {
  if (job.steps?.clean?.status === "succeeded" && status === 404) {
    return "任务记录显示 AI 洗稿已完成，但洗稿产物文件不存在。";
  }
  if (job.status === "done" || job.steps?.clean?.status === "succeeded") {
    return `内容加载失败：${message}`;
  }
  return undefined;
}
