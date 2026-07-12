import assert from "node:assert/strict";
import { test } from "node:test";
import { simplifyChineseValue, toSimplifiedChinese } from "./chinese.js";

test("toSimplifiedChinese converts generated Traditional Chinese to Simplified Chinese", () => {
  assert.equal(
    toSimplifiedChinese("推薦6個我一定會用的skill，這是官方認證，直接幫你轉化並自動生成標準文檔。"),
    "推荐6个我一定会用的skill，这是官方认证，直接帮你转化并自动生成标准文档。"
  );
});

test("simplifyChineseValue converts strings in stored artifact objects", () => {
  const result = simplifyChineseValue({
    title: "推薦內容",
    shots: [{ captionLines: ["這是觀眾字幕"], duration: 6 }]
  });

  assert.deepEqual(result, {
    title: "推荐内容",
    shots: [{ captionLines: ["这是观众字幕"], duration: 6 }]
  });
});

test("toSimplifiedChinese preserves Simplified Chinese and Latin technical terms", () => {
  assert.equal(toSimplifiedChinese("为什么生成 Claude Code 分镜"), "为什么生成 Claude Code 分镜");
});
