import assert from "node:assert/strict";
import { test } from "node:test";
import { isYouTubeUrl, parseYouTubeJson3, selectYouTubeCaption } from "./youtube.js";

test("YouTube detection accepts public video hosts and rejects lookalikes", () => {
  for (const url of ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "https://m.youtube.com/shorts/abc"]) assert.equal(isYouTubeUrl(url), true);
  for (const url of ["https://youtube.com.evil.test/watch?v=abc", "https://evil.test/?youtube.com", "file://youtube.com/watch?v=abc", "bad"]) assert.equal(isYouTubeUrl(url), false);
});

test("caption selection prefers authored source language before automatic and excludes translations", () => {
  const json3 = [{ ext: "json3", url: "https://www.youtube.com/api/timedtext?lang=en" }];
  const translated = [{ ext: "json3", url: "https://www.youtube.com/api/timedtext?lang=en&tlang=zh" }];
  assert.deepEqual(selectYouTubeCaption({ language: "en", subtitles: { fr: json3, en: json3 }, automatic_captions: { "en-orig": json3 } }), { language: "en", automatic: false });
  assert.deepEqual(selectYouTubeCaption({ language: "en", subtitles: {}, automatic_captions: { zh: translated, en: json3, "en-orig": json3 } }), { language: "en-orig", automatic: true });
  assert.equal(selectYouTubeCaption({ automatic_captions: { zh: translated } }), null);
});

test("JSON3 removes overlapping rolling text while preserving later spoken repetitions", () => {
  const result = parseYouTubeJson3({ events: [
    { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: "Hello world" }] },
    { tStartMs: 2000, dDurationMs: 4000, segs: [{ utf8: "Hello world\nNew words" }] },
    { tStartMs: 6500, dDurationMs: 2000, segs: [{ utf8: "Hello world" }] }
  ] }, 9);
  assert.deepEqual(result, [
    { start: 0, end: 2, text: "Hello world" },
    { start: 2, end: 6, text: "New words" },
    { start: 6.5, end: 8.5, text: "Hello world" }
  ]);
});

test("JSON3 rejects invalid or missing timings instead of silently dropping subtitle text", () => {
  for (const event of [{ tStartMs: -1, dDurationMs: 20 }, { tStartMs: 0, dDurationMs: 0 }, { tStartMs: 0, dDurationMs: 20000 }, { tStartMs: 0 }]) {
    assert.throws(() => parseYouTubeJson3({ events: [{ ...event, segs: [{ utf8: "Text" }] }] }, 10), /字幕/);
  }
});

test("JSON3 rejects coercible timing and nonstring caption payloads", () => {
  for (const event of [
    { tStartMs: null, dDurationMs: 1000, segs: [{ utf8: "Text" }] },
    { tStartMs: "0", dDurationMs: 1000, segs: [{ utf8: "Text" }] },
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 42 }] }
  ]) assert.throws(() => parseYouTubeJson3({ events: [event] }, 10), /字幕/);
});

test("Chinese JSON3 selects the Chinese block from two exactly aligned language tracks", () => {
  const chinese = [
    { tStartMs: 200, dDurationMs: 1000, segs: [{ utf8: "hello大家好" }] },
    { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: "Thank you" }] }
  ];
  const english = [
    { tStartMs: 200, dDurationMs: 1000, segs: [{ utf8: "Hello everyone" }] },
    { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: "Thank you" }] }
  ];
  for (const events of [[...chinese, ...english], [...english, ...chinese]]) {
    assert.deepEqual(parseYouTubeJson3({ events }, 3, "zh-Hant"), [
      { start: 0.2, end: 1.2, text: "hello大家好" },
      { start: 1.5, end: 2.5, text: "Thank you" }
    ]);
    assert.throws(() => parseYouTubeJson3({ events }, 3, "en"), /倒序/);
    assert.throws(() => parseYouTubeJson3({ events }, 3), /倒序/);
  }
  assert.throws(() => parseYouTubeJson3({ events: [...chinese, english[0], { ...english[1], tStartMs: 1600 }] }, 3, "zh"), /倒序/);
  assert.throws(() => parseYouTubeJson3({ events: [...chinese, ...chinese] }, 3, "zh"), /倒序/);
  assert.throws(() => parseYouTubeJson3({ events: [...chinese, english[0], { ...english[1], dDurationMs: -1 }] }, 3, "zh"), /字幕/);
});

test("Chinese track selection preserves English phrases and tolerates Chinese names in the English translation", () => {
  const chinese = ["这是我的故事", "知行合一", "Thank you", "再见"];
  const english = ["This is my story", "The path of知行合一", "Thank you", "Goodbye"];
  const block = (texts: string[]) => texts.map((text, index) => ({ tStartMs: index * 1000, dDurationMs: 900, segs: [{ utf8: text }] }));
  assert.deepEqual(parseYouTubeJson3({ events: [...block(chinese), ...block(english)] }, 4, "zh").map(cue => cue.text), chinese);
});
