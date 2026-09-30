# 公众号对标与模板实施计划

> **For agentic workers:** Use superpowers:executing-plans to implement inline. 用户已认可方向并委托代理完成内部复核。

**Goal:** 用户自由选赛道，发现并核验至少 10 个对标账号，复用参考信息与模板创作文章。

**Architecture:** 独立对标索引与路由；现有文章服务接受对标引用与模板。关键词搜索复用公开网页读取安全边界，HTML 仅做文本解析。

**Tech Stack:** TypeScript、Express、React、LocalStorage、cheerio 1.0.0。

**Spec:** `docs/superpowers/specs/2026-09-30-wechat-benchmarks-design.md`

## Global Constraints

- 赛道和受众自由填写；阅读门槛初始 1000、可调。
- 每组最多 10 个关键词、100 个账号、每账号最多 20 个样本。
- 搜索一次一个关键词，最多 50 条文章，10 分钟缓存、请求至少相隔 60 秒。
- 未知阅读量为空；数字必须有来源与观察时间；10万+保留下界。
- 不读取平台 Cookie，不绕验证码，不正式发布；所有写入带会话与 version。
- 共用现有文章、素材、草稿发送与预览机制；旧记录默认原有样式。

## Review Focus

- 昵称相同但身份不同不得自动计为已确认账号；重复 biz 拒绝。
- 下界、缺少数据与空样本不得被渲染成精确数字或有效对标。
- 搜索失败不覆盖候选，不把空结果、验证码混为有结果。
- 模板变更与旧记录兼容，既有图片和正文安全规则不弱化。
- 失败保存与旧版本响应保留编辑输入，不误用旧选中组。

### Task 1: 模板与公开检索

**Files:** `src/lib/wechat-templates.ts`、`wechat-search.ts`、对应测试；修改 `wechat-article.ts`、`article-sources.ts`；MIT 归属记录放 `docs/third-party/`。

**Interfaces:** 模板常量 `WECHAT_LAYOUTS`、`WRITING_STRUCTURES`；`renderWechatArticleHtml(draft,{layoutTemplate?,images?})`；`searchWechatArticles(keyword)` 返回结构化标题/账号名/HTTPS 链接/发布时间，无阅读数据。

- [x] 写并运行模板安全、旧默认、未知模板与搜狗解析/挑战页面测试，确认失败。
- [x] 增加受限配置与文本解析；导出共用 `downloadArticleHtml`，保留 DNS 固定、超时和大小限制。
- [x] 验证上述测试与现有渲染/来源测试。

### Task 2: 对标存储、核验与文章接入

**Files:** `wechat-benchmarks.ts`、`wechat-benchmark-routes.ts`、对应测试；修改 `article-types.ts`、`articles.ts`、`app.ts`。

**Interfaces:** `WechatBenchmarkService` 提供 list/create/update/remove/search/forArticle；`benchmarkAssessment(group)` 返回选中/有效数量及每账号数据；文章 create 可接 `benchmarkId`，update 可接 `layoutTemplate`。

- [x] 测试空数据、缺失证据、下界、重复身份、冲突、损坏索引、搜索缓存与失败；测试不足/达到 10 个的文章参考生成。
- [x] 实现受限持久化与服务端核验、本机会话路由，接入文章创建与排版预览。
- [x] 验证服务/路由与现有文章回归。

### Task 3: 对标与模板界面

**Files:** `renderer/src/pages/WechatBenchmarksPage.tsx`、`components/ArticleTemplatePicker.tsx`；修改 App、ArticlesPage、ArticleDetailPage、api。

**Interfaces:** 页面使用 `/api/wechat-benchmarks` 与服务端核验结果；模板选项导入纯配置，所有保存沿用版本校验。

- [x] 完成组创建、关键词搜索、候选添加/编辑、样本证据、阅读门槛、比较与文章启动入口。
- [x] 工作台添加写作结构与排版选择，保留未保存保护和预览失效机制。
- [x] 用隔离 API 数据检查桌面/窄屏、失败编辑恢复和门槛不足提示；执行类型/凭据检查、针对性测试，编译后端与 Electron 产物。
- [x] 完成独立代码审查，修复影响用户流程的发现，记录验收结果。
