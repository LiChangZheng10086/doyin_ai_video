#!/usr/bin/env node
import { existsSync } from "node:fs";
import { access, chmod, cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const vendorDir = path.join(rootDir, "vendor");
const runtimeDir = path.join(vendorDir, "runtime");
const packageAssetsDir = path.join(vendorDir, "package-assets");
const cacheDir = path.join(runtimeDir, ".cache");
const devWhisperDir = path.join(vendorDir, "whisper");
const modelUrl = process.env.WHISPER_MODEL_URL || "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
const hyperframesVersion = process.env.HYPERFRAMES_VERSION || "0.7.48";
const chromeHeadlessShellVersion = process.env.HYPERFRAMES_CHROME_VERSION || "152.0.7928.2";

const targets = {
  mac: {
    id: process.arch === "x64" ? "darwin-x64" : "darwin-arm64",
    platform: "darwin",
    arch: process.arch === "x64" ? "x64" : "arm64",
    bin: {
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      ytdlp: "yt-dlp"
    },
    browserPlatform: process.arch === "x64" ? "mac" : "mac_arm",
    ffmpegPackage: process.arch === "x64" ? "@ffmpeg-installer/darwin-x64@4.1.0" : "@ffmpeg-installer/darwin-arm64@4.1.5",
    ffprobePackage: process.arch === "x64" ? "@ffprobe-installer/darwin-x64@5.1.0" : "@ffprobe-installer/darwin-arm64@5.0.1",
    ytdlpUrl: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
  },
  win: {
    id: "win32-x64",
    platform: "win32",
    arch: "x64",
    bin: {
      ffmpeg: "ffmpeg.exe",
      ffprobe: "ffprobe.exe",
      ytdlp: "yt-dlp.exe"
    },
    browserPlatform: "win64",
    ffmpegPackage: "@ffmpeg-installer/win32-x64@4.1.0",
    ffprobePackage: "@ffprobe-installer/win32-x64@5.1.0",
    ytdlpUrl: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    whisperZipUrl: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip"
  }
};

const targetName = parseTarget();
const target = targets[targetName];
if (!target) {
  console.error(`Unknown package target: ${targetName}`);
  console.error(`Supported targets: ${Object.keys(targets).join(", ")}`);
  process.exit(1);
}

await mkdir(cacheDir, { recursive: true });

const targetDir = path.join(runtimeDir, target.id);
const binDir = path.join(targetDir, "bin");
const whisperDir = path.join(targetDir, "whisper");
const hyperframesDir = path.join(targetDir, "hyperframes");
const browserDir = path.join(targetDir, "browser");

await mkdir(binDir, { recursive: true });
await mkdir(path.join(whisperDir, "models"), { recursive: true });

await ensureFfmpeg();
await ensureFfprobe();
await ensureYtDlp();
await ensureWhisper();
await ensureHyperframes();
const browserExecutable = await ensureChromeHeadlessShell();
await stagePackageAssets();

console.log(`Package assets ready for ${target.id}: ${packageAssetsDir}`);

function parseTarget() {
  const fromArg = process.argv.find((arg) => arg.startsWith("--target="))?.split("=")[1];
  return fromArg || process.env.PACKAGE_TARGET || "mac";
}

async function ensureFfmpeg() {
  await ensureNpmBinary(target.ffmpegPackage, target.bin.ffmpeg, path.join(binDir, target.bin.ffmpeg));
}

async function ensureFfprobe() {
  await ensureNpmBinary(target.ffprobePackage, target.bin.ffprobe, path.join(binDir, target.bin.ffprobe));
}

async function ensureYtDlp() {
  const output = path.join(binDir, target.bin.ytdlp);
  if (await exists(output)) {
    await makeExecutable(output);
    return;
  }
  await download(target.ytdlpUrl, output);
  await makeExecutable(output);
}

async function ensureWhisper() {
  const modelPath = path.join(whisperDir, "models", "ggml-small.bin");
  await ensureModel(modelPath);

  if (target.platform === "win32") {
    await ensureWindowsWhisper();
    return;
  }

  const sourceCli = path.join(devWhisperDir, "whisper-cli");
  if (!(await exists(sourceCli))) {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "prepare:whisper"], { cwd: rootDir });
  }
  await cp(sourceCli, path.join(whisperDir, "whisper-cli"));
  await makeExecutable(path.join(whisperDir, "whisper-cli"));
}

