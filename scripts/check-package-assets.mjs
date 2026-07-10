#!/usr/bin/env node
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const assetsDir = path.join(rootDir, "vendor", "package-assets");
const manifestPath = path.join(assetsDir, "manifest.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const required = [
  manifest.assets?.ffmpeg,
  manifest.assets?.ffprobe,
  manifest.assets?.ytdlp,
  manifest.assets?.whisperCli,
  manifest.assets?.whisperModel,
  manifest.assets?.hyperframesCli,
  manifest.assets?.hyperframesBrowser
].filter(Boolean);

if (manifest.platform === "win32") {
  required.push("whisper/whisper.dll", "whisper/ggml.dll", "whisper/ggml-base.dll");
}

const missing = [];
const empty = [];
for (const relativePath of required) {
  const filePath = path.join(assetsDir, relativePath);
  try {
    await access(filePath);
    const info = await stat(filePath);
    if (info.size <= 0) {
      empty.push(filePath);
    }
  } catch {
    missing.push(filePath);
  }
}

if (missing.length || empty.length) {
  if (missing.length) {
    console.error("Missing packaged runtime assets:");
    for (const filePath of missing) {
      console.error(`  - ${filePath}`);
    }
  }
  if (empty.length) {
    console.error("Empty packaged runtime assets:");
    for (const filePath of empty) {
      console.error(`  - ${filePath}`);
    }
  }
  console.error("Run `npm run prepare:package:mac` or `npm run prepare:package:win` before packaging.");
  process.exit(1);
}

console.log(`Packaged runtime assets are ready for ${manifest.runtimeId}.`);
