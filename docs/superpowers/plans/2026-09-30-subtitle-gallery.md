# Subtitle Gallery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session, task by task. 用户已确认规格并要求执行开发，不再次等待流程选择。

**Goal:** 原视频独立生成可恢复的字幕图集，并建成抖音图文发布包。
**Architecture:** GalleryService 管理本地 JSON 草稿与版本；GalleryMedia 使用既有 FFmpeg/FFprobe。图集路由绑定服务端产物，PublishingService 复用现有 note 打包与预览/提交。
**Tech Stack:** TypeScript、Express、React、FFmpeg；不新增运行依赖。
**Spec:** docs/superpowers/specs/2026-09-30-subtitle-gallery-design.md

## Global Constraints

- 原生字幕来自画面；不绘制转录文字。
- 1080×1440 PNG，1～6 条字幕，默认 4 条；独立于洗稿和成片。
- 保留权限、预览版本、原视频安全解析和已提交不等于已发布的约束。
- 不真实发布、不改用户配置；保留当前未提交的微信公众号工作，不提交或推送混合改动。

## Review Focus

- 帧时间/边界越界、视频旋转：媒体测试验证拒绝和实际尺寸。
- 渲染中保存/调序、失败及重启：服务测试验证互斥和旧图不可建包。
- 源文件替换或产物被修改：服务测试验证指纹与图片哈希。
- 只有转录无成片：集成测试验证真实建包和包级预览。
- 窄屏导航、选句校准与刷新恢复：前端测试与本地浏览器走查。

### Task 1: 原生拼图媒体内核

**Files:** src/lib/gallery-types.ts、gallery-media.ts、gallery-media.test.ts。
**Interfaces:** GalleryImage {mainTime,times,bandTop,bandBottom,mainFraction,mainCrop?}; GalleryMedia.probe(path)、frame(path,time)、render(path,image,outPath)。
- [x] 编写非法时间/边界与真实带字幕测试，运行看到缺少模块失败。
- [x] 使用 runCommand，实际 FFmpeg 抽帧、crop/scale/pad/vstack；验证非空 PNG、尺寸和字幕来源。
- [x] 运行 `node --import tsx --test src/lib/gallery-media.test.ts`，预期全部通过。

### Task 2: 草稿与渲染版本

**Files:** src/lib/galleries.ts、galleries.test.ts。
**Interfaces:** GalleryService.create/get/list/update/remove/frame/render/preview/createPackage；读取 JobStore 的 get，复用 resolveSourceVideo 与 LocalStorage。
- [x] 编写恢复、版本冲突、源变化、并发、失败、图片篡改用例并跑红。
- [x] 实现原子索引、串行修改与渲染互斥；生成版本发布前验证源指纹/图片哈希。
- [x] 运行 `node --import tsx --test src/lib/galleries.test.ts`，预期全部通过。

### Task 3: 受控图文建包与路由

**Files:** src/lib/publishing-service.ts、gallery-routes.ts、src/app.ts、gallery-routes.test.ts。
**Interfaces:** PublishingService.createGalleryNote({sourceJobId,title,noteCopy,sourceImagePaths,expectedImageHashes},actor)，路径只能由图集服务提供；registerGalleryRoutes(app,{galleries,sessions})。
- [x] 编写无洗稿/成片的真实建包、未授权请求、旧预览及假 sau 分派用例并跑红。
- [x] 按服务器生成版本建包，复用 createNotePackage 与 validateNoteCopy；注册 API 与错误边界。
- [x] 运行图集/现有发布集成测试，预期通过且 task.status 不变。

### Task 4: 独立创作工作台

**Files:** renderer/src/pages/GalleriesPage.tsx、GalleryDetailPage.tsx、services/api.ts、App.tsx、shell/navigation.ts 与测试、SourceVideoArtifact.tsx。
**Interfaces:** /galleries 与 /galleries/:id；API 方法 mirror Task 2/3；作品入口 /galleries?sourceJobId=…。
- [x] 导航/图序编辑测试先红；添加原视频快捷入口。
- [x] 列表创建/删除，转录选句和候选帧，时间/边界校准，1～6字幕、多图移动/复制、草稿保存、生成、预览和建包。
- [x] 保持现有颜色/字体与 shell；使用 3:4 成品画布作为工作台主体，紧凑字幕条为特征，不新增视觉依赖。
- [x] 前端专项通过，浏览器验证刷新恢复、错误提示与窄屏。

### Task 5: 回归与交付

**Files:** 本计划、AGENTS.md/CLAUDE.md、docs/worklog.md。
- [x] 独立代码审查，修复重要问题并补红绿测试。
- [x] `npm test`、`npm run check`、`npm run build`、`git diff --check`；记录实际结果。
- [x] 重启本任务启动的开发实例并检查 health，真实桌面验收；不触发真实发布。

## 执行记录

- Ruling: 在当前 codex/wechat-drafts 分支保留所有既有未提交改动执行，避免新 worktree 丢失已接通的公众号代码；不自动 commit/push。
- Ruling: 用户明确授权执行，采用本会话执行；计划不增加第二次审批关卡。
- 2026-09-30：Tasks 1–5 完成。TDD 后补独立审查发现的路径替换、图片副本变更、旧编辑器预览、保留 mtime 的源变化回归；对应红绿验证通过。原生模式按比例保留画面/字幕，旋转及六字幕真实 FFmpeg 测试通过。
- Final verification: `npm test` 1005 项 / 1004 pass / 1 skip / 0 fail（220146ms）；`npm run check`、`npm run build`、`git diff --check` 通过。构建仅保留既有大 chunk 提示，无编译错误。
- Browser QA: 隔离合成原视频，两图草稿/生成/刷新恢复/图集与包级预览通过；375px 无横向溢出，移动更多导航/浏览器返回拦截未保存改动。既有带字幕横屏视频在私有临时副本上生成并逐图查看；真实竖屏素材与真实提交待用户验收。
- Desktop: Vite 5173、Electron 内嵌 API 63127；健康检查与图集列表 200，原生窗口已打开「图集创作」。验收数据不写入用户实际 storage，不调用真实发布，不改公众号凭据。
