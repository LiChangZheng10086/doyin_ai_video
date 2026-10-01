# 抖音转录报错修复与桌面端 yt-dlp cookie 透传

2026-10-01。用户报告「视频转录」报 `unable to parse douyin video info` + yt-dlp `Fresh cookies (not necessarily logged in) are needed`。排查后确认这是**三层叠加失败**被拼进同一条错误，修复了其中两层根因，并补齐桌面端缺失的一处 env 透传。

## 根因

1. **页面解析通路（真正的根因）**：`MediaService.parseDouyinPageVideoInfo()` 请求 `iesdouyin` 分享页时只发 `DOUYIN_HEADERS`，**没有带登录 cookie**。同一 URL 实测对照：不带 cookie 时 `_ROUTER_DATA` 里**没有** `videoInfoRes`（→ `item_list` 缺失 → 抛「unable to parse douyin video info」）；带上 cookie 后 `videoInfoRes.item_list` 长度为 1，可正常解析。已排除两种误判：不是抖音改版，也不是 URL 形态问题 —— 代码本来就把桌面 URL 归一成 `https://www.iesdouyin.com/share/video/{id}`，而桌面版 `www.douyin.com/video/{id}` 确实只回 JS-VM 挑战页（连 `_ROUTER_DATA` 都没有）。
2. **yt-dlp 那句报错是误导性的**：`yt_dlp/extractor/tiktok.py` 的 `DouyinIE._real_extract()` 只在 `aweme/v1/web/aweme/detail/` 没返回 `aweme_detail` 时抛出 `Fresh cookies (not necessarily logged in) are needed`，**完全不检查 cookie**（源码里还留着 TODO「Run verification challenge code to generate signature cookies」）。该请求不带 `a_bogus`，所以 Homebrew 2026.03.17 与随包 2026.07.04 表现完全一致 ⇒ 照提示去设 `YTDLP_COOKIES_FILE` 对抖音无效。
3. **签名 API 通路被 Argus 拦**：原样 `403 Blocked by ArgusSecurityPlugin Uifid Not Found`（cookie 里有 `UIFID`，但没作为请求头下发）；补上 `Uifid` 头后变成 `Signature Not Found`（`X-Bogus`/`a_bogus` 算法已过期）。本次**未修**，要修得重写 ABogus。
4. **桌面端从未透传 yt-dlp cookie 配置**：`electron/server.ts` 不读 `YTDLP_COOKIES_FILE` / `YTDLP_COOKIES_FROM_BROWSER`（`src/server.ts` 有），于是 `buildCookieArgs()` 在桌面端恒返回 `[]`。影响面不止视频下载：`src/app.ts` 把这两个值同时喂给 `MediaService` 与 `UserPageCrawler`（主页采集），桌面端两者都拿不到。

## 改动

- `src/lib/media.ts`：新增 `douyinCookie` 配置注入点与 `resolveDouyinCookie()`（惰性 import，避免 `douyin-cookie.ts` ↔ `media.ts` 模块环，与签名 API 通路同一写法）；分享页两处请求都带上 Cookie；未带 cookie 时错误改为「未带抖音 cookie：分享页不会返回 videoInfoRes，请先在设置页扫码登录」，不再含糊地说解析失败。
- `electron/utils/ytdlp-config.ts`（新增）：`resolveYtDlpCookieConfig(env)` 纯函数，照既有 `sau-config.ts` 模式抽出（`electron/server.ts` 依赖 `electron` 模块、不好直接测）；空白与空串归一为 `undefined`，否则会下发 `--cookies ""` 让 yt-dlp 报错。
- `electron/server.ts`：在 `ServerConfig` **顶层**加入 `...resolveYtDlpCookieConfig(process.env)`。
- 用例：`src/lib/media.test.ts` 新增 5 条（cookie 确实发出且分享页据此返回 `videoInfoRes`、无 cookie 时报错点明未登录且不凭空造 Cookie 头、`cookiesFile → --cookies`、`cookiesFromBrowser → --cookies-from-browser`、两种来源互斥/都没配则一个都不下发）；`electron/utils/ytdlp-config.test.ts` 新增 3 条。

顺带填上一个测试空白：此前仓库里**没有任何用例**证明「`cookiesFile` 会真的变成 `--cookies`」——正是本次整条丢掉的环节。

## 验证与产物

- 全量 `npm test`：**1117 通过、1 跳过、0 失败**（较上轮 +5）；`npm run check` 通过（前后端类型检查 + 凭据扫描 779 个文件无命中）。
- 产物核对（本次改动属于文档里记的「改了 `electron/` 但 `dist-electron/` 是旧的」同一类事故，故按该口径 grep）：`dist/lib/media.js` 含 `resolveDouyinCookie`，`dist-electron/server.js` 含 `resolveYtDlpCookieConfig`。
- 线上实测（真实 cookie）：分享页解析出作品《黑暗M78 大怪兽格斗篇（39-45集）》、作者「香菜左转不送」；CDN 返回 `HTTP 206`、`content-type: video/mp4`、`content-range: bytes 0-1023/310223463`。
- 桌面端重启后读到真实数据目录的 **139 个任务**（内嵌后端端口 61825）。

## 未完成与遗留

- **未能完成 295MB 的端到端下载**：抖音 CDN 对本机 IP 截断在约 2MB。对照实验已排除环境因素（Cloudflare 1/10/20/50MB 均完整拉完，故不是沙箱限制），判断为抖音侧限流，疑与本轮大量探测有关。最终确认留待用户在应用内重试。
- 未做「真实跑一次 yt-dlp 并抓 `--cookies` 命令行」的运行时验证：页面解析修好后抖音已不再走 yt-dlp；该环节目前由用例 + 产物核对覆盖。
- `src/server.ts` 仍为原样透传、没有「空串＝没配」的裁剪，与桌面端口径不一致（helper 在 `electron/` 下、受 `rootDir ./electron` 限制，本轮未强行统一）。
- 未改签名 API 的 `Uifid` 头与过期签名算法；未调用任何真实发布。

## 环境备注

本机沙箱预设 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 二进制退化成纯 Node（表现为 `require('electron').app` 为 `undefined`）；且默认 userData 目录不可写、Chromium 自身沙箱与 GPU 进程初始化被拒（`Operation not permitted` → `FATAL: GPU process isn't usable`）。故本轮以 `env -u ELECTRON_RUN_AS_NODE` + 完整文件访问启动，**未**使用 `--user-data-dir`。早期误用 `.dev-userdata` 曾造成「本地数据都没了」的假象，实际 139 个任务与 2 个 AI Key 完好无损。
