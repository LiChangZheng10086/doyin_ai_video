# 工作日志

> 规则：每次完成一轮操作后，只追加简短记录；下次开始新任务前，先看这份文件，再决定是否需要补充上下文。

## 当前状态

- 项目：抖音 AI 视频助手
- 当前形态：Electron + React + Express 的桌面应用
- 已有能力：本地存储、任务模型、抖音分享文本解析、视频下载、音频抽取、内置 whisper.cpp 结构化 ASR 转写、AI 洗稿、视频提示词生成、HyperFrames 本地视频生成、手动分步执行、步骤级 3 次自动重试、任务垃圾桶
- 当前接口：
  - `GET /health`
  - `POST /api/jobs`
  - `GET /api/jobs/:id`
  - `GET /api/jobs/:id/script`
  - `GET /api/jobs/:id/raw-share`
  - `GET /api/jobs/:id/raw-page`
  - `GET /api/jobs/:id/raw-transcript`
  - `POST /api/jobs/:id/steps/transcribe`
  - `POST /api/jobs/:id/steps/clean`
  - `POST /api/jobs/:id/steps/generate-video-prompts`
  - `POST /api/jobs/:id/steps/generate-video`
  - `GET /api/jobs/trash`
  - `POST /api/jobs/:id/restore`
  - `DELETE /api/jobs/:id/permanent`
  - `GET /api/jobs/:id/video-prompts`
  - `GET /api/jobs/:id/video-output`
  - `GET /api/jobs/:id/video/download`
- 本地存储目录：`storage/`
- 当前待办：Whisper 模型体积和速度优化、视频视觉样式优化、端到端样本回归测试
- 新增待办（2026-09-15）：合集封面 CDN 403、创作中心紫色滥用（P1）；`Unknown User`、`1970/1/1`、`0:00` 已于 2026-09-16 修复；详见 `docs/handoff-2026-09-15-ui-audit.md`

## 最近操作

- 2026-09-17：**文档同步**（`AGENTS.md` / `CLAUDE.md` / `README.md`）。三件事：① 补上会话内新增能力的说明（素材库、原视频播放、本机操作者无登录界面、可折叠侧栏）与对应 API；② 按实测更正两处**过时/错误**描述 —— storage 根目录随运行方式不同（桌面端是 `~/Library/Application Support/douyin-ai-video/storage`，独立后端是仓库 `storage/`），以及 Electron 读的配置文件在 `app.getPath('userData')` 而**不是** `~/.douyin-ai-video/config.json`；③ `README` 里描述「发布者无需 PIN / 管理员切换需 PIN / 重置本地用户」的那一节已随界面移除而重写为「本机操作者与权限」。顺带把 `AGENTS.md` 与 `CLAUDE.md` **同步为完全一致**（此前 AGENTS 落后一轮，缺 reclean 与 `dist` 警告）。
- 2026-09-17：实现**素材库**（③ 的 Task 1/2/4，提交 `90d6895`、`dfd9aa6`）：后端 `assets-store`（索引/落盘/白名单/限额/路径归属校验）+ `assets-routes`（multer 上传、列表、Range 预览、删除），前端 `/assets` 页面与主导航入口。新增 16 个用例；实时验证（真实后端上传真实封面 → 201、中文名正确、Range 206、删除后磁盘零残留）。测试抓到两个真 bug：类型校验里的死逻辑（`asset_kind_mismatch` 永远抛不出）、**busboy 按 latin1 解码文件名导致中文名乱码**。顺带把 Range 逻辑抽成 `range-response.ts` 供成片与素材共用（以既有 14 个 video-output 用例为回归门禁）。Task 3（图片接入图文）依赖 ② 的图文打包，已按用户决定推迟到做 ② 时合并。
- 2026-09-17：实现**侧栏可折叠**（①，4 个 Task）：`railPreference` 持久化、`AppShell` 声明 CSS 变量 `--rail-w` 作为宽度唯一真源（消除四处硬编码偏移）、`PrimaryRail` 展开态显示导航文字。新增 12 个用例。**复核反馈修正**：初版把折叠开关做成「整个 logo 行」，收起态与此前长得一模一样，用户找不到入口；改为底部常驻按钮并把 logo 行恢复原样（提交 `1b94fcb`）。教训记在 spec 第 5 节：视觉零变化与新增功能可发现性冲突时，应先问用户而不是自己按洁癖选。
- 2026-09-17：顺带修了一个**既有隐患**：`ApiKeyStatusIndicator` / `CookieStatusIndicator` 缺 `import React`，在 Node 下静态渲染会 `ReferenceError` —— 根因是根 `tsconfig.json` 没有 `jsx` 设置（tsx 走经典转换），而 `tsconfig.renderer.json` 是 `react-jsx`。25 个组件里有 7 个缺该 import，现有渲染层测试能过纯属运气（被测组件恰好都 import 了）。

