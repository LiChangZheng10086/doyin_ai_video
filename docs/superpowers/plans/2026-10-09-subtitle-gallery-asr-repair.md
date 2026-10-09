# 字幕图集与转录修复实施计划

**Goal:** 修复错误转录与时间定位，完成自动图集方案预览和确认生成。

**Architecture:** 共用转录质量检查由 ASR、洗稿和图集使用。图集规划绑定转录与原视频指纹，持久化待确认方案；确认后复用现有原子渲染和发布流程。原生字幕只取视频像素，自动检测是候选建议，用户在整套预览确认。

**Tech Stack:** 现有 TypeScript、React、Express、whisper.cpp、FFmpeg；不新增运行依赖。

**Spec:** `docs/superpowers/specs/2026-10-08-subtitle-gallery-asr-repair.md`

## Global Constraints

- 原生字幕模式，默认每张 8 条、手动支持 1～9 条；内容和可读性优先。
- 不改写已建发布包，不自动发布，不静默迁移真实数据。
- 来源读取保持私有快照、根目录和 inode 校验；版本冲突保留编辑。
- 所有自动识别失败纳入原有最多三次尝试，不嵌套无界重试。
- 工作区已有资料搜索等未提交改动，不回退、不混入提交；各实施域只写分配的文件。

## Review Focus

- 无字幕的明亮背景不能被承诺为正确字幕，方案必须显示候选和整套核对提示。
- 旧转录异常不能继续洗稿或规划，正常强调和歌词不能被一律删除。
- 重转录失败不能丢旧文件；成功必须使下游成果失效并保留历史副本。
- 方案确认到生成期间的转录变化、源变化、重复点击不能成功使用旧方案。
- 长句和多行字幕必须在可读限制内分图，不截断末尾或悄悄遗漏句子。

## Task 1: 转录时间与质量检查

Files: `src/lib/asr.ts`、`src/lib/asr.test.ts`、新增 `src/lib/transcript-quality.ts` 及测试。

Interfaces: `inspectTranscriptQuality({segments,text?,duration?}): string[]`，segments 使用现有 `TranscriptSegment`；空数组表示未检测到规则异常，不代表人工准确性验证。

- [x] 先补毫秒偏移、秒数、字符串、非法时间、循环及正常复读回归，运行确认失败。
- [x] 按字段单位解析，质量检查检测长循环、句内循环、倒序和越界；异常抛出明确错误。
- [x] 对真实多样本测试 `-mc 0`；采用经过验证的参数，保留识别局限说明。
- [x] 运行 ASR 与质量专项测试，记录结果。

## Task 2: 历史重转录闭环

Files: `src/lib/jobs.ts` 及测试、`src/types.ts`；HTTP 与前端整合由 Task 4 完成。

Interfaces: `JobStore.retranscribe(id: string): Promise<JobRecord>`；使用 Task 1 检查函数。已有 transcript 附加可选 `qualityIssues: string[]` 供只读诊断。

- [x] 先补成功切换、失败保留、下游失效、运行互斥和旧异常阻断洗稿用例，确认失败。
- [x] 受控重转录复用原媒体，在替换前备份旧转录；原子保存，通过后清空下游有效指针，保留物理历史成果。
- [x] 普通成功步骤仍拒绝重复触发，重转录失败标记失败并允许修复重试。
- [x] 运行 jobs 专项，记录结果。

## Task 3: 图集方案与媒体

Files: `src/lib/gallery-types.ts`、`src/lib/galleries.ts`、`src/lib/gallery-routes.ts`、`src/lib/gallery-media.ts` 及测试；新增独立 `gallery-planner.ts` 及测试。

Interfaces: `Gallery.plan?: GalleryPlan`；plan 有 `id`、`transcriptHash`、`sourceFingerprint`、`images: {title, quotes: {segmentIndex,text,start,end}[], image: GalleryImage}[]`、`warnings: string[]`、`excluded: {segmentIndex,reason}[]`。`POST /:id/plan` body `{version, targetLines?:6|7|8|9, bandTop?,bandBottom?}` 回 `{gallery}`。`POST /:id/plan/render` body `{version,planId,subtitlesConfirmed:true}` 回 `{gallery}`。

