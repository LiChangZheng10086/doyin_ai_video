import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLISH_PLATFORMS,
  buildPublishText,
  normalizePlatformCopy,
  validateNoteCopy,
  validatePlatformCopy,
} from "./publishing-platforms.js";

test("supports only the four approved platforms with fixed policies", () => {
  assert.deepEqual(PUBLISH_PLATFORMS, {
    douyin: {
      label: "抖音",
      titleMax: 55,
      descriptionMax: 1000,
      hashtagMax: 10,
      hashtagLengthMax: 20,
      creatorUrl: "https://creator.douyin.com/creator-micro/content/upload",
    },
    xiaohongshu: {
      label: "小红书",
      titleMax: 20,
      descriptionMax: 1000,
      hashtagMax: 10,
      hashtagLengthMax: 20,
      creatorUrl: "https://creator.xiaohongshu.com/publish/publish",
    },
    wechat_channels: {
      label: "微信视频号",
      titleMax: 30,
      descriptionMax: 1000,
      hashtagMax: 10,
      hashtagLengthMax: 20,
      creatorUrl: "https://channels.weixin.qq.com/platform/post/create",
    },
    bilibili: {
      label: "哔哩哔哩",
      titleMax: 80,
      descriptionMax: 2000,
      hashtagMax: 10,
      hashtagLengthMax: 20,
      creatorUrl: "https://member.bilibili.com/platform/upload/video/frame",
    },
  });
});

test("normalizes fields and hashtags without truncating user content", () => {
  const longDescription = "正文".repeat(600);
  const copy = normalizePlatformCopy({
    title: "  标题  ",
    description: ` ${longDescription} `,
    hashtags: ["###AI", "#AI", "", " ##视频 ", "   "],
  });

  assert.deepEqual(copy, {
    title: "标题",
    description: longDescription,
    hashtags: ["AI", "视频"],
  });
});

test("reports the platform, field, actual length and limit", () => {
  const errors = validatePlatformCopy("xiaohongshu", {
    title: "这是一段超过二十个字符且绝对不能被静默截断的小红书标题",
    description: "",
    hashtags: [],
  });

  assert.deepEqual(errors[0], {
    platform: "xiaohongshu",
    field: "title",
    actual: 27,
    limit: 20,
    message: "小红书标题当前 27 字，最多 20 字",
  });
});

test("validates normalized required, description and hashtag limits", () => {
  assert.deepEqual(
    validatePlatformCopy("douyin", {
      title: "   ",
      description: "",
      hashtags: [],
    }),
    [{
      platform: "douyin",
      field: "title",
      actual: 0,
      limit: 1,
      message: "抖音标题不能为空",
    }]
  );

  const errors = validatePlatformCopy("douyin", {
    title: "标题",
    description: "文".repeat(1001),
    hashtags: [
      "#一二三四五六七八九十一二三四五六七八九十甲",
      ...Array.from({ length: 10 }, (_, index) => `标签${index}`),
    ],
  });

  assert.deepEqual(errors, [
    {
      platform: "douyin",
      field: "description",
      actual: 1001,
      limit: 1000,
      message: "抖音正文当前 1001 字，最多 1000 字",
    },
    {
      platform: "douyin",
      field: "hashtags",
      actual: 11,
      limit: 10,
      message: "抖音标签当前 11 个，最多 10 个",
    },
    {
      platform: "douyin",
      field: "hashtags",
      actual: 21,
      limit: 20,
      message: "抖音标签“一二三四五六七八九十一二三四五六七八九十甲”当前 21 字，最多 20 字",
    },
  ]);
});

test("counts Unicode code points instead of UTF-16 code units", () => {
  const errors = validatePlatformCopy("xiaohongshu", {
    title: "😀".repeat(20),
    description: "",
    hashtags: ["😀".repeat(20)],
  });

  assert.deepEqual(errors, []);
  assert.equal(validatePlatformCopy("xiaohongshu", {
    title: `${"😀".repeat(20)}好`,
    description: "",
    hashtags: [],
  })[0]?.actual, 21);
});

test("buildPublishText omits empty sections", () => {
  assert.equal(
    buildPublishText({ title: "标题", description: "", hashtags: ["AI", "视频"] }),
    "标题\n\n#AI #视频"
  );
  assert.equal(
    buildPublishText({ title: "标题", description: "正文", hashtags: [] }),
    "标题\n\n正文"
  );
  assert.equal(
    buildPublishText({ title: " 标题 ", description: "   ", hashtags: ["", "##AI"] }),
    "标题\n\n#AI"
  );
  assert.equal(
    buildPublishText({ title: "标题", description: "", hashtags: [] }),
    "标题"
  );
});

// ─── 图文口径（抖音图文 title ≤20、note(=description) ≤1000）────────────

test("图文标题上限是 20 字，与视频的 55 字口径彼此独立", () => {
  const twenty = { title: "一".repeat(20), description: "", hashtags: [] };
  assert.deepEqual(validateNoteCopy("douyin", twenty), []);

  const twentyOne = { title: "一".repeat(21), description: "", hashtags: [] };
  const errors = validateNoteCopy("douyin", twentyOne);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "title");
  assert.equal(errors[0].limit, 20);
  assert.match(errors[0].message, /20/);

  // 回归：视频口径不得被改动
  assert.deepEqual(validatePlatformCopy("douyin", { title: "一".repeat(55), description: "", hashtags: [] }), []);
});

test("图文正文上限 1000 字", () => {
  const ok = { title: "标题", description: "字".repeat(1000), hashtags: [] };
  assert.deepEqual(validateNoteCopy("douyin", ok), []);

  const tooLong = { title: "标题", description: "字".repeat(1001), hashtags: [] };
  const errors = validateNoteCopy("douyin", tooLong);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "description");
  assert.equal(errors[0].actual, 1001);
});

test("图文标签沿用既有规则（最多 10 个、每个 ≤20 字）", () => {
  const tooMany = { title: "标题", description: "", hashtags: Array.from({ length: 11 }, (_, i) => `tag${i}`) };
  assert.equal(validateNoteCopy("douyin", tooMany).length, 1);

  const tooLong = { title: "标题", description: "", hashtags: ["一".repeat(21)] };
  const errors = validateNoteCopy("douyin", tooLong);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /20/);

  assert.deepEqual(validateNoteCopy("douyin", { title: "标题", description: "", hashtags: ["写作", "AI"] }), []);
});

test("图文标题为空时报错", () => {
  const errors = validateNoteCopy("douyin", { title: "   ", description: "正文", hashtags: [] });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "title");
});
