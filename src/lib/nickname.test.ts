import assert from "node:assert/strict";
import { test } from "node:test";
import { UNKNOWN_NICKNAME, normalizeNickname } from "./nickname.js";

test("normalizeNickname keeps a real creator nickname", () => {
  assert.equal(normalizeNickname("张三说电影"), "张三说电影");
});

test("normalizeNickname falls back to Simplified Chinese for missing values", () => {
  assert.equal(normalizeNickname(undefined), UNKNOWN_NICKNAME);
  assert.equal(normalizeNickname(null), UNKNOWN_NICKNAME);
  assert.equal(normalizeNickname(""), UNKNOWN_NICKNAME);
  assert.equal(normalizeNickname("   "), UNKNOWN_NICKNAME);
  assert.equal(normalizeNickname(42), UNKNOWN_NICKNAME);
});

test("normalizeNickname heals the legacy English placeholder", () => {
  assert.equal(normalizeNickname("Unknown User"), UNKNOWN_NICKNAME);
  assert.equal(normalizeNickname("unknown user"), UNKNOWN_NICKNAME);
  assert.equal(normalizeNickname("Unknown"), UNKNOWN_NICKNAME);
});

test("normalizeNickname trims surrounding whitespace", () => {
  assert.equal(normalizeNickname("  张三说电影  "), "张三说电影");
});

test("UNKNOWN_NICKNAME is Simplified Chinese and never leaks English", () => {
  assert.equal(UNKNOWN_NICKNAME, "未知用户");
  assert.doesNotMatch(UNKNOWN_NICKNAME, /[A-Za-z]/);
});
