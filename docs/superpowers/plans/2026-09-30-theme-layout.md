# 热榜与主题 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session. Steps use checkbox syntax.

**Goal:** 修复热点大块留白、提供可持久化外观选择、恢复重启丢失的 sau 路径。
**Architecture:** 原生多列 CSS；Zustand 主题状态驱动根元素，复用 app.theme/IPC；Electron sau 配置透传加持久化回退。
**Tech Stack:** React、Tailwind、Zustand、Node，零新依赖。
**Spec:** docs/superpowers/specs/2026-09-30-theme-layout-design.md

## Global Constraints

- 深色/浅色/跟随系统；旧安装首次保持深色，不改凭据，不自动发布、不提交/推送。
- 主题文字 ≥4.5、交互边界 ≥3；媒体区域保持可读；多列卡片不可拆分。

## Review Focus

- 系统变化不得覆盖手动主题；初始化/保存错误不得假装持久化成功。
- 浅色状态按钮和图片蒙版上的文字必须可读。
- 多列遇到长标题、奇数卡片及窄屏不留整行空洞、不拆卡。
- sau 环境与配置冲突时不能覆盖已保存值；不读取 Cookie 或测试发布。
- 设置页 file/hash 深链必须可达外观分组。

### Task 1: 主题及排版

**Files:** renderer/src/store/theme.ts 与测试、index.css、main.tsx、shell/ThemeSwitcher.tsx 与测试、UtilityBar.tsx、SettingsPage.tsx、HotspotsPage.tsx、ContentPreview.tsx 与测试。
**Interfaces:** initializeTheme(window): Promise<() => void>; useThemeStore.preference/error/setPreference；根元素 data-theme 为实际 dark/light。
- [x] 主题初始化/系统变化/手动覆盖/保存失败与浅色对比度 RED；浏览器几何断言复现排版 RED。
- [x] 按用户追加指示改为顶部直接选择主题、媒体文字令牌/完整遮罩、多列布局，专项 GREEN 与浏览器选择/重载/系统模拟/窄屏验证。

### Task 2: sau 恢复与集成

**Files:** electron/utils/sau-config.ts 与测试、electron/preload.ts、electron/server.ts。
**Interfaces:** resolveSauConfig(config,env) 与 sauConfigToRemember(config,resolved)；缺失路径才补齐。
- [x] 显式环境优先、空白回退及完整首次配置持久化 RED→GREEN。
- [x] check/build/full tests/diff-check，独立复核；正常重启已配置路径，健康与运行状态只读验收；更新项目记忆。

## 执行记录

- Ruling: 在现有 codex/wechat-drafts 脏工作区继续，不创建缺少热点/图集的新 checkout，不自动提交；用户已确认主题设计并要求直接修复，文档忠实记录，不增加二次审批。
- Ruling: 保留既有 app.theme 为桌面真源，加首次选择标记以避免未生效的旧默认 system 意外改变用户深色界面；浏览器仅用本地偏好，不桥接或暴露凭据。
- 用户追加：移除新建外观页，统一顶部 ThemeSwitcher，桌面与移动端同一 store；普通设置分组改为 URL 真源，后续 query/hash 导航也同步。不再把 appearance 作为分组深链。
- 独立复核 Important 两项：可选 sau 保存失败会阻止启动、图片弱遮罩不保证对比度，均补 RED→GREEN。说明文字透明度虽标 Minor，实际违反 4.5 硬要求，去掉额外透明度；分组 query 初始化单次的问题用 URL 真源消除。媒体/保存失败/主题组件专项 5 项通过。
- Ruling: 已有部分 sau 配置也不混补首次环境配对，避免持久化不一致路径；本机完整首次配置经启动记住，再次显式移除 SAU_* 环境变量重启仍可读取。抖音状态由 blocked 变 degraded（凭据存在、有效性未知），未验证账号或发布。
- 浏览器验收：长标题列内间隔 RED=920px → GREEN=20px；顶部主题切换/重载、系统模拟与手动覆盖、376px 无溢出及键盘焦点 RED→GREEN。模拟 UI 使用隔离存储；设置页说明透明度及 query 后续导航已在浏览器验收，但相应 RED 命令与 HMR 同时执行，没有声称它们留下有效 RED。
- Declined-to-judge 的几何/原生控件/UI/构建/真实 sau 均由主代理分别验证；不制作安装包，不测试真实发布。初轮全量 1031 通过/1 跳过；顶部改动后正在最终全量回归。
- 最终全量 1034 通过 / 1 跳过 / 0 失败；check/build/diff-check 通过。右上角主题浏览器桌面/窄屏验收与实际桌面偏好保存（light + themeConfigured）通过。独立复核问题均处理，未提交/推送或真实发布。
