import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVED_PLATFORMS } from "./publishing-assets.js";
import {
  AUTO_PUBLISH_ROUTES,
  PUBLISH_PLATFORMS,
  resolveAutoPublishEngine,
  buildPublishText,
  normalizePlatformCopy,
  validateNoteCopy,
  validatePlatformCopy,
} from "./publishing-platforms.js";
import { PLATFORMS as ROUTE_PLATFORMS } from "./publishing-routes.js";
import { NOTE_PLATFORMS, SUPPORTED_PLATFORMS } from "./publishing-service.js";
import { isPlatform } from "./publishing-store.js";
import { TOUTIAO_ARTICLE_LIMITS } from "./toutiao-article.js";

test("supports only the six approved platforms with fixed policies", () => {
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
    wechat_mp: {
      label: "微信公众号",
      // 标题 32 / 摘要（= description）120：官方 `draft/add` 的硬限制。
      titleMax: 32,
      descriptionMax: 120,
      hashtagMax: 10,
      hashtagLengthMax: 20,
      creatorUrl: "https://mp.weixin.qq.com/",
    },
    toutiao: {
      label: "今日头条",
      // 标题 2~30 字是平台硬限制（下限在 `TOUTIAO_ARTICLE_LIMITS.titleMin`，这张表只放上限）；
      // description 在头条文章语境里是**正文文本**，上限用我们自己的正文守卫。
      titleMax: TOUTIAO_ARTICLE_LIMITS.titleMax,
      descriptionMax: TOUTIAO_ARTICLE_LIMITS.bodyChars,
      hashtagMax: 10,
      hashtagLengthMax: 20,
      creatorUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
    },
  });
});

// ─── 平台清单的「静默点」守卫 ────────────────────────────────────────────────

/**
 * `PublishPlatform` 是个联合类型，加一个成员时**编译器只能兜住 `Record<PublishPlatform, …>`**；
 * 散落在各处的 `new Set([...])` 字面量全都**静默** —— 漏一处的表现是「界面能看到平台、
 * 后端静默拒绝」，与「改了没生效」属于同一类事故（本项目吃过这个亏）。
 *
 * 与其逐个手写断言，不如断言**所有清单彼此一致**：这样将来再加平台时，漏掉的清单会自动被抓到。
 * `PUBLISH_PLATFORMS` 的键是被编译器强制的那个真源，因此以它为准。
 */
test("每一份平台清单都与 PUBLISH_PLATFORMS 的键集合完全一致（新增平台不许漏点）", () => {
  const expected = [...Object.keys(PUBLISH_PLATFORMS)].sort();
  assert.deepEqual(expected, [
    "bilibili",
    "douyin",
    "toutiao",
    "wechat_channels",
    "wechat_mp",
    "xiaohongshu",
  ]);

  const lists: Array<[string, Iterable<string>]> = [
    ["publishing-assets.APPROVED_PLATFORMS", APPROVED_PLATFORMS],
    ["publishing-routes.PLATFORMS", ROUTE_PLATFORMS],
    ["publishing-service.SUPPORTED_PLATFORMS", SUPPORTED_PLATFORMS],
  ];
  for (const [name, list] of lists) {
    assert.deepEqual([...list].sort(), expected, `${name} 与平台集合不一致`);
  }
});

test("存档校验 isPlatform 接受每一个在册平台（否则读回索引时任务会被静默丢掉）", () => {
  for (const platform of Object.keys(PUBLISH_PLATFORMS)) {
    assert.equal(isPlatform(platform), true, `isPlatform(${platform}) 应当为 true`);
  }
  assert.equal(isPlatform("weibo"), false);
});

