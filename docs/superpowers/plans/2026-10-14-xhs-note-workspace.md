# 小红书原文改写工作台 Implementation Plan

> **For agentic workers:** Execute bounded backend/frontend slices in parallel, with the main agent integrating publishing and performing final verification. Preserve the current shared worktree and all unrelated changes; do not commit or push.

**Goal:** 将外部原文转写成可保存、编辑、配图和交付的小红书笔记。

**Architecture:** 独立 XhsNoteService/Writer 和 React 工作台；复用 AssetStore、原生 fetch、发布包资产、安全会话和现有小红书执行器。图片以素材库或本地 Canvas 图卡进入同一有序图片清单。

**Tech Stack:** TypeScript / Express / React / Canvas / OpenAI-compatible SDK，零新依赖。

**Spec:** docs/superpowers/specs/2026-10-14-xhs-note-workspace-design.md

## Global Constraints

- 源原文≤40000、样稿≤5000；标题20、正文1000、话题10×20、图片18；图卡正文600／标题100。
- JSON串行写入／损坏拒绝覆盖，变更带 version；图片 id→路径仅复用 AssetStore。
- AI成稿后编辑，两个请求各最多三次；失败不覆盖旧内容；默认3600 tokens、配置优先、DeepSeek关闭thinking、原生fetch。
- 包固定 note×xiaohongshu、AI声明true、submit=false；不创建作品，不自动提交平台。
- 不提交／推送，不覆盖其它任务改动，内部复核代理自行完成。

## Review Focus

- 生成期间同草稿编辑及重试：409／不覆盖更新后的草稿。
- 来源／语气要求或图卡变动：旧文案／旧图卡图片只能参考，发布拒绝。
- 素材被删、顺序改变或字节替换：预览／打包409或明确不可用，不能交付旧revision。
- 中文长句／emoji／多段文字：Canvas不裁字；放不下明确要求拆分。
- 发布包来源类型：索引重开兼容旧包且识别新包，新版本动作回正确工作台。

## Task 1: 后端草稿和改写

**Files:** 新增 src/lib/xhs-notes.ts、xhs-notes.test.ts、xhs-note-routes.ts、xhs-note-routes.test.ts。

**Interfaces:** 实现规格中的 XhsNoteDraft/XhsNote/XhsNotePreview、XhsNoteWriter.rewrite(draft)、XhsNoteService 及 registerXhsNoteRoutes。发布适配接口按规格固定；主代理实现 PublishingService.createXhsNote 和 app 装配。

- [x] 先写并运行失败回归：完整输入／JSON损坏／并发version／AI两阶段失败保存原文／来源绑定／卡片绑定／平台限额／图片顺序与哈希／401与403边界。
- [x] 实现存储、两阶段AI和REST路由，使用现有平台验证、素材路径解析及会话。
- [x] 验证：node --import tsx --test src/lib/xhs-notes.test.ts src/lib/xhs-note-routes.test.ts。

## Task 2: 发布中心接入

**Files:** src/types.ts、renderer/src/types/index.ts、src/lib/publishing-service.ts、publishing-store.ts及其测试、src/app.ts、renderer/src/pages/PublishingPage.tsx。

**Interfaces:** createXhsNote({noteId,title,noteCopy,sourceImagePaths,expectedImageHashes},actor)；sourceKind='xhs_note'／sourceNoteId=UUID／sourceJobId=`xhs-note-${UUID}`。

- [x] 先写失败测试：新来源持久化重开、无真实Job也能建note×xhs包、图片完整性回滚、限额拒绝。
- [x] 复用 createNotePackage，扩充来源类型验证，不改既有执行器行为。
- [x] app装配服务路由；发布中心来源链接与新版本入口回 /xhs-notes/:id。
- [x] 验证 publishing store/service 回归及类型检查。

## Task 3: 前端与本地图卡

**Files:** 新增 renderer/src/pages/XhsNotesPage.tsx、XhsNoteDetailPage.tsx及测试、renderer/src/utils/xhs-note-cards.ts及测试；renderer/src/services/api.ts、App.tsx、components/shell/navigation.ts及相关测试。

**Interfaces:** renderer直接 type-import后端XhsNote类型，API使用规格REST与现有publishingRequest会话重开；图片复用getAssets/getAssetRawUrl/uploadImageAssets。

- [x] 先写失败回归：原文保存恢复、AI失败保留输入、版本冲突不覆盖、两种图片来源和有序选择、替换成稿须确认、建包必须预览／使用权确认。
- [x] 实现列表和工作台，原文与结果分区、可编辑标题正文标签及cards；素材图片可排序和移除。
- [x] Canvas输出1080×1440 PNG，真实测量换行与字体布局，溢出拒绝。渲染前保存并捕获 version，上传全部成功后以捕获的 version 原子绑定；禁止用上传后的最新版本绑定旧图。部分失败不绑定半套；图卡编辑后提示重新生成。
- [x] 接入导航／路由／API；浏览器隔离验收真实Canvas图与上传/保存/重开/预览/建包流程。
- [x] 最终 npm run check、相关回归、编译并重启，内部独立审查并修正必要问题。记录未执行的真实AI或平台验收。

## 进度与裁定

- 写作规则只做授权范围内的改写；不以“去AI味”为名承诺检测结果或平台安全。
- 当前工作区已有大量未提交变更，采用互不重叠文件范围并行实施，主代理保留所有基线改动。
- 内部设计审查已完成：来源改变后仅成功改写才能恢复发布绑定；图卡上传绑定使用渲染前捕获的version，均已纳入对应回归。
- Task 1 完成：草稿服务／两阶段写作／路由与来源、图卡、图片安全绑定；最终相关回归已通过。
- Task 2 完成：独立小红书来源、图文包事务、索引兼容与发布中心来源跳转；106项发布服务／存储回归通过。
- Task 3 完成：双配图前端、Canvas、导航／API和输入保留；最终合并范围151项回归通过，另1项浏览器回归通过。
- 隔离完整流程通过：3张真实1080×1440图卡＋1张上传图，保存重开、顺序变化409、预览建包、失败保持、删除草稿保留包与390px宽度；截图位于output/playwright/xhs-note-workspace-qa。
- 内部最终代码审查通过，无P1/P2；全量测试快照1515通过／3跳过，后续边界修正与最终合并151项重新通过。npm run check及backend/electron/renderer编译通过；重启前确认作品／图集／文章／发布均无运行任务。
- 未调用真实AI、未提交平台、未验Windows；无提交或推送。模型语义准确性和原文／图片使用权仍需本人核对。
