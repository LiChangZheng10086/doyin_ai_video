import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTranscriptQuality as inspect } from "./transcript-quality.js";


test("quality reports sustained recognition loops without deleting any segments", () => {
  const segments = Array.from({ length: 63 }, (_, index) => ({ start: index * 1.3, end: (index + 1) * 1.3, text: "这次的战机是什么呢？" }));
  assert.ok(inspect({ segments, duration: 100 }).some((issue) => /重复/.test(issue)));
  assert.equal(segments.length, 63);
});

test("quality catches repeating blocks and long loops inside one segment", () => {
  const segments = Array.from({ length: 40 }, (_, i) => ({ start: i, end: i + 1, text: i % 2 ? "我们出发吧" : "谁在这里呢" }));
  assert.ok(inspect({ segments, duration: 50 }).some((issue) => /重复/.test(issue)));
  assert.ok(inspect({ segments: [{ start: 0, end: 30, text: "我们出发吧".repeat(15) }] }).some((issue) => /重复/.test(issue)));
});

test("quality preserves normal emphasis, choruses and occasional repeated questions", () => {
  assert.deepEqual(inspect({ segments: [
    { start: 0, end: 3, text: "快走快走快走！" },
    ...Array.from({ length: 6 }, (_, i) => ({ start: i * 3 + 3, end: i * 3 + 6, text: "让我们荡起双桨" })),
    { start: 23, end: 25, text: "这次的战机是什么呢？" },
    { start: 30, end: 32, text: "这次的战机是什么呢？" }
  ], duration: 40 }), []);
});

test("quality flags missing, nonfinite, reversed, unordered and excessive timestamps", () => {
  for (const segments of [
    [{ text: "无时间" }], [{ start: NaN, end: 2, text: "非有限" }],
    [{ start: 5, end: 2, text: "倒序" }], [{ start: 0, end: 600, text: "越界" }],
    [{ start: 3, end: 5, text: "后" }, { start: 1, end: 3, text: "前" }]
  ]) assert.ok(inspect({ segments, duration: 10 }).length);
  assert.deepEqual(inspect({ segments: [], text: "兼容没有分段的旧转录" }), []);
  assert.deepEqual(inspect({ segments: [{ start: 0, end: 10.3, text: "合理尾端误差" }], duration: 10 }), []);
});
