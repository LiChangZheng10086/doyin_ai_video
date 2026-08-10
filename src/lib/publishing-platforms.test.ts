import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLISH_PLATFORMS,
  buildPublishText,
  normalizePlatformCopy,
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
