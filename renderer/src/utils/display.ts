/**
 * 展示层兜底文案与格式化。
 *
 * 采集侧会出现 `createTime = 0`、`duration = 0.119` 这类「没抓到」的脏数据，
 * 渲染层如果忠实照搬就会显示 `1970/1/1` 与 `0:00`——看起来像真实数据，
 * 实际是在骗用户。凡是无法确定的值，这里统一回落到明确的中文兜底文案。
 */

/** 昵称缺失时的兜底文案。 */
export const UNKNOWN_NICKNAME_TEXT = "未知用户";
/** 时间戳缺失或无效时的兜底文案。 */
export const UNKNOWN_TIME_TEXT = "未知时间";
/** 时长缺失或无效时的兜底文案。 */
export const UNKNOWN_DURATION_TEXT = "未知时长";

/**
 * 历史数据里落过盘的英文占位昵称，与后端 `src/lib/nickname.ts` 保持一致。
 * 后端已在读取时归一化，这里再兜一层，避免旧接口缓存或旧版后端把英文漏到界面上。
 */
const LEGACY_UNKNOWN_NICKNAMES = new Set(["unknown user", "unknown"]);

/** 昵称 → 可展示文案；空值、纯空白与历史英文占位值统一回落到「未知用户」。 */
export function displayNickname(value?: string | null): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return UNKNOWN_NICKNAME_TEXT;
  if (LEGACY_UNKNOWN_NICKNAMES.has(text.toLowerCase())) return UNKNOWN_NICKNAME_TEXT;
  return text;
}

/**
 * 抖音 `createTime`（秒级时间戳）→ 本地日期。
 *
 * 0、负数、NaN 以及落在 1970 年的时间戳都视为未知：爬虫没抓到 `create_time`
 * 时会写入 0，换算出来正是 `1970/1/1`，而抖音不存在 1970 年的作品。
 */
export function formatDateFromSeconds(createTime?: number | null): string {
  if (createTime == null || !Number.isFinite(createTime) || createTime <= 0) {
    return UNKNOWN_TIME_TEXT;
  }
  const date = new Date(createTime * 1000);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1970) {
    return UNKNOWN_TIME_TEXT;
  }
  return date.toLocaleDateString("zh-CN");
}

/**
 * 秒数 → `m:ss`（超过 1 小时为 `h:mm:ss`）。
 *
 * 非正数、NaN 以及不足 1 秒的值都视为未知：脏数据 `duration = 0.119`
 * 截断后是 `0:00`，而真实的抖音视频不可能短于 1 秒。
 */
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return UNKNOWN_DURATION_TEXT;
  }
  const total = Math.floor(seconds);
  if (total <= 0) return UNKNOWN_DURATION_TEXT;

  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * 带「时长」标签的时长文案：已知时是 `时长 1:35`，未知时是 `时长未知`。
 * 单独避免出现「时长 未知时长」这种重复文案。
 */
export function formatDurationWithLabel(seconds?: number | null): string {
  const text = formatDuration(seconds);
  return text === UNKNOWN_DURATION_TEXT ? "时长未知" : `时长 ${text}`;
}
