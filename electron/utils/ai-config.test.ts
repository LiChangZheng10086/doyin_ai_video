import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyHttpFailure,
  classifyNetworkFailure,
  mergeAiKeyChanges,
  normalizeBaseURL,
  normalizeMaxOutputTokens
} from "./ai-config";

test("normalizeBaseURL removes trailing slashes without adding v1", () => {
  assert.equal(normalizeBaseURL("https://gateway.example/v1///"), "https://gateway.example/v1");
  assert.equal(normalizeBaseURL("https://gateway.example"), "https://gateway.example");
});

test("mergeAiKeyChanges preserves the existing secret when the edit leaves it blank", () => {
  const existing = { name: "GPT-5.2", provider: "custom" as const, apiKey: "sk-existing", baseURL: "https://old.example", model: "GPT-5.2" };
  const merged = mergeAiKeyChanges(
    existing,
    { name: "GPT-5.2", provider: "custom", apiKey: "", baseURL: "https://new.example/", model: "GPT-5.2" }
  );

  assert.equal(merged.apiKey, "sk-existing");
  assert.equal(merged.baseURL, "https://new.example");
  assert.equal(existing.baseURL, "https://old.example");
});

test("normalizeMaxOutputTokens keeps valid custom values", () => {
  assert.equal(normalizeMaxOutputTokens(8192), 8192);
});

test("normalizeMaxOutputTokens treats an empty value as automatic", () => {
  assert.equal(normalizeMaxOutputTokens(undefined), undefined);
});

test("normalizeMaxOutputTokens rejects invalid custom values", () => {
  assert.throws(() => normalizeMaxOutputTokens(255), /至少为 256/);
  assert.throws(() => normalizeMaxOutputTokens(1024.5), /整数/);
});

test("mergeAiKeyChanges clears a previous custom limit", () => {
  const merged = mergeAiKeyChanges({
    name: "DeepSeek",
    provider: "deepseek",
    apiKey: "secret",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    maxOutputTokens: 8192
  }, {
    name: "DeepSeek",
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    maxOutputTokens: null
  });
  assert.equal(merged.maxOutputTokens, undefined);
});

test("classifyNetworkFailure identifies DNS, TLS and timeout errors", () => {
  assert.equal(classifyNetworkFailure({ message: "fetch failed", cause: { code: "ENOTFOUND" } }), "dns");
  assert.equal(classifyNetworkFailure(new Error("certificate verify failed")), "tls");
  assert.equal(classifyNetworkFailure(new Error("request timed out")), "timeout");
});

test("classifyHttpFailure maps common gateway responses", () => {
  assert.equal(classifyHttpFailure(401, "invalid key"), "auth");
  assert.equal(classifyHttpFailure(404, "not found"), "endpoint");
  assert.equal(classifyHttpFailure(400, "model does not exist"), "model");
  assert.equal(classifyHttpFailure(429, "rate limit"), "quota");
  assert.equal(classifyHttpFailure(502, "bad gateway"), "upstream");
});