- [x] 先补 32 条分组、长句分组、无字幕、9 条、失效方案、确认版本、失败保留和发布包兼容测试，确认失败。
- [x] 使用 Task 1 阻断异常输入；完整句按时间顺序组织，语义标点及长间隔辅助断组，不编造台词，不依赖 AI 可用。
- [x] FFmpeg 提取附近多个候选，比较字幕区像素和稳定性，建议统一字幕区域；没有可靠候选明确排除并展示原因，人工整套确认是生成前提。
- [x] 方案持久化，规划不覆盖已有图片；确认在锁内校验指纹后应用并开始生成，成功回写前再次校验。
- [x] 放宽 1～9 条、按真实字幕比例保证空间，长字幕自动减少条数并增加图片，不改变图像像素文字。
- [x] 运行图集专项及真实 FFmpeg 回归，记录结果。

## Task 4: 页面与共用接入

Files: `src/app.ts`、`renderer/src/services/api.ts`、`renderer/src/types/index.ts`、`GalleryDetailPage.tsx`、`GalleriesPage.tsx`、`JobDetailPage.tsx`、`TranscriptArtifact.tsx` 及必要测试、隔离验收脚本。

- [x] 先补 API 契约及核心页面行为测试，确认失败。
- [x] 注册 `POST /api/jobs/:id/retranscribe`；raw-transcript 只读返回诊断，页面给异常提示和受控重转录按钮，不覆盖失败输入。
- [x] 工作台首屏显示方案、条数选择、候选字幕预览和一次确认生成；现有秒数编辑折叠为高级调整。
- [x] 允许整套校准和局部分图、合图、换句；未保存编辑禁用覆盖性规划，保持导航保护与成品恢复。
- [x] 隔离浏览器验收桌面和窄屏，包括失败与刷新恢复。

## Task 5: 集成验证与复核

- [x] 专项、全量 `npm test`、`npm run check`、对应 build、`git diff --check`。
- [x] 独立复核本次 diff 的输入、版本、并发、备份与发布边界，修复重要发现。
- [x] 更新规格和 AGENTS 的实际行为及验收记录；编译后以隔离运行验证，不写真实用户数据。

## 实施记录

- 2026-10-09：用户认可规格并授权实施；内部规格和计划复核由代理执行。
- Ruling：沿用原生字幕模式，规则分句分组不改写文字；自动像素检测只提供候选，生成要求整套字幕确认，因为无 OCR 时无法证明画面文字内容。
- Ruling：保留当前工作目录，已有不同功能改动；不建立丢失这些改动的新 checkout，不自动提交整个目录。
- Pre-flight：ASR/历史域与图集域只共享 `inspectTranscriptQuality` 契约，文件写入分离；主代理负责 HTTP、前端与集成。
- 转录和历史专项 53 项通过。只读扫描检出原有六份异常，没有迁移真实记录。
- 图集方案、候选整套预览、显式确认、最终图片与预览哈希一致均已实施；宽屏细字幕采用 720 采样、底部文字区优先及文字边缘稳定性比较，16 项图集专项通过；真实样本候选 2/15 提升到 8/15，仍有横幅误选和漏检，整套核对要求保留。
- 隔离端到端通过 32 段→4 张→确认生成→发布预览→重转录→旧图预览拒绝；375px 无横向溢出，未保存编辑禁用重规划并保护离开。
- 独立复核发现并补齐：损坏 JSON 重试归档、持久事务中断恢复、原子写临时文件恢复、保留垃圾桶操作、事务结束前永久删除互斥、长尾段时间插值。
- Ruling：重转录采用先写恢复记录再切换文件的事务；重启恢复完成前不暴露混合成果。已有发布包不变。
- Ruling：规则检测只拒绝严重循环和非法时间，不宣称内容经过人工验证；原生字幕候选仍需整套核对。

- 最终候选稳定性按文字边缘匹配，变化背景回归先失败后通过；真实对白候选已人工查看。仍保留无 OCR、横幅误选、早期漏检和长句插值的边界。
- 最终构建浏览器刷新恢复四张方案与候选，375px 无横向溢出；对应隔离服务与浏览器已关闭。

- 最终相同全量文件集限制并发为 4：1204 通过、1 跳过、0 失败；门禁、前后端构建、隔离 FFmpeg/API 和 diff 检查通过。默认高并发遇到的无关 HTTP 连接重置，单项及完整应用 88 项复测通过，已在验收记录披露。