async function ensureHyperframes() {
  const cliPath = path.join(hyperframesDir, "node_modules", "hyperframes", "dist", "cli.js");
  if (await exists(cliPath)) {
    return;
  }
  const installArgs = [
    "install",
    "--prefix",
    hyperframesDir,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    `--os=${target.platform}`,
    `--cpu=${target.arch}`,
    `hyperframes@${hyperframesVersion}`
  ];
  if (target.platform !== process.platform || target.arch !== process.arch) {
    installArgs.splice(-1, 0, "--ignore-scripts");
  }
  await rm(hyperframesDir, { recursive: true, force: true });
  await mkdir(hyperframesDir, { recursive: true });
  await run(process.platform === "win32" ? "npm.cmd" : "npm", installArgs, { cwd: rootDir });
}

async function ensureChromeHeadlessShell() {
  const existing = await findChromeHeadlessShell(browserDir);
  if (existing) {
    await makeExecutable(existing);
    return existing;
  }

  const cached = await findCachedChromeHeadlessShell();
  if (cached) {
    await rm(browserDir, { recursive: true, force: true });
    await mkdir(path.dirname(browserDir), { recursive: true });
    await cp(cached.cacheRoot, browserDir, { recursive: true });
    const copied = await findChromeHeadlessShell(browserDir);
    if (copied) {
      await makeExecutable(copied);
      return copied;
    }
  }

  await mkdir(browserDir, { recursive: true });
  await run(process.platform === "win32" ? "npx.cmd" : "npx", [
    "--yes",
    "@puppeteer/browsers",
    "install",
    `chrome-headless-shell@${chromeHeadlessShellVersion}`,
    "--platform",
    target.browserPlatform,
    "--path",
    browserDir,
    "--format",
    "{{path}}"
  ], { cwd: rootDir });

  const installed = await findChromeHeadlessShell(browserDir);
  if (!installed) {
    throw new Error(`Could not find chrome-headless-shell under ${browserDir}`);
  }
  await makeExecutable(installed);
  return installed;
}

