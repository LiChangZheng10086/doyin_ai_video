# 原视频字幕条排版 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 在当前会话逐项执行。

**Goal:** 按用户参考图交付满宽主画面与带真实画面背景的连续字幕条。
**Architecture:** GalleryImage 用 filmstrip 标记绑定新布局；共用字幕条高度函数供 planner 与 GalleryMedia 使用；FFmpeg 拼接原视频背景和字幕像素。
**Tech Stack:** TypeScript、FFmpeg、现有 Node 测试。
**Spec:** `docs/superpowers/specs/2026-10-09-gallery-filmstrip-layout.md`

## Global Constraints

1080×1440；每条至少 96 像素，原生字幕带上下各至少 20；主画面至少 432；无新依赖、不重绘文字、不修改旧配置、不自动发布、不推送远程。

## Review Focus

- 黑色字幕留白仍须有同一帧真实画面背景。
- 换时间须换背景，不能全套重复一帧。
- 过高字幕须拆图，不能截字或挤压字形。
- 保存新自动草稿须保留 filmstrip 标记。
- 旧缓存预览哈希、旧 compact 和手动图不随新规则变化。

### Task 1: 排版及完整链路

Files: `src/lib/gallery-media.ts`、`gallery-types.ts`、`gallery-planner.ts`、`galleries.ts` 与相应测试。
Interfaces: `filmstrip?: boolean`；共用字幕条高度；保留现有 render、plan 和 update 接口。

- [x] 写并运行真实 FFmpeg 红蓝两帧背景与字幕像素测试，观察旧排版失败；补规划标记和保存回读断言。
- [x] 实现新标记校验/持久化、共享高度、满宽主图和各时间背景字幕条；旧渲染分支保持原值。
- [x] 专项与全量测试、check、构建，修复失败。
- [x] 重启，按原图集 version 重新规划并检查首末预览；更新验收记录，保留未确认草稿。

内部复核：以上覆盖全部规格及五类风险；直接复用取景与确认流程，无需增加控件。

执行记录：RED→GREEN 已验证；专项 27/27、最终全量 1224 通过/1 跳过、check/build 与隔离 API/FFmpeg 验收通过。独立审查发现的旧缓存低覆盖绕过已修复并复审通过；原图集新方案 version 5 保持未确认草稿。未提交或推送远程。
