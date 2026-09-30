# 图片提示词与可复用素材库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户可生成／优化并保存图片提示词，上传图片绑定最终文本，之后在素材库与文章选图区检索复用。

**Architecture:** 新增一个提示词服务，复用当前运行时 AI 配置、AI 文本提取函数及 LocalStorage。图片文件与元数据统一进入 AssetStore，提示词先按版本复制快照后再上传，不构建跨 JSON 事务。素材页与文章向导复用内联提示词面板，文章选图仍只提交既有素材 ID。

**Tech Stack:** Node、Express、TypeScript、现有 OpenAI SDK、React、Tailwind、node:test；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-30-image-prompt-assets-design.md`

## Global Constraints

- 不安装外部 Skills，不新增生图接口、中文自动分词、语义检索或模型专用参数。
- 保留当前在线音频工作区改动、audioSource、AssetStore 串行写入及损坏索引保护；不混入无关提交。
- 生成 1～6 条，优化固定 1 条；默认中文、封面、16:9，公众号封面默认 2.35:1；比例还允许 3:4／9:16。
- 字数按 Unicode 码点：参考内容 12,000、原／最终提示词 8,000、修改要求 2,000、风格 200、描述 1,000、标题 100、查询 200、标签最多 12 个且每个 30。
- 单次 AI 请求 60 秒、maxRetries=0；错误 400／404／409／422／500／502／504 按规格区分；不直接回传敏感上游错误。
- 图片 ≤20MB、一次 ≤20 个、multipart metadata ≤1MiB／文本字段最多 3 个；服务端生成文件名、路径校验继续使用现有入口。
- 生成或优化的结果不自动覆盖原稿；描述逐图编辑，优化保留未要求修改的原约束，图中文字不随输出语言翻译。
- 头条仅封面，公众号封面及有序正文图；搜索不取消已选图、不覆盖文章；新操作用本机会话。
- 真实素材、配置和平台发布不用于模拟验收。改源码后编译对应产物；仅编译不代表已重启应用。

## Review Focus

- 中文标题很长但素材描述只包含短词：默认展示全部，用户提交短词，不自行将标题当整句过滤。
- 草稿在上传中被编辑／删除：取得前冲突拒绝，取得后使用已复制快照，不改变图片最终文本。
- 同一批有两张相似图但画面不同：各自描述／标签不被共享字段覆盖；原始文件序号映射准确。
- 未收到上传响应：不自动重传整批，先核对入库结果，防止重复素材；部分成功保留并可只重试失败文件。
- 在文章内生成提示词后返回编辑：焦点可用，文章、已选图片与未保存输入不会被刷新／旧响应覆盖。

---

### Task 1: 提示词生成、优化及持久草稿

**Files:** Create `src/lib/image-prompts.ts`, `src/lib/image-prompts.test.ts`, `docs/third-party/image-prompt-rules.md`。

**Interfaces:**
- `ImagePromptInput`：mode 为 generate／optimize；referenceText、originalPrompt、changes、purpose、aspectRatio、style、language、count 按规格校验。generate 要求非空 referenceText；optimize 要求非空 originalPrompt，count 固定 1。空参考内容不能进入模型。
- `ImagePromptRecord`：id、输入快照、title、tags、prompt、rulesVersion、version、createdAt、updatedAt。
- `ImagePromptService(storage, { resolveAiConfig, createClient? })`；createClient 使用可注入的现有聊天客户端形状，生产配置创建 OpenAI 客户端；复用 `extractAiMessageText`。
- Produces `list(): Promise<ImagePromptRecord[]>`、`generate(input: unknown): Promise<ImagePromptRecord[]>`、`update(id: string, input: unknown): Promise<ImagePromptRecord>`、`remove(id: string, version: unknown): Promise<void>`、`snapshot(id: string, version: unknown): Promise<ImagePromptRecord>`。
- `ImagePromptError(status: number, code: string, message: string)` 用于后续路由映射。

- [ ] 写最小回归：生成后重建服务能读回；优化另建记录不改原稿；输出数量不符／畸形／超限零写入；版本冲突；损坏索引不覆盖；并发生成不丢记录；snapshot 后编辑／删除不改旧对象。
- [ ] 运行 `node --import tsx --test src/lib/image-prompts.test.ts`，确认新行为失败后再写实现。
- [ ] 实现服务与固定通用规则，索引 `cache/image-prompts.json` 带 schemaVersion=1。AI 请求在队列外，最终全组验证后一次串行保存；版本从 1 开始递增。PATCH 只允许编辑 title／tags／prompt，其他输入快照不改；snapshot 返回独立复制。模型响应要求 `{ prompts: [{ title, tags, prompt }] }`，规则与比例设置从业务约束中独立提供。模型输出 token 上限沿用已有 AI 输出配置策略，不假定一个供应商格式通用。
- [ ] 第三方说明记录两份参考的固定提交、版权和许可证；规则用本项目自己的简短表达，不复制完整 Skill，不沿用社区宣称的具体模型版本。
- [ ] 重跑本任务测试，全部通过后仅提交本任务文件，提交信息 `feat: add persistent image prompt generation and optimization`。

### Task 2: 图片元数据、关键词检索与 HTTP 链路

**Files:** Modify `src/lib/assets-store.ts`, `src/lib/assets-store.test.ts`, `src/lib/assets-routes.ts`, `src/app.ts`；Create `src/lib/image-prompt-routes.ts`, `src/lib/image-prompt-routes.test.ts`。

**Interfaces:**
- Consumes Task 1 的 service／error／record。
- Produces `ImageAssetMetadata`（description?／tags?／generationPrompt?）；AssetRecord 新增 metadata 字段、metadataVersion?、imagePromptId?、imagePromptVersion?。
- `AssetStore.add` 扩展图片 metadata 与草稿来源快照输入，在同一次索引保存中写入；`updateImageMetadata(id: string, input: unknown): Promise<AssetRecord>` 按 metadataVersion 比较后更新，直接改最终提示词清空旧来源 ID／版本。
- `searchImageAssets(records: AssetRecord[], query: unknown): AssetRecord[]`：去重查询词、逐字段子串匹配、所有词都命中、按描述／标签命中词数排序，然后 createdAt 倒序／ID 升序。无查询返回原列表；跨字段文本不拼接为一个词。
- `registerImagePromptRoutes(app, { prompts, sessions })`：GET 列表回 `{ prompts }`，POST 回 201 `{ prompts }`，PATCH 回 `{ prompt }`，DELETE 带 version 回 204。新增写入均 requireActor，JSON 错误给可读信息。
- `registerAssetRoutes` 扩展可选 prompts／sessions deps；现有测试和纯上传仍可只传 assets。app.ts 在 AI resolver 后创建唯一提示词实例，注入两组路由；不另建 AssetStore。
- GET assets 扩展 `{ assets, total }`；POST images 接收 files、metadata、imagePromptId、imagePromptVersion。PATCH metadata 回 `{ asset }`。带新字段的图片上传与 PATCH 在落盘前鉴权，原接口保持兼容。

- [ ] 补 store 检查：旧记录可读、元数据修改／清空／冲突、并发新增与编辑不丢其他图片／音频、图片不同描述、中文多词／提示词／文件名检索与确定排序。
- [ ] 补真实 HTTP 检查：无会话写入 401、multipart 数组不匹配 400 零写入、绑定过期草稿 409 零写入、绑定后编辑／删除不影响快照、部分成功 200、全成功 201、零成功具体 4xx／5xx、metadata 超限、audio 新图片字段拒绝、total 不因搜索变化、音频／原文件 Range 原契约可用。使用临时目录、随机端口与模拟 AI，不动真实数据。
- [ ] 运行 `node --import tsx --test src/lib/assets-store.test.ts src/lib/image-prompt-routes.test.ts`，确认未实现行为失败。
- [ ] 接通对应接口。multipart 元数据先完整校验；绑定草稿仅从 snapshot 取原文。同批图片逐项调用统一 store，失败回原始 index；磁盘／索引错误停止剩余项并标未上传。错误处理放路由自身，不依赖注册顺序导致 LocalAuthError 变 500。
- [ ] 重跑上述测试及 `node --import tsx --test src/lib/online-audio-routes.test.ts`。通过后只提交本轮新增内容；src/app.ts／assets-store.ts 已有音频修改不能整体顺带提交。

### Task 3: 素材页提示词面板与图片编辑

**Files:** Modify `renderer/src/services/api.ts`, `renderer/src/types/index.ts`, `renderer/src/pages/AssetsPage.tsx`；Create `renderer/src/components/ImagePromptPanel.tsx`, `renderer/src/components/ImageAssetEditor.tsx`, `renderer/src/components/ImagePromptPanel.test.tsx`。

**Interfaces:**
- Consumes Task 1／2 的数据类型及接口；仅通过 type 导入后端定义，渲染端不导入 Node／OpenAI 运行时代码。AssetRecord 的新字段与后端对齐，保留现有 audioSource。
- API 新增 `getImagePrompts`、`createImagePrompts(input)`、`updateImagePrompt(id, input)`、`deleteImagePrompt(id, version)`、`searchImageAssets(q)` 回 `{ assets, total }`、`updateImageMetadata(id, input)`、`uploadImageAssets(files, metadata?, binding?)` 回 `{ assets, failures? }`。
- 普通 `uploadAssets` 图片分支同步识别 failures，展示已入库／未成功情况；音频行为不改。不自动重试网络失败的上传或 AI 请求；新图片客户端设置足够接收 60 秒 AI 超时的等待时间。
- `ImagePromptPanel({ referenceText?, defaultAspectRatio?, onAssetsChanged })`：可在素材页展开，也可内联进文章 Modal；包含生成／优化表单、已存草稿列表、版本编辑、复制、删除、绑定上传及逐图描述表单。无重叠 Modal。
- `ImageAssetEditor({ asset, onSaved, onCancel })`：内联编辑描述／标签／最终提示词，保存时带当前版本；冲突保留输入并提供刷新核对。

- [ ] 写静态渲染检查：生成／优化入口、用途／比例／语言选择、复制和上传入口、可见错误区域与表单 label。交互状态通过 Task 4 的隔离浏览器脚本验证，不用静态测试假装覆盖 hooks。
- [ ] 运行 `node --import tsx --test renderer/src/components/ImagePromptPanel.test.tsx`，确认缺少 UI 的检查失败。
- [ ] 实现表单、草稿恢复、编辑与明确保存、clipboard 异常提示、标签编辑、图片预览 URL 释放、逐文件绑定上传和失败重试。未保存内容用关闭回调内确认保护；不擅自覆盖草稿或文章。新请求序号丢弃过期结果。
- [ ] 素材页新增搜索与 metadata 展示／编辑，区分没有素材和无搜索结果；面板入库后刷新图片。沿用 theme 令牌、原控件和音频 OnlineAudioPanel，保持键盘可达。
- [ ] 运行上述 UI 检查及 `npm run check:renderer`，通过后只提交本轮变更。

### Task 4: 文章选图集成、浏览器验收与完整门禁

**Files:** Modify `renderer/src/components/CreateToutiaoArticleDialog.tsx`, `renderer/src/components/CreateToutiaoArticleDialog.test.tsx`；Create `scripts/verify-image-prompt-assets.ts`；Update 本计划、设计状态与项目功能说明。

**Interfaces:**
- Consumes `ImagePromptPanel` 和 Task 3 API。onAssetsChanged 只刷新候选素材，绝不设置 articleTitle／articleBody。
- 封面和公众号正文共用搜索结果；独立保留素材总数及已选图片缓存。请求 ID 防旧结果覆盖；默认空查询显示全库，筛选不触发选图或文章预览。
- prompt 面板输入当前编辑的标题／正文，头条 16:9、公众号 2.35:1；显式上传／选图后仍走现有预览指纹与 ID 路径校验。
- 验收脚本创建临时 storage，启动随机或显式隔离端口，注入模拟 AI，打印入口，退出清理服务与临时目录；正常模式不调用外部生图或平台提交。

- [ ] 补文章静态渲染检查：头条仅封面、公众号正文保留顺序、关键词搜索和内联面板存在；保留现有 articleFallback 提示。运行 `node --import tsx --test renderer/src/components/CreateToutiaoArticleDialog.test.tsx` 看新增断言失败。
- [ ] 实现选图集成；不添加新的发布类型或平台参数，不为搜索请求重新生成文章。
- [ ] 编写并启动隔离验收脚本，用浏览器验证：生成→编辑→复制→上传两图／独立描述→检索；关闭再开草稿可恢复；409 保留输入；多文件部分失败只重试失败项；中文长标题默认显示全部；文章中选图后搜索无结果仍保留选中摘要和正文顺序；返回表单文章输入不变；Tab／Esc 和主题可用。
- [ ] 跑 `node --import tsx --test src/lib/image-prompts.test.ts src/lib/image-prompt-routes.test.ts src/lib/assets-store.test.ts renderer/src/components/ImagePromptPanel.test.tsx renderer/src/components/CreateToutiaoArticleDialog.test.tsx`，结果全通过。
- [ ] 跑 `npm test`、`npm run check`；如出现其他工作区功能失败，定位来源并明确报告，不删无关改动以伪装全绿。
- [ ] 跑 `npm run build:backend`、`npm run build:renderer`、`npm run build:electron`、`npm run mark-cjs`，确认新源码有对应产物。不自行中断用户当前 Electron 会话；需要重启时先保留输入并说明编译与运行状态。
- [ ] 请求一次独立代码审查，范围限定本轮差异和批准规格，保留在线音频改动边界；重要问题用失败检查复现后修复，再验证全套门禁。
- [ ] 最后核对 diff 和凭据扫描，更新验收记录，只提交本功能，汇报真实完成与未验收项目；不自动推送、合并或发布。

## 执行方式建议

推荐 Native：四个任务共享 AssetStore、API 和文章表单，且同工作区已有音频改动；由同一实现者顺序完成更容易控制接口与差异边界。最终保留一次独立审查。若选择逐任务子代理方式，同样先写失败检查再实现并逐任务审核，不并发改动共享文件。