test("NOTE_PLATFORMS 是严格子集且不含微信公众号（两条通路的闸门不能混用）", () => {
  // 图文（note）通路目前只接通抖音（上游只有 `sau douyin upload-note`）；
  // 公众号走 article 通路，**不得**被塞进这个闸门，否则会以「图文口径」去校验文章。
  assert.deepEqual([...NOTE_PLATFORMS], ["douyin"]);
  assert.equal(NOTE_PLATFORMS.has("wechat_mp"), false);
  for (const platform of NOTE_PLATFORMS) {
    assert.equal(platform in PUBLISH_PLATFORMS, true, `NOTE_PLATFORMS 含未知平台 ${platform}`);
  }
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

// ─── 微信公众号口径（title ≤32、摘要 ≤120）──────────────────────────────────

test("微信公众号的口径：标题 32 字、摘要（description）120 字", () => {
  const title32 = { title: "题".repeat(32), description: "摘".repeat(120), hashtags: [] };
  assert.deepEqual(validatePlatformCopy("wechat_mp", title32), []);

  const title33 = validatePlatformCopy("wechat_mp", { ...title32, title: "题".repeat(33) });
  assert.equal(title33.length, 1);
  assert.equal(title33[0].field, "title");
  assert.equal(title33[0].actual, 33);
  assert.equal(title33[0].limit, 32);
  assert.match(title33[0].message, /32/u);

  const digest121 = validatePlatformCopy("wechat_mp", { ...title32, description: "摘".repeat(121) });
  assert.equal(digest121.length, 1);
  assert.equal(digest121[0].field, "description");
  assert.equal(digest121[0].limit, 120);
});

test("微信公众号口径独立于抖音视频口径（同一篇标题在两处结论不同）", () => {
  const copy = { title: "一".repeat(40), description: "", hashtags: [] };
  assert.deepEqual(validatePlatformCopy("douyin", copy), [], "抖音视频标题 55 字上限内应通过");
  assert.equal(validatePlatformCopy("wechat_mp", copy).length, 1, "公众号 32 字上限应报错");
});

// ─── 今日头条（article 通路）的两条边界 ──────────────────────────────────────

test("头条不许走图文（note）口径：塞进那个闸门会拿抖音的 20/1000 去卡文章", () => {
  assert.throws(() => validateNoteCopy("toutiao", { title: "标题", description: "正文", hashtags: [] }));
  assert.equal(NOTE_PLATFORMS.has("toutiao"), false);
});

test("头条的标题下限在文章校验里管，平台表只管上限（两张表口径不重叠）", () => {
  // 平台表是「视频/人工交付文案」口径，只有上限；文章通路的 2 字下限由
  // `validateToutiaoArticle` 负责，两者不该互相复制数字。
  assert.equal(PUBLISH_PLATFORMS.toutiao.titleMax, 30);
  assert.equal(TOUTIAO_ARTICLE_LIMITS.titleMin, 2);
  assert.equal(PUBLISH_PLATFORMS.toutiao.titleMax, TOUTIAO_ARTICLE_LIMITS.titleMax);
});

// ─── 自动发布通路表（(内容类型 × 平台) → 引擎）────────────────────────────────

test("通路表：图文只走抖音（sau），文章只走头条（自研 runner）", () => {
  assert.deepEqual(
    AUTO_PUBLISH_ROUTES.map((route) => `${route.contentType}:${route.platform}=${route.engine}`).sort(),
    ["article:toutiao=toutiao", "note:douyin=sau"],
  );

  assert.equal(resolveAutoPublishEngine("note", "douyin"), "sau");
  assert.equal(resolveAutoPublishEngine("article", "toutiao"), "toutiao");

  // 未登记的组合一律 null：视频包仍是人工交付；图文不许发给头条（上游没有这条通路）；
  // 文章不许发给抖音（我们的文章渲染是头条/公众号口径，抖音图文走 note）。
  assert.equal(resolveAutoPublishEngine("video", "douyin"), null);
  assert.equal(resolveAutoPublishEngine("video", "toutiao"), null);
  assert.equal(resolveAutoPublishEngine("note", "toutiao"), null);
  assert.equal(resolveAutoPublishEngine("article", "douyin"), null);
  assert.equal(resolveAutoPublishEngine("article", "wechat_mp"), null, "公众号通路尚未接通");
});

test("通路表里的平台与内容类型都在册（不会指到不存在的枚举值）", () => {
  for (const route of AUTO_PUBLISH_ROUTES) {
    assert.equal(route.platform in PUBLISH_PLATFORMS, true, `未知平台 ${route.platform}`);
    assert.equal(["video", "note", "article"].includes(route.contentType), true);
  }
});
