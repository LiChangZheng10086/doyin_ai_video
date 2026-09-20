/**
 * 微信公众号账号自检探针（**零副作用**）。
 *
 * 这是「个人订阅号能否调用草稿箱接口」这个唯一未知数的判据（见 spec §1.4）：
 * 它只换取一次 access_token 并调 `draft/count`（最便宜、不产生任何内容的草稿箱接口），
 * **不建草稿、不上传素材、不发布任何东西**。
 *
 * 用法（在仓库根目录）：
 *
 * ```bash
 * WECHAT_MP_APP_ID=wx... WECHAT_MP_APP_SECRET=... \
 *   node --import tsx scripts/verify-wechat-mp.ts
 * ```
 *
 * 也可以把两个变量写进仓库根的 `.env`（与独立后端同一套约定），直接跑：
 *
 * ```bash
 * node --import tsx scripts/verify-wechat-mp.ts
 * ```
 *
 * 退出码：三项全通过为 0，否则为 1。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { WechatMpClient, type WechatVerifyItem } from "../src/lib/wechat-mp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");
if (existsSync(envPath)) {
  try {
    loadEnvFile(envPath);
  } catch {
    // `.env` 格式问题不该让探针直接崩掉：下面会给出「未配置」的明确提示。
  }
}

/** 只显示前后各 4 位；AppSecret 一律不打印。 */
function maskAppId(appId: string | undefined): string {
  if (!appId) return "（未设置）";
  if (appId.length <= 8) return "****";
  return `${appId.slice(0, 4)}****${appId.slice(-4)}`;
}

function line(label: string, item: WechatVerifyItem): string {
  const mark = item.ok ? "✅" : "❌";
  const ip = item.ip ? `（IP ${item.ip}）` : "";
  return `${mark} ${label}${ip}\n     ${item.message}`;
}

async function main(): Promise<number> {
  const appId = process.env.WECHAT_MP_APP_ID;
  const appSecret = process.env.WECHAT_MP_APP_SECRET;

  console.log("微信公众号账号自检（不会创建草稿、不会上传任何内容）");
  console.log(`AppID: ${maskAppId(appId)}`);
  console.log(`接口地址: ${process.env.WECHAT_MP_BASE_URL ?? "https://api.weixin.qq.com"}`);
  console.log("");

  const client = new WechatMpClient({
    appId,
    appSecret,
    baseUrl: process.env.WECHAT_MP_BASE_URL,
    // 探针不落盘缓存：它的结论要反映「此刻」的真实状态，而不是几分钟前的缓存。
  });

  let report;
  try {
    report = await client.verifyAccount();
  } catch (error) {
    // 未配置凭据走这条路：给出可执行的配置指引，并以非零退出码结束。
    console.log(`❌ 无法自检：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(line("凭据（换取 access_token）", report.credentials));
  console.log(line("IP 白名单", report.ipWhitelist));
  console.log(line("草稿箱接口权限（draft/count）", report.draftPermission));
  console.log("");

  if (report.ok) {
    console.log("结论：三项全部通过 —— 微信公众号通路可用，可以建草稿。");
    return 0;
  }

  if (!report.draftPermission.ok && report.credentials.ok) {
    console.log(
      "结论：凭据有效，但**草稿箱接口不可用**。这不影响本功能的其余部分 ——\n" +
        "      文章生成与微信兼容 HTML 仍然可用，可走「下载文章 HTML」粘贴到公众号编辑器。",
    );
    return 1;
  }

  console.log("结论：自检未通过。请按上面的提示处理后重跑本脚本。");
  return 1;
}

process.exitCode = await main();
