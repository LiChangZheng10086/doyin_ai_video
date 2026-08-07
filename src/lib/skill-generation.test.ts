import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSkillContext,
  getSkillErrorMessage,
  isRetryableSkillError,
} from "./skill-generation.js";

test("buildSkillContext keeps every video represented within the request budget", () => {
  const transcripts = Array.from({ length: 6 }, (_, index) => ({
    desc: `视频 ${index + 1}`,
    transcript: `视频 ${index + 1} 的核心内容。`.repeat(80),
  }));

  const context = buildSkillContext(transcripts, 720);

  assert.ok(context.length <= 720);
  for (const transcript of transcripts) {
    assert.match(context, new RegExp(`【${transcript.desc}】`));
  }
});

test("520 and gateway failures are retryable while client errors are not", () => {
  assert.equal(isRetryableSkillError({ status: 520, message: "Web server returned an unknown error" }), true);
  assert.equal(isRetryableSkillError({ status: 503, message: "upstream unavailable" }), true);
  assert.equal(isRetryableSkillError({ status: 400, message: "invalid request" }), false);
});

test("skill errors preserve the provider status in the user-facing message", () => {
  assert.match(
    getSkillErrorMessage({ status: 520, message: "Web server returned an unknown error" }),
    /520/
  );
});
