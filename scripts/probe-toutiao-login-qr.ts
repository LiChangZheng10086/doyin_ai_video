/**
 * 今日头条**登录页取二维码**的只读诊断（零副作用）。
 *
 * 背景：应用内点「扫码登录」返回 422 `toutiao_qr_unavailable`
 * （文案是「没能从头条登录页取到二维码（页面结构可能已改版）」），
 * 而 `readQrDataUrl()` 的判据是：
 *
 *   `<img>` 的 `currentSrc || src` 以 `data:image/png` 开头，且 `naturalWidth >= 200`
 *
 * 本脚本**完全复刻产品的取码路径**（同一个 `openToutiaoSession`、同一个 `TOUTIAO_LOGIN_URL`、
 * 同一个 `readQrDataUrl`），然后把登录页的真实形状摊出来，回答一个问题：
 * **是「没有二维码元素」，还是「有但不符合判据」（例如不再是 data URL，或尺寸不够）？**
 *
 * 它**只**读取：打开登录页、dump DOM/图片清单/落盘快照，然后关浏览器。
 * 不填任何表单、不点任何按钮、不扫码、不登录。
 *
 * 用法（仓库根目录）：
 *   node --import tsx scripts/probe-toutiao-login-qr.ts
 *
 * 可能的失败点（都会如实打印，不静默）：
 *   · 浏览器起不来 → 打的是解析链的逐层诊断
 *   · 页面没加载出来 → 打印最终 URL 与 HTTP 层面的线索
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TOUTIAO_LOGIN_URL,
  openToutiaoSession,
  readQrDataUrl,
} from "../src/lib/toutiao-runner.js";

const STORAGE_ROOT = path.resolve(import.meta.dirname, "..", "storage");
const OUT_DIR = path.join(STORAGE_ROOT, "toutiao", "recon");
const PROFILE_DIR = process.env.TOUTIAO_PROFILE_DIR;

async function main(): Promise<void> {
  console.log("【只读诊断】今日头条登录页二维码提取");
  console.log(`  登录页: ${TOUTIAO_LOGIN_URL}`);
  console.log(`  storage: ${STORAGE_ROOT}`);
  console.log(`  profile: ${PROFILE_DIR ?? path.join(STORAGE_ROOT, "toutiao", "profile")}`);
  console.log("  本脚本只读取，不填表、不点击、不扫码。\n");

  let session;
  try {
    session = await openToutiaoSession({
      storageRoot: STORAGE_ROOT,
      ...(PROFILE_DIR ? { profileDir: PROFILE_DIR } : {}),
    });
  } catch (error) {
    console.error("❌ 浏览器起不来：");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  try {
    const page = session.page;
    const response = await page.goto(TOUTIAO_LOGIN_URL, { waitUntil: "domcontentloaded" });
    console.log(`  goto 返回的 HTTP 状态: ${response?.status?.() ?? "(无 response 对象)"}`);
    // 与产品一致的等待：登录页的二维码是异步渲染的
    await page.waitForTimeout?.(2500);

    const finalUrl = page.url();
    const title = await page.title();
    console.log(`  最终 URL: ${finalUrl}`);
    console.log(`  页面标题: ${title}`);
    console.log(`  是否仍在登录页: ${finalUrl.includes("/auth/page/login") ? "是" : "否（可能已登录或发生跳转）"}\n`);

    // 1) 产品判据的结果
    const viaProduct = await readQrDataUrl(page);
    console.log(`【产品判据 readQrDataUrl()】${viaProduct ? "✅ 取到了" : "❌ 返回 null（这就是 422 的直接原因）"}`);

    // 2) 页面上所有 img 的真实形状
    const images = await page.evaluate<string>(
      `(() => {
        const rows = Array.from(document.querySelectorAll("img")).map(function (img) {
          const src = img.currentSrc || img.src || "";
          return {
            prefix: src.slice(0, 48),
            isDataPng: src.indexOf("data:image/png") === 0,
            natural: img.naturalWidth + "x" + img.naturalHeight,
            rendered: Math.round(img.getBoundingClientRect().width) + "x" + Math.round(img.getBoundingClientRect().height),
            cls: String(img.className || "").slice(0, 60),
          };
        });
        return JSON.stringify(rows);
      })()`,
    );
    const parsedImages = JSON.parse(images) as Array<Record<string, string | boolean>>;
    console.log(`\n【页面上的 <img>】共 ${parsedImages.length} 个`);
    for (const row of parsedImages.slice(0, 20)) {
      console.log(
        `  data-png=${row.isDataPng ? "是" : "否"}  natural=${row.natural}  rendered=${row.rendered}  src=${row.prefix}`,
      );
    }

    // 3) 有没有「不是 img」但承载 data:image/png 的东西（canvas / background-image / svg）
    const otherCarriers = await page.evaluate<string>(
      `(() => {
        const out = [];
        document.querySelectorAll("canvas").forEach(function (c) {
          out.push("canvas " + c.width + "x" + c.height);
        });
        document.querySelectorAll("*").forEach(function (el) {
          const bg = getComputedStyle(el).backgroundImage || "";
          if (bg.indexOf("data:image/png") === 0) {
            out.push("background-image on <" + el.tagName + "> len=" + bg.length);
          }
        });
        document.querySelectorAll("svg").forEach(function (s, i) {
          if (i < 3) out.push("svg " + Math.round(s.getBoundingClientRect().width) + "px");
        });
        return JSON.stringify(out);
      })()`,
    );
    const carriers = JSON.parse(otherCarriers) as string[];
    console.log(`\n【其它可能的二维码载体】${carriers.length ? carriers.join(" | ") : "（无）"}`);

    // 4) 页面可见文案的前若干行 —— 判断是不是被风控/验证码/地域提示挡住了
    const text = await page.evaluate<string>(`(() => (document.body && document.body.innerText || "").slice(0, 400))()`);
    console.log(`\n【可见文案前 400 字】\n${text.replace(/\n{2,}/g, "\n")}`);

    // 5) 落盘快照，供改选择器时对照
    await mkdir(OUT_DIR, { recursive: true });
    const html = await page.content();
    const snapshotPath = path.join(OUT_DIR, "login-page.html");
    await writeFile(snapshotPath, html, "utf8");
    const reportPath = path.join(OUT_DIR, "login-qr-report.json");
    await writeFile(
      reportPath,
      JSON.stringify({ finalUrl, title, productVerdict: viaProduct ? "found" : "null", images: parsedImages, carriers, text }, null, 2),
      "utf8",
    );
    console.log(`\n  快照: ${snapshotPath}`);
    console.log(`  报告: ${reportPath}`);

    console.log("\n【结论】");
    if (viaProduct) {
      console.log("  产品判据这次取到了二维码 —— 说明失败是**间歇性**的（页面渲染时机 / 风控差异），而不是选择器完全失效。");
    } else if (parsedImages.some((row) => row.isDataPng)) {
      console.log("  页面里**有** data:image/png，但没通过判据 —— 看上面的 natural 尺寸：大概率是 naturalWidth < 200，或它不是 <img>。");
    } else {
      console.log("  页面里**没有**任何 data:image/png 的 <img> —— 二维码的载体变了（换成 canvas / 背景图 / 别的 URL）。");
    }
  } finally {
    await session.close?.();
  }
}

await main();
