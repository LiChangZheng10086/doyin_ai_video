# 小红书可见草稿入口 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 在当前会话内执行。

**Goal:** 小红书任务提供直接可见的“查看本地草稿”按钮。

**Architecture:** 复用现有 `openXhsDraftWindow` API 和专用 profile；新增独立的只读任务动作。已打开的草稿窗口再次查看时调用 `bringToFront`，不创建第二个浏览器。

**Tech Stack:** React、TypeScript、现有 Playwright。

**Spec:** 用户 2026-10-08 提供的发布卡片截图和按钮要求；`docs/superpowers/specs/2026-09-20-xiaohongshu-note-publish-design.md` 的 2026-10-08 补充。

## Global Constraints

- 所有小红书图文和视频任务都提供入口；不受自动发布前置条件影响。
- 非小红书任务和垃圾桶不增加入口。
- 使用文字按钮，保留操作忙碌时禁用与错误提示。
- 复用应用的专用浏览器目录，不触发填稿或发布。

## Review Focus

- 视频包不能仅保留系统浏览器外链。
- 未成功保存或已取消的任务仍可查看本地草稿。
- 再次点击应唤起原窗口，不能争用 profile。
- 垃圾桶和其他平台不出现错误入口。
- 窗口打开失败必须显示 API 原因。

## Task 1: 可见入口与窗口唤起

- [x] `renderer/src/utils/publishing.ts` 添加只读动作，覆盖小红书全部任务状态。
- [x] `renderer/src/pages/PublishingPage.tsx` 渲染文字并复用现有 API、忙碌/错误处理。
- [x] `src/lib/xhs-runner.ts` 已有窗口调用 `bringToFront`。
- [x] 先观察回归断言失败，再实现；101 项相关回归通过。
- [x] check 与完整构建通过；桌面端重启后，在截图对应 v5 视频包实际点击查看，返回打开成功；第二次点击复用原窗口。

规格与计划已自行复核；用户明确要求此按钮，继续已授权实现。
