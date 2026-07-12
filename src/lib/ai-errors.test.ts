import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseAiError } from "./ai-errors.js";

const context = { baseURL: "https://bigexiong.cloud", model: "GPT-5.2" };

test("diagnoseAiError reports an unresolvable API hostname", async () => {
  const result = await diagnoseAiError(
    new Error("Connection error."),
    context,
    async () => false
  );

  assert.equal(result.code, "dns");
  assert.match(result.message, /无法解析 API 域名 bigexiong\.cloud/);
  assert.doesNotMatch(result.message, /sk-/);
});

test("diagnoseAiError classifies HTTP failures", async () => {
  const cases = [
    [401, "invalid api key", "auth"],
    [404, "route not found", "endpoint"],
    [400, "model GPT-5.2 does not exist", "model"],
    [429, "quota exceeded", "quota"],
    [503, "service unavailable", "upstream"]
  ] as const;

  for (const [status, message, code] of cases) {
    const result = await diagnoseAiError({ status, message }, context, async () => true);
    assert.equal(result.code, code);
  }
});

test("diagnoseAiError classifies timeout and TLS failures", async () => {
  const timeout = await diagnoseAiError(new Error("Request timed out"), context, async () => true);
  const tls = await diagnoseAiError(new Error("certificate verify failed"), context, async () => true);

  assert.equal(timeout.code, "timeout");
  assert.equal(tls.code, "tls");
});