- 2026-09-17：完成「接入 social-auto-upload 自动发布」的**最小可行性验证**（结论：可行，但有三处成本）。验证方式：把 `~/.douyin-ai-video/douyin-cookie.txt` 的 **Cookie 头字符串（59 段）机械转换成 Playwright `storage_state` JSON**（域 `.douyin.com`，字段形状照抄它的 `export_douyin_cookie.sh:183-196`），放进 `<repo>/cookies/douyin_mine.json`，跑 `sau douyin check --account mine` → 输出 **`valid`**（退出码 0）。**阴性对照**：同一流程把 sessionid/sid_*/ttwid 换成伪造值 → **`invalid`**（退出码 1），证明校验器有真实判别力、我们的登录态确实可复用（登录这半我们已有，不需要重登）。验证用的凭据副本已删除，用户的原始 cookie 文件未被改动（仍 5900 字节 / Aug 5 21:12）；全程**未发布任何内容**。
- 2026-09-17：验证中发现它的**官方安装步骤装完起不来**——`pyproject.toml` 只声明 `patchright`，但 `uploader/` 下 7 个 uploader（tk/alipay/hupu/weibo/xhs/baijiahao）与 `myUtils/auth.py`、`myUtils/login.py` 仍在 `import playwright`，而 `sau_cli.py` 在 import 阶段就加载全部平台 → `ModuleNotFoundError: No module named 'playwright'`。需手动 `uv pip install playwright` 才能启动 CLI。另外 `requires-python = ">=3.10,<3.13"`，本机 Python 3.13.12 **不在范围内**，必须用 uv 拉一个 3.12（本次用了 `uv venv --python 3.12` → CPython 3.12.10）。成本实测：仓库+venv 444MB、patchright chromium 525MB（≈ 970MB）。
- 2026-09-17：沙箱注意：`uv` 默认缓存 `~/.cache/uv` 会报 `Operation not permitted`，需 `UV_CACHE_DIR=/tmp/uv-cache`（同理 `UV_PYTHON_INSTALL_DIR`）。另 `patchright install chromium` 装的是 **headless shell**，运行时需带同一个 `PLAYWRIGHT_BROWSERS_PATH`。

- 2026-09-16：修 **P1 紫色滥用**（提交 `a4bb61c`）。元凶是一行：`ContentPreview.tsx` 的封面容器无条件铺 `from-tech-blue via-tech-purple to-tech-purple-dark`，被列表行/卡片/当前创作条三处复用 → 每张封面都是一块紫色。改为中性底（`bg-tech-bg`+`tech-border`，无图时标题 `tech-muted`），同类占位一并中性化（合集头像、Skill 头像、合集空状态图标）；`JobListView:59`/`JobCardView:45` 的 `Wand2` 与 AI 徽章等正当紫色用途保留；两处「处理进度」进度条有意保留。新增回归断言：封面占位不得出现任何 `purple` 类名且必须用中性 token。实测封面盒紫色 39/39 → **0/39**。
- 2026-09-16：更正交接文档里两条判断。①「封面 403 是防盗链」**错**：实测 4 种请求头组合（含 `Referer: douyin.com`）全部 403，URL 是带 `x-expires`+`x-signature` 的**签名链接**，仓库数据 23/23 已过期、App 真实数据仅 5/162 过期（其余签名到 2036）；故**代理无用**，只有有效期内落本地才可靠。②交接文档里的「紫/蓝比例」**不是**可用的验收口径：剩下的 351/352 个紫色元素是同一个 AI `wand-sparkles` 图标（39 行 × 每图标 8 个 `<path>`），SVG 内部路径把计数放大了 8 倍。
- 2026-09-16：修好两个插件故障并记录重放步骤（提交 `cf6722a`，改动在 `~/.dsh/profiles/web/node_modules/` 不在本仓库）：`dsh-cdp-browser` 5 个工具补 `output.schema`（只能用「任意属性对象」——运行期会用 schema 校验返回值且不支持 type 数组）；`dsh-computer-use` 的 Skill 名改为 `dsh-computer-use` 以消除与 `~/.agents/skills/computer-use` 的同名遮蔽。**需宿主重启 + 新会话才生效**。

