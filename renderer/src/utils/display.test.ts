import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UNKNOWN_DURATION_TEXT,
  UNKNOWN_NICKNAME_TEXT,
  UNKNOWN_TIME_TEXT,
  displayNickname,
  formatDateFromSeconds,
  formatDuration,
  formatDurationWithLabel,
} from "./display.js";

test("displayNickname keeps a real creator nickname", () => {
  assert.equal(displayNickname("张三说电影"), "张三说电影");
});

test("displayNickname never leaks the legacy English placeholder", () => {
  assert.equal(displayNickname("Unknown User"), UNKNOWN_NICKNAME_TEXT);
  assert.equal(displayNickname("unknown user"), UNKNOWN_NICKNAME_TEXT);
  assert.equal(displayNickname("Unknown"), UNKNOWN_NICKNAME_TEXT);
});

test("displayNickname falls back to Simplified Chinese for missing values", () => {
  assert.equal(displayNickname(undefined), UNKNOWN_NICKNAME_TEXT);
  assert.equal(displayNickname(null), UNKNOWN_NICKNAME_TEXT);
  assert.equal(displayNickname(""), UNKNOWN_NICKNAME_TEXT);
  assert.equal(displayNickname("   "), UNKNOWN_NICKNAME_TEXT);
});

test("formatDateFromSeconds renders a real timestamp", () => {
  // 2026-08-01T00:00:00Z（用 UTC 构造断言，避免依赖运行时区）
  const createTime = Date.UTC(2026, 7, 1) / 1000;
  const rendered = formatDateFromSeconds(createTime);
  assert.match(rendered, /2026/);
  assert.doesNotMatch(rendered, /1970/);
});

test("formatDateFromSeconds reports unknown instead of 1970/1/1", () => {
  assert.equal(formatDateFromSeconds(0), UNKNOWN_TIME_TEXT);
  assert.equal(formatDateFromSeconds(undefined), UNKNOWN_TIME_TEXT);
  assert.equal(formatDateFromSeconds(null), UNKNOWN_TIME_TEXT);
  assert.equal(formatDateFromSeconds(Number.NaN), UNKNOWN_TIME_TEXT);
  assert.equal(formatDateFromSeconds(-1), UNKNOWN_TIME_TEXT);
  // 落在 1970 年的时间戳同样是「没抓到」，不能渲染成 1970/1/1
  assert.equal(formatDateFromSeconds(1), UNKNOWN_TIME_TEXT);
});

test("formatDuration renders known durations", () => {
  assert.equal(formatDuration(30), "0:30");
  assert.equal(formatDuration(95), "1:35");
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3725), "1:02:05");
});

test("formatDuration reports unknown instead of 0:00", () => {
  assert.equal(formatDuration(0.119), UNKNOWN_DURATION_TEXT);
  assert.equal(formatDuration(0), UNKNOWN_DURATION_TEXT);
  assert.equal(formatDuration(undefined), UNKNOWN_DURATION_TEXT);
  assert.equal(formatDuration(null), UNKNOWN_DURATION_TEXT);
  assert.equal(formatDuration(Number.NaN), UNKNOWN_DURATION_TEXT);
  assert.equal(formatDuration(-5), UNKNOWN_DURATION_TEXT);
});

test("formatDurationWithLabel avoids the duplicated 「时长 未知时长」 copy", () => {
  assert.equal(formatDurationWithLabel(95), "时长 1:35");
  assert.equal(formatDurationWithLabel(0.119), "时长未知");
  assert.equal(formatDurationWithLabel(0), "时长未知");
  assert.equal(formatDurationWithLabel(undefined), "时长未知");
});

test("fallback copy stays Simplified Chinese", () => {
  for (const text of [UNKNOWN_NICKNAME_TEXT, UNKNOWN_TIME_TEXT, UNKNOWN_DURATION_TEXT]) {
    assert.doesNotMatch(text, /[A-Za-z]/);
  }
});
