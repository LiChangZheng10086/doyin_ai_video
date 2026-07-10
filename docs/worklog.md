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

## 最近操作

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
