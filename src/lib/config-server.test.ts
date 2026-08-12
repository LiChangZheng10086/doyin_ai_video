import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMaxOutputTokens, resolveUpdatedMaxOutputTokens } from "./config-server.js";

test("normalizeMaxOutputTokens accepts automatic and custom modes", () => {
  assert.equal(normalizeMaxOutputTokens(undefined), undefined);
  assert.equal(normalizeMaxOutputTokens(16384), 16384);
});

test("normalizeMaxOutputTokens rejects invalid HTTP configuration", () => {
  assert.throws(() => normalizeMaxOutputTokens(0), /至少为 256/);
  assert.throws(() => normalizeMaxOutputTokens(512.25), /整数/);
});

test("resolveUpdatedMaxOutputTokens distinguishes omitted and cleared values", () => {
  assert.equal(resolveUpdatedMaxOutputTokens(8192, {}), 8192);
  assert.equal(resolveUpdatedMaxOutputTokens(8192, { maxOutputTokens: null }), undefined);
  assert.equal(resolveUpdatedMaxOutputTokens(undefined, { maxOutputTokens: 16384 }), 16384);
});