- 2026-09-16：去除登录/切换入口，改为单一「本机操作者」（提交 `f0d1c70`）。先纠正了一个事实：桌面端**本来就没有登录这一步** —— `operator.ts` 会自动从 localStorage 恢复上次的**发布者**（不需要 PIN），只有切到管理员才要 PIN；真正的摩擦点是「0 用户时整个应用被建管理员门顶掉」+ 顶部操作者 chip + 设置页用户管理。改动：新增 `POST /api/local-sessions/auto`（复用已有管理员，无管理员时创建无 PIN 的「本机用户」）；`openLocalOperator()` 独立承担无 PIN 分支，**`open()` 的管理员 PIN 契约一字未改**（实测无 PIN 仍 401「管理员 PIN 为必填项」、错误 PIN 仍 401「PIN 不正确」）；前端启动即自动会话，卸载三处 UI 与随之失效的 `utils/localUsers.ts`。全量 385 → 372 项（删 21 个 UI 专属用例、新增 11、store 重写 -3），仅剩 1 个既有失败。
- 2026-09-16：全新安装场景已实测。空数据目录下 `POST /api/local-sessions/auto` 直接自举出「本机用户」（无 pinSalt/pinHash）；并用 `--user-data-dir=/tmp` 起了一个全新 profile 的 Electron —— 那条例用户记录**由渲染层自己写出**，说明它直接进了主界面而没有停在「创建本地管理员」门上（门若还在，自动会话请求根本不会发出，用户表会是空的）。附带确认：换成 `/tmp` 后 `workspace-write` 权限就够，之前两次 Electron 需要 `danger-full-access` 完全是因为数据目录在 `~/Library/Application Support` 下。
- 2026-09-16：发现仓库开发数据 `storage/` 里 16 条任务的 `videoPath` 全部指向另一个检出 `/Users/mac/workspace/ai/codex/douyin`，原视频路由对它们正确返回 422（安全校验按预期生效）。要在仓库数据上验证该路由需先修正这些历史路径。

- 2026-09-16：实现「详情页能看原视频」。起因是用户反馈点进详情看不到视频：实测任务 `97db73e8`（马尾辫）`transcribe`/`clean` 已 succeeded、原视频已存在，但详情页只能播成片，**原视频只有一行文件路径文本**。改动：`video-output.ts` 抽出 `resolveContainedMp4`，让成片与原视频共用同一份根目录/扩展名/inode 校验（`job.videoPath` 是持久化绝对路径，校验若各写一份等于开放任意文件读取）；新增 `GET /api/jobs/:id/raw-video/stream`，复用既有 `sendResolvedVideo` 的 Range 实现；新增 `SourceVideoArtifact`（播放器 / 未下载引导 / 不可读三态）与详情页「原视频 | 成片」分段切换，默认侧为「有成片看成片，否则看原视频」。规格与计划见 `docs/superpowers/specs/2026-09-16-raw-video-playback-design.md`、`docs/superpowers/plans/2026-09-16-raw-video-playback.md`，提交 `f0a1846`。
- 2026-09-16：实现过程中发现**仓库开发数据 `storage/` 里 16 条任务的 `videoPath` 全部指向另一个检出 `/Users/mac/workspace/ai/codex/douyin`**，文件在那边存在但不在本次 storage 根内，因此新路由对它们正确地返回 422 `source_video_unreadable`。这是安全校验按预期生效，不是 bug；要在仓库数据上验证该路由，需要先把这些历史路径修正或改用 App 真实数据（`~/Library/Application Support/douyin-ai-video/storage`，其 62 条任务路径均在自己的根内）。

