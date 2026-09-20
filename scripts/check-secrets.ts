/**
 * 提交前的凭据扫描（CLI）：扫**被 git 跟踪 + 未忽略的新文件**，命中就非零退出。
 *
 * 为什么要有它：2026-09-20 一条 `wx` 开头 + 16 位十六进制的**占位值**触发了 GitHub
 * secret scanning 的误报。判断逻辑与理由都在 `src/lib/secret-scan.ts`（有用例覆盖），
 * 这里只负责「找文件、读文件、打印、决定退出码」。
 *
 * 用法：
 *   npm run check:secrets                 # 全仓（默认）
 *   node --import tsx scripts/check-secrets.ts <路径…>   # 只扫指定文件/目录
 */
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { REMEDIATION, formatFinding, scanText, type SecretFinding } from "../src/lib/secret-scan.js";

/** 二进制/大文件不值得扫，也扫不动（图片 base64、字体等）。 */
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".icns", ".pdf",
  ".mp4", ".mov", ".mp3", ".wav", ".m4a", ".aac", ".woff", ".woff2", ".ttf", ".zip", ".gz",
]);
/** 单个文件超过这个大小就跳过（正常源码不会有这么大）。 */
const MAX_BYTES = 2 * 1024 * 1024;

/** 优先用 git 的文件清单：它天然排除了 node_modules / dist / storage 等忽略项。 */
function trackedFiles(root: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    // 不是 git 仓库（例如解包后的产物）：退回扫常见源码目录。
    return [];
  }
}

/** 非 git 环境（或显式指定路径）时，按目录遍历。 */
async function walk(target: string, collected: string[]): Promise<void> {
  const info = await stat(target).catch(() => null);
  if (!info) return;
  if (info.isFile()) {
    collected.push(target);
    return;
  }
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(target, { withFileTypes: true }));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
    await walk(path.join(target, entry.name), collected);
  }
}

async function resolveTargets(root: string, argv: string[]): Promise<string[]> {
  if (argv.length > 0) {
    const collected: string[] = [];
    for (const item of argv) await walk(path.resolve(root, item), collected);
    return collected;
  }
  const fromGit = trackedFiles(root);
  if (fromGit.length > 0) return fromGit.map((file) => path.resolve(root, file));
  const collected: string[] = [];
  for (const dir of ["src", "renderer/src", "electron", "scripts", "docs"]) {
    await walk(path.resolve(root, dir), collected);
  }
  return collected;
}

async function scanFile(file: string): Promise<SecretFinding[]> {
  if (SKIP_EXTENSIONS.has(path.extname(file).toLowerCase())) return [];
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile() || info.size > MAX_BYTES) return [];
  const text = await readFile(file, "utf8").catch(() => "");
  return scanText(text, file);
}

const root = path.resolve(import.meta.dirname, "..");
const files = await resolveTargets(root, process.argv.slice(2));
const findings: SecretFinding[] = [];
for (const file of files) findings.push(...(await scanFile(file)));

if (findings.length === 0) {
  console.log(`凭据扫描通过：${files.length} 个文件，无「像真凭据」的串。`);
  process.exit(0);
}

console.error(`凭据扫描失败：${findings.length} 处命中（${files.length} 个文件）\n`);
for (const finding of findings) console.error(`  ${formatFinding(finding)}`);
console.error(`\n${REMEDIATION}`);
process.exit(1);
