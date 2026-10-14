# 中文图集短字幕排版 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; steps use checkbox syntax.

**Goal:** 相邻短字幕仅在中文图集排版层合并，原始内容与时间完整保留，验证后重启。

**Architecture:** 在既有 `planTranslatedGallery` 内建立带原 cue 列表的排版组。预计张数与图片渲染继续消费该规划器；预览区区分排版条与原字幕。

**Tech Stack:** TypeScript、React、既有 FFmpeg/Chromium 渲染。

**Spec:** `docs/superpowers/specs/2026-10-14-gallery-short-caption-layout-design.md`

## Global Constraints

间隔 ≤1.5 秒、跨度 ≤6 秒、合并文字 ≤26 Unicode 字符；不跨取消选择的编号、句末边界，不删改任何原 cue。共享脏工作区仅修改本次文件，不提交、不推送、不自动修改真实图集。

## Review Focus

长句、句末标点、多行字幕不得误合；内容选择缺口不得跨越；覆盖统计保持全部原编号；旧方案仍可查看；代表帧必须来自原 cue 时间且预览与最终一致。

## Task 1: 排版与预览

**Files:** `src/lib/gallery-translation.ts`、相关测试、`renderer/src/components/GalleryPlanPanel.tsx` 及测试。

**Interfaces:** `planTranslatedGallery` 签名与 `GalleryPlan` 类型不变；`quotes` 保留所有原 cue，`image.translatedCaptions/times` 为排版组。

- [x] 写短句合并、来源保留、边界与预估一致及预览回归，运行观察失败。
- [x] 实现排版组及预览展示，运行相关图集回归和真实译文只读验收。
- [x] 验收真实 PNG 尺寸、文字溢出保护与预览/最终一致，类型检查、全量回归、复核差异。
- [x] 编译并重启，报告结果及未验证范围。

## 内部复核

规格与计划一致。用户已授权内部复核直接继续。保留共享工作区是为沿用已完成未提交功能及现有运行配置；不创建隔离分支或提交。原句列表和排版组独立，覆盖计数无需更改。

## 验收记录

- 新增 4 项回归先失败后通过；长句、句末、换行、选择缺口、间隔、宽度和跨度均覆盖。
- 独立只读复核发现句点及直引号/多层闭合符号遗漏，已以失败回归复现后补齐；其余未发现本次引入的缺陷。
- 真实 434 条译文保留全部原句/原文/编号/精确时间，合并为 221 排版条、28 张；预计张数与规划一致，真实草稿版本和译文未修改。
- 真实首张渲染 1080×1440，预览与最终 PNG 字节一致，哈希 `f90f4bb9db470224c7c5196cd51ff4b5305226d066103b9f05ece5b678779b8d`，已查看图片。
- `npm run check` 通过，最终后端/前端类型检查及后端/前端构建通过；Vite 既有包体警告未扩大范围处理。
- 全量回归分组执行：排除单独运行的既有图集 HTTP 用例后，1530 项中 1527 通过、3 跳过。该 HTTP 用例的测试服务器空闲超时仅 200ms，独立复跑曾通过，最终复跑仍在创建图集阶段断连并进入清理；此阶段没有本次变更，记录为既有测试时限波动，不修改产品或测试超时，不宣称完整套件稳定通过。此前一次资产删除并发失败已独立复跑通过。
- 已编译并通过 `npm run dev` 重启；未自动翻译、重新规划或生成真实图集，未调用真实 AI 或平台发布。整套 28 张的人工语义/画面核对留给用户重新规划时完成。
