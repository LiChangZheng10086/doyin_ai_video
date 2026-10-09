# 字幕图集配套文案 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 在当前会话实施。

**Goal:** 自动创作整套图片与文案，文案修改和重生成保留图片。
**Architecture:** gallery-copy.ts 复用 OpenAI兼容SDK、AI消息解析及图文政策；GalleryService 负责完整来源、版本、输入哈希、独立保存与失败保留；现有页面添加文案生成、替换确认和字数。
**Tech Stack:** TypeScript、React、已有OpenAI SDK和Node测试。
**Spec:** `docs/superpowers/specs/2026-10-09-gallery-copy.md`

## Global Constraints

完整转录输入；原生字幕不重绘；标题20/正文1000/话题10×20；最多三次AI尝试；无新依赖、不发布、不推送。

## Review Focus

- 末尾核心观点须进入输入，超大输入明确失败，不默默截断。
- 识别错字、金额和身份不确定，生成仍须人工核对。
- AI超长或失败须保留现有手写文案和图片预览。
- 图片编辑、转录或来源变化继续使旧输出失效。
- 单改文案不可清除自动方案，发布预览须使用最新文案版本。

### Task 1: AI成文

Files: `src/lib/gallery-copy.ts` 和测试。Interfaces: `GalleryCopyWriter.write({transcript,nativeSubtitles}): Promise<{title,description,hashtags,notes}>`。
- [x] 先写并观察失败测试：完整来源、结构提示、限额重试、空输出/截断响应、来源身份和运营承诺规则。
- [x] 实现限额校验、最多三次成文、错误提示，复用现有配置与SDK。

### Task 2: 图集及API

Files: `gallery-types.ts`、`galleries.ts`、`gallery-routes.ts`、`app.ts` 和测试。Interfaces: `generateCopy(id,version)`、`POST /api/galleries/:id/copy`。
- [x] 红→绿测试完整输入与空正文自动成文、已有正文保留、失败/冲突、仅改文案保持候选及已生成图片、旧文案输入失效。
- [x] 接入运行时配置、共享限额、完整来源与哈希检查；AI失败保留图片方案。

### Task 3: 页面与验收

Files: `renderer/src/services/api.ts`、`GalleryDetailPage.tsx`、现有gallery工具/测试与验证脚本。
- [x] 修改入口为自动创作整套图文，文案独立重生成/替换确认、服务端字数限制、错误/事实核对提示。
- [x] 专项、真实隔离API与浏览器、全量、check/build；独立只读审查，修复重要发现。
- [x] 重启应用，原图集生成配套文案并回读，保留未确认草稿；更新验收记录。

内部复核：任务覆盖规格与五类风险；复制图片与发布安全沿用原链路。

完成复核：独立审查发现全文优先问题，已修复；真实调用发现 DeepSeek 截断和未核实标题污染，均先复现后修复。最终全量1231通过、1跳过、0失败；专项17/17，check与完整构建通过。真实草稿version9、401字、5话题、图片方案保持不变；详见 `docs/research/2026-10-09-gallery-copy-verification.md`。
