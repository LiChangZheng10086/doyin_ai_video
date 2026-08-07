export interface SkillTranscript {
  desc: string;
  transcript: string;
}

export function buildSkillContext(transcripts: SkillTranscript[], maxChars = 12000) {
  if (transcripts.length === 0 || maxChars <= 0) {
    return "";
  }

  const separator = "\n\n---\n\n";
  const labels = transcripts.map((item) => `【${item.desc || "无描述"}】\n`);
  const reservedChars = labels.reduce((total, label) => total + label.length, 0) + separator.length * Math.max(0, transcripts.length - 1);
  const excerptBudget = Math.max(1, Math.floor((maxChars - reservedChars) / transcripts.length));

  const context = transcripts
    .map((item, index) => `${labels[index]}${excerptText(item.transcript, excerptBudget)}`)
    .join(separator);

  return context.slice(0, maxChars);
}

export function isRetryableSkillError(error: unknown) {
  const status = getErrorStatus(error);
  if (status >= 500) {
    return true;
  }
  const message = getErrorMessage(error);
  return /timeout|timed out|abort|econnreset|socket hang up|temporarily unavailable/i.test(message);
}

export function getSkillErrorMessage(error: unknown) {
  const status = getErrorStatus(error);
  const message = getErrorMessage(error) || "未知错误";
  if (status) {
    return `AI 服务请求失败（HTTP ${status}）：${message}`;
  }
  return `AI 服务请求失败：${message}`;
}

function excerptText(text: string, maxChars: number) {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const headChars = Math.max(1, Math.floor(maxChars * 0.7));
  const tailChars = Math.max(0, maxChars - headChars - 10);
  return `${normalized.slice(0, headChars)} …（中间内容已压缩）… ${tailChars > 0 ? normalized.slice(-tailChars) : ""}`.slice(0, maxChars);
}

function getErrorStatus(error: unknown) {
  if (!error || typeof error !== "object") {
    return 0;
  }
  const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  return Number(value.status ?? value.statusCode ?? value.response?.status ?? 0) || 0;
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const value = error as { message?: unknown; response?: { data?: { message?: unknown } } };
  return String(value.message ?? value.response?.data?.message ?? "");
}