- 2026-09-16：修复走查发现的 P0 泄漏。创作者昵称兜底从英文 `Unknown User` 改为简体中文「未知用户」（新增 `src/lib/nickname.ts`，`user-page-crawler.ts` 5 处兜底收敛到该常量/normalizeNickname，注意其中 1 处在生成的 Playwright 子进程脚本里、无法 import）；`CollectionStore.readIndex()` 在读取边界归一化历史落盘值，**只治内存、不重写用户数据文件**（`storage/cache/collections-index.json` 里 3 条 `Unknown User` 原样保留）。渲染层新增 `renderer/src/utils/display.ts`：昵称、日期、时长三处兜底，`createTime=0` 显示「未知时间」而不再是 `1970/1/1`，`duration=0.119` 显示「未知时长」而不再是 `0:00`。已用仓库真实脏数据（awemeId `7670181536511533691`）与 `dist/` 产物双重验证。
- 2026-09-16：查明交接文档第 0 节「看不到 `cdp_*` 就是没新开会话」的判断**不成立**，两个插件的真实原因都不是会话新旧：`dsh-cdp-browser` 的 5 个工具声明的是 `output: { render }`，缺少 DSH 强制的 `output.schema`，`tools.register()` 直接抛 `JsonSchemaError`，而插件 `apply()` 把每个注册异常 `console.error` 吞掉 → 任何会话都永远挂不上；`@anionex/dsh-computer-use` 的渐进暴露门按**内容指纹**校验，而 `~/.agents/skills/computer-use`（Hermes 版同名 Skill）遮蔽了插件自带的 `computer-use` Skill，导致 `containsSkillContent()` 永不匹配、11 个 `computer_*` 工具不暴露，`computer_use_activate` 也拒绝执行（实测报错「load the computer-use Skill first」）。详见交接文档第 9 节。

- 2026-09-15：完成一轮前端 UI 走查（8 路由 × 3 视口），发现 `Unknown User` 硬编码兜底泄漏进合集页 H1、爬虫 `createTime=0`/`duration=0.119` 导致界面显示 1970/1/1 与 0:00、创作中心紫色实测 702 次 vs 蓝色 125 次（违背规格「紫=AI/Skill」）。**完整交接与新会话须知见 `docs/handoff-2026-09-15-ui-audit.md`。**
- 2026-09-15：为走查装入 `@anionex/dsh-computer-use@0.3.2` 与 `dsh-cdp-browser`（commit `caecd3bded2e`）；两者写入 `~/.dsh/profiles/web`，需宿主重启**且新开会话**才会挂载工具。
- 2026-09-15：确认 `src/server.ts` 的后端读仓库内 `storage/`，与 App 的 `~/.douyin-ai-video/storage` 不是同一份数据；Vite 只监听 IPv6 `[::1]:5173`；纯浏览器模式经 `electron-bridge.ts` polyfill 可用。

