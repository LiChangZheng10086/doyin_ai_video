# 在线音频素材 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 在本会话实施；用户已批准方案，完成后进行独立审查。

**Goal:** 榜单/搜索 → 试听 → 勾选下载到现有素材库。
**Architecture:** Node HTTPS 固定来源适配，单份 AssetStore 入库。私有临时媒体 + 原生音频控件，服务器小队列处理批次。
**Tech Stack:** Node、Express、React、已有 FFprobe；无新依赖。
**Spec:** ../specs/2026-09-30-online-audio-assets-design.md

## Global Constraints

- 网易云、QQ 单独验收；不可用来源明确提示，不用模拟数据替代。
- 音频 ≤50MB；榜单缓存 10 分钟，刷新间隔 ≥60 秒；每批 ≤20 首。
- HTTPS 固定允许域名，DNS 校验并固定连接地址；禁止重定向和客户端任意 URL。
- 试听不自动入库；保留片段标识；写入需本机会话。
- 复用主题令牌、Range、AssetStore、runCommand；图片和成片流程不扩展。

## Review Focus

- 平台返回 HTTP 200 但列表格式变化：显示不可用。
- 下载并发手动上传/删除：索引不丢失。
- 下载中断/伪音频/超限：不入库且清理临时文件。
- 切换搜索/平台后旧请求返回：不覆盖当前结果或选择。
- 后端重启/素材页离开后返回：可看批次结果，丢失批次明确中断。

### Task 1: 来源与素材存储

**Files:** src/lib/online-audio-sources.ts(.test.ts), src/lib/assets-store.ts(.test.ts)
**Interfaces:** OnlineTrack、AudioSource、AudioBoardId；fetchAudioTracks(source,board/query)、resolveAudio(track)；AssetRecord.audioSource。
- [x] 测试先行：真实响应形状解析、错误格式、公开地址范围；并发入库、损坏索引保护。
- [x] 实现网易云/QQ 来源和 HTTPS 边界，严格字段校验；串行 AssetStore 写入与重复来源去重。
- [x] 运行 node --import tsx --test src/lib/online-audio-sources.test.ts src/lib/assets-store.test.ts。

### Task 2: 试听与下载 API

**Files:** src/lib/online-audio.ts(.test.ts), src/lib/online-audio-routes.ts(.test.ts), src/app.ts
**Interfaces:** OnlineAudioService.list/search/preview/startImport/getImport/openMedia；注册 /api/online-audio。
- [x] 测试先行：缓存限频、失败保留、已解析曲目才能下载、片段标识、队列部分失败、重复提交、清理与 Range。
- [x] 下载到私有临时文件，FFprobe 确认音频与时长后统一入库。批次持有操作者归属，GET 查询状态。
- [x] 运行相关 Node 测试及隔离真实来源验收脚本。

### Task 3: 在线音频界面与验证

**Files:** renderer/src/components/OnlineAudioPanel.tsx, renderer/src/pages/AssetsPage.tsx, renderer/src/services/api.ts, renderer/src/types/index.ts, scripts/verify-online-audio.ts
**Interfaces:** 前后端共享在线音频类型；ApiClient 方法返回来源、榜单、曲目、试听及批次。
- [x] 用现有主题构建榜单/搜索、单首试听、多选下载及进度；原生控件与可访问标签。
- [x] 队列仅对所选曲目提交；切换结果清空选择；结果请求竞态保护；sessionStorage 记录最近批次。
- [x] 隔离存储验收真实榜单、搜索、媒体探测、入库及 Range；不写真实素材。
- [x] npm test、npm run check、npm run build；UI 桌面/移动实测。

## Execution ledger

- 方案已获用户批准；直接在当前 codex 分支实施，避免再次要求审批已授权实施。
- 来源侦察：网易云榜单、搜索、普通公开播放器 API 成功；QQ 榜单和 vkey 成功，搜索使用移动端 DoSearchForQQMusicMobile，已真实验证。
- 提交留给用户；不提交无关的界面重设计草案。

- 2026-09-30 验收：网易云、QQ 各三份榜单均返回 100 条，关键词“卡农”各返回 30 条；两家完整音源均完成 FFprobe 帧校验、Range 206、入库、去重和删除。QQ 前两首会员限制如实返回 422，未替换音源。
- 独立审查的三个 P2 已修复：损坏 MP3 元数据不能代替音频帧验证；下载 POST 接受后即由 API 层保存批次；素材列表共同请求序号防止旧刷新覆盖新结果。对应回归先失败、后通过；浏览器乱序脚本明确复现音频 (2) 被旧请求改回 (1)，修复后保持 (2)。
- 桌面 1440×1000 深色、移动 390×844 浅色实测搜索/试听/下载成功，移动无横向溢出；试听控件 readyState=4。截图在 output/playwright/online-audio-{desktop,mobile}.png，使用隔离真实来源后端，未写用户存储。
- 全量 npm test：1048 项，1047 通过、1 跳过、0 失败；npm run check（含凭据扫描）与 npm run build（renderer/electron/backend）通过。所有独立审查问题已处理，无新增运行时依赖。
