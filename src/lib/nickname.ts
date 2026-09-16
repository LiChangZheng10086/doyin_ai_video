/**
 * 创作者昵称兜底文案。
 *
 * 采集侧解析不出昵称时会写入这个占位值，它会一路流到合集页 H1、合集列表标题
 * 以及 AI 洗稿/Skill 提炼的提示词里，所以必须是简体中文：
 * 早期版本写死英文 `Unknown User`，导致界面和提示词里出现英文身份名。
 */
export const UNKNOWN_NICKNAME = "未知用户";

/**
 * 历史版本（含已落盘的 `cache/collections-index.json`）写入过的英文占位值。
 * 读取时统一归一化，避免旧数据继续泄漏到界面和提示词。
 */
const LEGACY_UNKNOWN_NICKNAMES = new Set(["unknown user", "unknown"]);

/**
 * 把任意来源的昵称归一化成可直接展示的字符串。
 *
 * 空值、纯空白、以及历史英文占位值都回落到 {@link UNKNOWN_NICKNAME}。
 * 这里刻意返回非空字符串而不是空串：调用方会把昵称拼进
 * `抖音合集「${nickname}」` 这类提示词，空串会得到『合集「」』这种更差的文案。
 */
export function normalizeNickname(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return UNKNOWN_NICKNAME;
  if (LEGACY_UNKNOWN_NICKNAMES.has(text.toLowerCase())) return UNKNOWN_NICKNAME;
  return text;
}
