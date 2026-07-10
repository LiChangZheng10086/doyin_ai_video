#!/usr/bin/env node
import { createWriteStream, existsSync } from "node:fs";
import { access, chmod, cp, mkdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const whisperDir = path.join(rootDir, "vendor", "whisper");
const cacheDir = path.join(whisperDir, ".cache");
const modelPath = path.join(whisperDir, "models", "ggml-small.bin");
const cliPath = path.join(whisperDir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
const whisperRef = process.env.WHISPER_CPP_REF || "v1.9.1";
const modelUrl =
  process.env.WHISPER_MODEL_URL ||
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

await mkdir(path.dirname(modelPath), { recursive: true });
await mkdir(cacheDir, { recursive: true });

await ensureModel();
await ensureCli();

console.log(`Whisper assets ready:
  cli:   ${cliPath}
  model: ${modelPath}`);

async function ensureModel() {
  if (await exists(modelPath)) {
    return;
  }
  console.log(`Downloading ggml-small model from ${modelUrl}`);
  await download(modelUrl, modelPath);
}

async function ensureCli() {
  if (await exists(cliPath)) {
    await chmod(cliPath, 0o755).catch(() => undefined);
    return;
  }

  if (process.env.WHISPER_CLI_SOURCE) {
    await cp(process.env.WHISPER_CLI_SOURCE, cliPath);
    await chmod(cliPath, 0o755).catch(() => undefined);
    return;
  }

  const archivePath = path.join(cacheDir, `${whisperRef}.tar.gz`);
  const sourceDir = path.join(cacheDir, `whisper.cpp-${whisperRef.replace(/^v/, "")}`);
  const buildDir = path.join(cacheDir, "build");

  if (!existsSync(sourceDir)) {
    await download(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${whisperRef}.tar.gz`, archivePath);
    await run("tar", ["-xzf", archivePath, "-C", cacheDir]);
  }

  await run("cmake", [
    "-S",
    sourceDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON"
  ]);
  await run("cmake", ["--build", buildDir, "--config", "Release", "--target", "whisper-cli"]);

  const builtCli = [
    path.join(buildDir, "bin", path.basename(cliPath)),
    path.join(buildDir, "bin", "Release", path.basename(cliPath)),
    path.join(buildDir, "examples", "cli", path.basename(cliPath)),
    path.join(buildDir, "examples", "cli", "Release", path.basename(cliPath))
  ].find((candidate) => existsSync(candidate));

  if (!builtCli) {
    throw new Error(`Could not find built whisper-cli under ${buildDir}`);
  }

  await cp(builtCli, cliPath);
  await chmod(cliPath, 0o755).catch(() => undefined);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function download(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const tempPath = path.join(tmpdir(), `${path.basename(targetPath)}.${process.pid}.tmp`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await rename(tempPath, targetPath).catch(async () => {
    await cp(tempPath, targetPath);
    await rm(tempPath, { force: true });
  });
}

async function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code}`));
    });
  });
}
