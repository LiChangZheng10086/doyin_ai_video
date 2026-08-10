import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalStorage } from "./storage.js";

test("writeJsonAtomic replaces a JSON document", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atomic-json-"));
  const storage = new LocalStorage(root);
  await storage.writeJson("cache/value.json", { version: 1 });

  await storage.writeJsonAtomic("cache/value.json", { version: 2 });

  assert.deepEqual(await storage.readJson("cache/value.json"), { version: 2 });
  assert.deepEqual((await readdir(path.join(root, "cache"))).sort(), ["value.json"]);
});

test("writeJsonAtomic keeps the previous file when rename fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atomic-json-fail-"));
  const storage = new LocalStorage(root, {
    rename: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
  });
  await storage.writeJson("cache/value.json", { version: 1 });

  await assert.rejects(() => storage.writeJsonAtomic("cache/value.json", { version: 2 }), /disk full/);
  assert.deepEqual(await storage.readJson("cache/value.json"), { version: 1 });
});