async function ensureWindowsWhisper() {
  const cliPath = path.join(whisperDir, "whisper-cli.exe");
  const dlls = ["whisper.dll", "ggml.dll", "ggml-base.dll"];
  const complete = (await exists(cliPath)) && (await Promise.all(dlls.map((dll) => exists(path.join(whisperDir, dll))))).every(Boolean);
  if (complete) {
    return;
  }

  const zipPath = path.join(cacheDir, "whisper-bin-x64-v1.9.1.zip");
  if (!(await exists(zipPath))) {
    await download(target.whisperZipUrl, zipPath);
  }

  const tempDir = path.join(tmpdir(), `douyin-whisper-win-${process.pid}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await run("unzip", ["-q", zipPath, "-d", tempDir], { cwd: rootDir });

  const releaseDir = path.join(tempDir, "Release");
  await cp(path.join(releaseDir, "whisper-cli.exe"), cliPath);
  for (const file of await readdir(releaseDir)) {
    if (file.toLowerCase().endsWith(".dll")) {
      await cp(path.join(releaseDir, file), path.join(whisperDir, file));
    }
  }
  await rm(tempDir, { recursive: true, force: true });
}

async function ensureModel(modelPath) {
  if (await exists(modelPath)) {
    return;
  }
  const devModel = path.join(devWhisperDir, "models", "ggml-small.bin");
  if (await exists(devModel)) {
    await cp(devModel, modelPath);
    return;
  }
  await download(modelUrl, modelPath);
}

async function ensureNpmBinary(packageSpec, binaryName, outputPath) {
  if (await exists(outputPath)) {
    await makeExecutable(outputPath);
    return;
  }
  const packageName = packageSpec.replaceAll("/", "-").replaceAll("@", "").replaceAll(":", "-");
  const packDir = path.join(cacheDir, "npm");
  await mkdir(packDir, { recursive: true });
  const result = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", packageSpec, "--pack-destination", packDir], {
    cwd: rootDir,
    captureStdout: true
  });
  const tarballName = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const tarball = tarballName ? path.join(packDir, tarballName) : "";
  if (!tarball || !(await exists(tarball))) {
    throw new Error(`npm pack did not produce a tarball for ${packageSpec}`);
  }

  const tempDir = path.join(tmpdir(), `${packageName}-${process.pid}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", tempDir], { cwd: rootDir });
  await cp(path.join(tempDir, "package", binaryName), outputPath);
  await rm(tempDir, { recursive: true, force: true });
  await makeExecutable(outputPath);
}

async function stagePackageAssets() {
  await rm(packageAssetsDir, { recursive: true, force: true });
  await mkdir(packageAssetsDir, { recursive: true });
  await cp(binDir, path.join(packageAssetsDir, "bin"), { recursive: true });
  await cp(whisperDir, path.join(packageAssetsDir, "whisper"), { recursive: true });
  await cp(hyperframesDir, path.join(packageAssetsDir, "hyperframes"), { recursive: true });
  await cp(browserDir, path.join(packageAssetsDir, "browser"), { recursive: true });

  const browserRelativePath = path.relative(browserDir, browserExecutable).split(path.sep).join("/");
  await writeFile(path.join(packageAssetsDir, "manifest.json"), JSON.stringify({
    target: targetName,
    platform: target.platform,
    arch: target.arch,
    runtimeId: target.id,
    createdAt: new Date().toISOString(),
    assets: {
      ffmpeg: `bin/${target.bin.ffmpeg}`,
      ffprobe: `bin/${target.bin.ffprobe}`,
      ytdlp: `bin/${target.bin.ytdlp}`,
      whisperCli: target.platform === "win32" ? "whisper/whisper-cli.exe" : "whisper/whisper-cli",
      whisperModel: "whisper/models/ggml-small.bin",
      hyperframesCli: "hyperframes/node_modules/hyperframes/dist/cli.js",
      hyperframesBrowser: `browser/${browserRelativePath}`
    }
  }, null, 2));
}

async function findChromeHeadlessShell(root) {
  const binaryName = target.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  return await findFile(root, binaryName);
}

async function findCachedChromeHeadlessShell() {
  const roots = [
    path.join(homedir(), ".cache", "hyperframes", "chrome"),
    path.join(homedir(), ".cache", "puppeteer", "chrome-headless-shell")
  ];
  for (const cacheRoot of roots) {
    const executable = await findChromeHeadlessShell(cacheRoot);
    if (!executable) {
      continue;
    }
    const normalized = executable.split(path.sep).join("/");
    if (target.platform === "win32" && !normalized.includes("win64")) {
      continue;
    }
    if (target.platform === "darwin" && target.arch === "arm64" && !normalized.includes("mac-arm64") && !normalized.includes("mac_arm")) {
      continue;
    }
    if (target.platform === "darwin" && target.arch === "x64" && !normalized.includes("mac-x64") && !normalized.includes("/mac-")) {
      continue;
    }
    console.log(`Using cached Chrome headless shell from ${cacheRoot}`);
    return { cacheRoot, executable };
  }
  return undefined;
}

async function findFile(root, fileName) {
  if (!(await exists(root))) {
    return undefined;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, fileName);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

async function download(url, targetPath) {
  console.log(`Downloading ${url}`);
  const tempPath = path.join(tmpdir(), `${path.basename(targetPath)}.${process.pid}.tmp`);
  await rm(tempPath, { force: true });
  await run("curl", [
    "-L",
    "--fail",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    "--connect-timeout",
    "30",
    "--max-time",
    "900",
    "-o",
    tempPath,
    url
  ]);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await rename(tempPath, targetPath).catch(async () => {
    await cp(tempPath, targetPath);
    await rm(tempPath, { force: true });
  });
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function makeExecutable(filePath) {
  if (target.platform !== "win32") {
    await chmod(filePath, 0o755).catch(() => undefined);
  }
}

async function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDir,
      stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit"
    });
    let stdout = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      reject(new Error(`${command} exited with ${code}`));
    });
  });
}
