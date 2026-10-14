# 抖创工坊 — 当前项目方案

更新：2026-10-14。本文描述已实现能力，不是早期仅「转录→洗稿→视频生成」的方案。操作方法见 [README](README.md)，未验收事项以 [GitHub Issues](https://github.com/LiChangZheng10086/doyin_ai_video/issues) 及验收记录为准。

## 项目定位与创作入口

Electron + React + Node/Express 的本地内容创作与多平台交付工作台。视频、公众号文章、小红书图文是独立入口；发布中心按平台和内容类型分栏，不要求所有内容先生成 MP4。

| 入口 | 当前流程 | 交付 |
| --- | --- | --- |
| 视频作品与字幕图集 | 抖音/YouTube 链接或分享文本 → 下载/字幕或本地 ASR；可继续洗稿、分镜、HyperFrames MP4，或从原视频直接创作字幕图集 | 转录、清洗稿、MP4、1080×1440 图集；图集可建抖音图文包，不等于已提交 |
| 独立文章创作 | 热点/关键词/公开资料 → 材料、提纲、正文、审稿 → 六种结构/排版、封面与正文图片 → 人工预览 | 公众号文章包与官方草稿；作品转文章另支持头条文章包 |
| 独立小红书创作 | 粘贴其它平台原文 → 改写/审校 → 标题、正文、标签 → 上传/素材库或文字图卡 → 保存/预览/建包 | 小红书图文包，再到发布中心准备浏览器本地草稿；默认不点击发布 |

视频主链路仍为四步手动确认：转录 → 洗稿 → 视频提示词 → 本地视频生成。单步最多三次尝试，失败停在当前步骤；创作重试机制不用于自动重发平台内容。

## 四个平台发布能力

**已经实现执行器或草稿接口，不是仅有规划。** 路由由 [`AUTO_PUBLISH_ROUTES`](src/lib/publishing-platforms.ts) 按内容类型与平台分派。

| 平台与内容 | 通路与前提 | 成功终点及边界 |
| --- | --- | --- |
| 抖音图文 | 外部 social-auto-upload（sau）CLI；配置 `SAU_BINARY`、`SAU_BASE_DIR`、有效登录态，预览确认 | 记录提交结果；用户核实后标记已发布；引擎缺失明确报错，不影响其他通路 |
| 小红书图文 | 自研 Playwright；扫码登录、同一持久化 profile、图片/文案/AI 声明通过预览 | 默认显式暂存并读回浏览器本地 IndexedDB 草稿；同 profile 窗口供人工核对发布，不同步到手机或默认浏览器 |
| 今日头条文章 | 自研 Playwright；扫码登录、文章 HTML、16:9 封面、预览确认 | 主动提交并记录页面反馈；无法确认时明确待核实；默认关闭微头条联发，实际结果由用户核实 |
| 微信公众号文章 | 官方 API；AppID/AppSecret、IP 白名单、接口权限、预览确认 | 上传封面/正文图后保存草稿；已有文章草稿可更新并保留原 ID。**不调用正式发布或群发接口**，未知结果禁止直接重发 |

视频、视频号、B站及其他未登记组合仍为人工交付。排期不是后台无人值守发布，不保证应用退出期间自动执行。

## 发布共同约束

- 发布包自包含，复制成片、封面、图片和 HTML；源素材后续变化不影响已建包。
- 包级预览给出 `previewRevision`、限额及检查结果；缺失或旧版本不能提交。
- 不把 HTTP 200、建包、填写页面、保存草稿或提交成功当作正式发布成功；平台结果须核对。
- 外部提交不自动重试；网络结果不确定时先核对，避免重复发布或重复建草稿。
- 本机操作者会话、权限、互斥和审计保留；平台登录态不是本机操作者登录。
- 微信密钥加密保存、不回显；浏览器 profile 和用户数据留在本机，不提交仓库。

## 字幕图集与可靠性

中文校对逐条保留原文、译文和时间。图片排版可合并相邻短句：编号连续、间隔 ≤1.5 秒、跨度 ≤6 秒、连接后 ≤26 个 Unicode 字符，不跨句末、长句、换行或取消选择的内容。每图条数指排版条数，覆盖统计按原编号计算，预览和成品共用规则。

原生字幕保留视频文字像素，不套用译文合并规则；macOS Apple Vision OCR 仅辅助定位，完整生成仍要求覆盖及人工确认。图集后台进度、暂停/继续和受控重启恢复已实现，旧缓存不能凭空恢复缺失信息。

索引串行写入、损坏时拒绝覆盖，本地后端绑定回环地址并校验来源；不启动时批量改写历史数据。详见 [可靠性验收](docs/research/2026-10-13-项目可靠性修复验收.md)、[短句排版验收](docs/superpowers/plans/2026-10-14-gallery-short-caption-layout.md)。

## 技术与运行

- Electron + React 19 + Vite + TypeScript；Node/Express 后端。
- yt-dlp、FFmpeg/FFprobe、内置 whisper.cpp + ggml-small；缺字幕时使用本地 ASR。
- 当前 OpenAI-compatible AI 配置供洗稿、翻译、审校和创作复用；文字图卡本地渲染，不冒充云端生图。
- HyperFrames 本地生成 9:16 MP4；可选 macOS 离线中文 TTS、本机背景音乐和字幕，音频失败不降级为无声成功。
- `npm run dev` 先编译后端与 Electron；`npm run check` 覆盖三端类型与凭据；`npm run build` 编译三套产物。

## 存储

桌面端默认 `~/Library/Application Support/douyin-ai-video/storage`，可由配置覆盖；独立后端默认仓库内 `storage/`。不再将 `~/Documents/抖音AI视频/` 写成固定默认目录。

```text
storage/
├── raw/{videos,audio,transcripts,page,text}/
├── processed/{scripts,cleaned,scenes,subtitles}/
├── output/{videos,galleries,publishing}/
├── assets/{images,audio}/
├── cache/                 # 作品、合集、图集、文章、发布及操作者索引
└── logs/
```

## 当前验收与后续方向

本地回归、真实 FFmpeg/Chromium 图片及隔离界面流程已有记录，**不等于四个平台真实账号重新验收完成**。本轮不替用户提交平台内容、创建微信草稿或群发。

- 小红书：新创作入口已接入文案、两类图片、预览和建包；真实语义、账号交付和原知识轮播完整接入仍需验收。[#15](https://github.com/LiChangZheng10086/doyin_ai_video/issues/15)
- 公众号：草稿接口和模板已实现；连接校验不能代替完整新建草稿写权限/排版验收。[#19](https://github.com/LiChangZheng10086/doyin_ai_video/issues/19)、[#20](https://github.com/LiChangZheng10086/doyin_ai_video/issues/20)
- YouTube：完整媒体/译文样本已验证；一小时无字幕 ASR、Windows/安装包及全文语义仍有缺项。[#16](https://github.com/LiChangZheng10086/doyin_ai_video/issues/16)、[#4](https://github.com/LiChangZheng10086/doyin_ai_video/issues/4)
- 原生 OCR：已修复裁切及上下文问题，不以局部覆盖代表全片正确率。[#12](https://github.com/LiChangZheng10086/doyin_ai_video/issues/12)
- 图集：恢复/缓存校验已实现，真实内容取舍、强杀恢复和平台发布分别验收。[#28](https://github.com/LiChangZheng10086/doyin_ai_video/issues/28)、[#23](https://github.com/LiChangZheng10086/doyin_ai_video/issues/23)
- 继续完善页面变更兼容、权限/未知结果反馈、Windows 自动 OCR/中文 TTS 与安装包体验，不将未来方向标成已交付。
