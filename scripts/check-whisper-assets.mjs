#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const whisperDir = path.join(rootDir, "vendor", "whisper");
const cliPath = path.join(whisperDir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
const modelPath = path.join(whisperDir, "models", "ggml-small.bin");

const missing = [];
await access(cliPath).catch(() => missing.push(cliPath));
await access(modelPath).catch(() => missing.push(modelPath));

if (missing.length) {
  console.error("Bundled Whisper assets are missing:");
  for (const filePath of missing) {
    console.error(`  - ${filePath}`);
  }
  console.error("Run `npm run prepare:whisper` before packaging.");
  process.exit(1);
}
