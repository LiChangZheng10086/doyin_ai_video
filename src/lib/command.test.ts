import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCommand } from "./command.js";

test("runCommand terminates a command after its timeout", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    runCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 500)"],
      { timeoutMs: 40, captureStderr: true }
    ),
    /timed out after 40ms/i
  );

  assert.ok(Date.now() - startedAt < 400);
});

test("runCommand timeout terminates spawned descendants", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "command-tree-"));
  const marker = path.join(dir, "child-survived.txt");
  const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 180)`;
  const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`;

  await assert.rejects(runCommand(process.execPath, ["-e", parentCode], { timeoutMs: 40 }), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 260));

  assert.equal(await stat(marker).catch(() => null), null);
});

test("runCommand abort terminates the active process", async () => {
  const controller = new AbortController();
  const running = runCommand(
    process.execPath,
    ["-e", "setTimeout(() => process.exit(0), 500)"],
    { signal: controller.signal, captureStderr: true }
  );
  setTimeout(() => controller.abort(), 40).unref();

  await assert.rejects(running, /aborted/i);
});