- 2026-07-10：桌面主线 ASR 收敛为内置 whisper.cpp + ggml-small；音频提取改为 16kHz 单声道 WAV，设置页移除 ASR provider/API Key 输入。
- 2026-07-10：`backend/` 与 `frontend/` Docker 栈标记为历史实现；当前维护主线是 Electron + Node 后端。
- 2026-07-10：主链路移除 PPT，改为“视频转录 → AI 洗稿 → 生成视频提示词 → HyperFrames 生成视频”；删除主后端 PPT 生成器、PPT 步骤/API/前端入口，并更新 README/AGENTS/CLAUDE/PROJECT_PLAN。
- 2026-07-02：接入本地 FunASR 作为第三种 ASR provider，设置页新增“本地 FunASR（中文推荐，无需 API Key）”；缺依赖时会在转录步骤返回明确安装提示。
- 2026-07-02：更新 README、AGENTS、CLAUDE 和工作日志，将项目文档同步到“手动分步执行 → 视频转录 → AI 洗稿 → PPT”主链路。
- 2026-06-29：集成 video-master 和 ppt-generator-skill，实现双路输出：AI 清洗后并行生成视频场景提示词和 PPT 内容；新增 `video-enhancer.ts`、`ppt-generator.ts` 模块；扩展 `ScriptAsset` 类型支持 `videoPrompts`、`enhancedScenes`、`pptContent`、`pptPath` 字段；新增 3 个 API 接口；前端工作台新增「视频提示词」和「PPT预览」标签页。
- 2026-05-28：修复前端打开后服务崩溃的问题，缺失的历史任务 JSON 现在返回 404，不再导致 Express 进程退出；服务已改用 `screen` 后台会话 `douyin-dev` 启动并验证首页 200。
- 2026-05-28：排查前端页面无法打开，确认原因是 `localhost:3100` 服务已停止；已重新执行 `npm run dev` 启动，`/health` 和首页 `/` 均验证通过。
- 2026-05-28：用抖音样本 `xKR5ata208I` 完成端到端测试，视频下载、音频抽取、DeepSeek 清洗和脚本生成均成功；当前未配置 ASR key，因此未生成转写。
- 2026-05-28：修正 AI 清洗产物的 `cleaningMode` 命名，DeepSeek 调用会记录为 `deepseek`，避免误显示为 `openai`。
- 2026-05-28：新增本地 `.env` 并配置 DeepSeek provider/key（不记录密钥内容）；服务入口已支持启动时加载 `.env`，`npm run check` 和 `/health` 验证通过。
- 2026-05-28：完成 DeepSeek/API key 安全检查，当前项目未发现真实 `sk-*` 密钥；`.env.example` 仅保留占位符，运行中的本项目开发服务也未检测到相关 key 环境变量。
- 2026-05-28：检查本机浏览器和自动化进程，未发现内部打开的抖音窗口；Chrome 中也没有 `douyin.com` / `iesdouyin.com` 标签页需要关闭。
- 2026-05-28：排查前端 `Failed to fetch` 报错，确认根因是本地后端当时未在 `http://localhost:3100` 监听；重新启动后 `POST /api/jobs` 已可正常返回 201。
- 2026-05-28：完成本地网页工作台验证，主页可直接返回 200，并能作为任务控制台使用。
- 2026-05-28：新增本地网页工作台，主页可直接创建任务并查看脚本、清洗、分享文案、页面信息和转写结果。
- 2026-05-28：自测确认在未配置 ASR key 的情况下，音频抽取后会跳过转写但不阻塞，任务仍能完成到 `scripted`。
- 2026-05-28：补齐 ASR 转写层，新增 `raw/transcripts`、任务转写字段和 `raw-transcript` 接口；无 ASR key 时会跳过转写，不阻塞后续流程。
- 2026-05-28：接入 `yt-dlp` 视频下载与 `ffmpeg` 音频抽取基础设施，新增媒体路径和失败提示字段，后续可直接接 ASR。
- 2026-05-28：把下载策略改成和 `douyin_ppt` 一致的“页面直链优先 + `yt-dlp` 兜底”，并修正了页面元数据的落盘路径。
- 2026-05-28：用同一条抖音样本重新自测，页面直链下载成功，`raw/videos/*.page.json` 也正常落盘。
- 2026-05-28：用你提供的抖音样本做了自测，确认在缺少 cookies 时会返回明确的下载提示，但任务仍可按分享文本 fallback 完成并记录 `downloadErrorMessage`。
- 2026-05-28：新增本地工作日志文件，作为后续任务的优先上下文入口。
- 2026-05-28：完成分享文本解析层，支持从抖音分享文案中提取链接、简介、标签和内容类型。
- 2026-05-28：完成脚本草稿生成层，能把解析结果整理成口播稿、封面标题和分镜结构。
- 2026-05-28：完成 AI 清洗层，先接入 OpenAI 兼容接口，后改为支持 DeepSeek provider；未配置 key 时自动回退规则版生成。
- 2026-05-28：将 AI 清洗层改为可配置 provider，默认支持 DeepSeek OpenAI-compatible 接口，缺少 key 时自动回退规则版生成。
- 2026-05-28：将 AI provider 默认切到 DeepSeek，并补充了 `.env.example`，方便直接填 key 调试。
- 2026-05-28：新增抖音网页提取层，记录重定向链、视频 ID 和页面挑战状态，并写入 `raw/page`；后续会让位给“视频下载 + ASR”主链路。
- 2026-05-28：搭建项目骨架，包含本地存储、任务模型、基础接口和 README 使用说明。

## 记录方式

- 只写结果，不写长过程。
- 每次新增一条或两条即可，优先写“改了什么”和“影响什么”。
- 如果某一步有风险或未完成，单独补一条“待确认”。
