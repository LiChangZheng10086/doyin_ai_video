# 热点到微信公众号文章实施计划

> **For agentic workers:** 使用 superpowers:executing-plans 在本会话原生实施；规格和计划复核按用户偏好由代理完成，末尾进行独立审查。

**Goal:** 从已有热榜或关键词创建独立文章，完成资料整理、分阶段成文、审校、配图规划及公众号文章包。
**Architecture:** Express + 单份原子 JSON 创作索引。公网 HTTPS 资料读取与结构化 AI 输出在后端校验，React 工作台逐步操作，复用微信文章包与草稿提交。
**Tech Stack:** Node、TypeScript、Express、React、现有 OpenAI SDK；不增加运行时依赖。
**Spec:** docs/superpowers/specs/2026-09-30-hotspot-wechat-writing-design.md

## Global Constraints

- 一篇最多 10 份资料，每批最多读取 3 个网页，每请求 15 秒、2 MiB；网页摘录 20000 字符，补充文字 30000 字符。
- 所有修改带 version；每篇一次运行一个步骤，上游变化使下游失效，失败保留参考稿。
- 热榜线索不是正文证据；无正文不能成文，错误引用不能提交。外部材料是数据，不是指令。
- 不要求视频任务、成片、搜索 Key、NotebookLM 或生图服务；仅人工触发微信草稿。
- 使用活动 AI 配置、AssetStore 和现有微信包／预览／提交真源，存量 job 包兼容。
- 保留当前非主分支和其它在途改动；本轮源码暂留工作区，不将其他任务改动混入提交。文档与最终验证记录可单独提交。

## Review Focus

- 聚合页／搜索页／挑战页返回 HTTP 200：应显示需补资料，不能当正文。
- DNS 返回混合公网和内网地址、IPv6 特殊地址：不发起不安全请求，连接只能使用已校验地址。
- 用户编辑 AI 输出并换资料：旧稿仍可参考，但确认与发布预览失效。
- 修订稿可能改变事实或强度：保留原稿、差异与人工审阅，引用存在不等于事实已证实。
- 独立文章源删除或不含视频：发布包能独立预览，创建版本指向文章流程。

### Task 1: 有界公开网页资料读取

**Files:** Create src/lib/article-sources.ts、src/lib/article-sources.test.ts。
**Interfaces:** `readArticleSource(url): Promise<ArticleSourceRead>`；`extractArticlePage(html,url)` 返回标题、正文、日期与相关链接；`resolveArticleAddress(url,lookup)` 校验且返回固定公网地址。
- [ ] RED：正文元数据与 article/main、搜索页候选、脚本和导航排除；HTTPS／IP／私网／混合 DNS／超限和超时检查。
- [ ] 实现 Node HTTPS 固定 DNS 地址请求、正文和候选链接提取；无需平台登录态。
- [ ] GREEN：node --import tsx --test src/lib/article-sources.test.ts，全部通过。

### Task 2: 结构化写作和文章状态

**Files:** Create src/lib/article-writing.ts、src/lib/articles.ts、src/lib/article-types.ts 及对应测试。
**Interfaces:** `ArticleWritingService.run(step,article)`；`ArticleService.create/get/list/update/run/readSources/remove/preview/createPackage`，复用 LocalStorage、活动 AI 配置和 Task 1 读取器。
- [ ] RED：选题恰好三份、事实摘录属于来源、来源关联、坏输出明确失败；保存冲突、资料不足、下游失效、失败保留和重启恢复。
- [ ] 实现 diagnose／evidence／outline／draft／review／illustrations 六步；每步严格校验输出，JSON 提示词区分材料和指令。
- [ ] 实现单份 cache/articles.json 串行原子落盘、版本与运行状态；预览与建包绑定当前稿件和素材哈希。
- [ ] GREEN：node --import tsx --test src/lib/article-writing.test.ts src/lib/articles.test.ts。

### Task 3: 独立文章 HTTP 与微信发布包

**Files:** Create src/lib/article-routes.ts、src/lib/article-routes.test.ts；Modify src/app.ts、src/types.ts、src/lib/publishing-service.ts、src/lib/publishing-store.ts、renderer/src/types/index.ts。
**Interfaces:** `/api/articles` GET/POST，`/:id` GET/PATCH/DELETE，`/:id/steps/:step` POST，`/:id/sources/read` POST，`/:id/publishing/preview` 与 `/packages` POST。写操作 requireActor。
- [ ] RED：无会话写入拒绝、版本冲突、独立无视频建包、旧预览拒绝、源删除不影响包，模拟微信草稿提交成功。
- [ ] 注册共用 app 路由；热点只接受服务端榜单／收藏身份；素材 ID 在 AssetStore 解析。
- [ ] 内部独立文章建包复用 createArticlePackage 和事务，标 sourceKind/article ID；包指纹覆盖文章及图片。存量包校验兼容，article 类型限制完整。
- [ ] GREEN：node --import tsx --test src/lib/article-routes.test.ts src/lib/publishing-service.test.ts src/lib/publishing-store.test.ts。

### Task 4: 独立文章工作台和热点入口

**Files:** Create renderer/src/pages/ArticlesPage.tsx、ArticleDetailPage.tsx；Modify api.ts、App.tsx、HotspotsPage.tsx、shell/navigation.ts、PublishingPage.tsx；必要的前端 API／导航检查。
**Interfaces:** React 使用后端 ArticleRecord 与 ArticlePreview 类型，apiClient 提供上述 HTTP 方法。
- [ ] RED：导航文章匹配、API 会话与版本传递；独立文章创建版本动作进入文章工作台而不是视频接口。
- [ ] 构建主题令牌驱动的文章列表、六步工作区、材料／事实／提纲／正文编辑、初稿与修订对照、选图／预览；恢复草稿和未保存离开保护。
- [ ] 热榜和收藏新增以此创作；移动入口进入更多。发布来源显示按 sourceKind 判定。
- [ ] GREEN：前端相关测试与 npm run check:renderer；实际浏览器验证编辑、错误保留、跨阶段失效及建包。

### Task 5: 整体验证与独立审查

**Files:** Create scripts/verify-article-writing.ts；Update 本计划执行记录与 AGENTS.md 本功能段（只追加本轮约定）。
- [ ] 隔离假资料／AI／素材跑端到端工作台，公开真实来源只读核验五种平台链接的成功或需补资料状态，不写用户真实数据。
- [ ] npm test、npm run check、npm run build 与 git diff --check；记录真实输出，修复本轮问题。
- [ ] 独立 reviewer 复核本轮文件及新增差异，重要问题补 RED/GREEN 修复。
- [ ] 写明已实现功能、测试证据、网页可读性和真实微信账号验收边界；清理本轮临时资源。

## 自审与执行记录

- 计划与规格数据类型／限额／发布语义已对齐。资料解析与 AI 不合格输出各有明确失败路径，未用标题、模型自评分或假正文补全来通过门禁。
- Ruling: 当前分支 codex/wechat-drafts 带有相关素材功能的在途改动；用户要求在共用工作区推进，采用原位最小追加并保存基线，不新建遗漏在途能力的 checkout。
- Ruling: 用户已授权执行与自行复核，计划复核完成后直接开发，不重复请求相同范围的批准。

### 当前验证证据

- 新增文章模块、HTTP 与导航相关35项测试通过；前端 API/导航17项通过。全量回归1076项通过、1项跳过（后续资料编辑/URL验证由追加特性测试覆盖）。
- `npm run check` 通过（后端、前端、凭据扫描754文件）；`npm run build` 三套产物及 mark-cjs 通过。
- 隔离浏览器已验证保存503不丢输入、重试、六步生成、人工确认、封面+正文图预览、建包及公众号渠道可见；390px手机无横向页面溢出。修正过公众号渠道URL为已有真源ID `wechat-mp`。
- 五平台真实热榜首条公开链接均返回需要补材料，未伪造正文；不支持自动全网检索，用户需提供可访问报道/原文。真实微信账号未调用，草稿提交仅模拟。

### 最终收尾

- 独立审查7个问题全部修复；相关测试最新44项通过，类型/凭据检查与三套构建通过，隔离浏览器验收完成。
- 共享工作区曾有暂态失败，针对性26项复测已通过。最后整套运行在会话中断后悬挂超过2小时，已停止本轮进程，未取得最终汇总；不得把此前1076通过/1跳过或特性测试通过描述为最终全量通过。
- 详情与代理决策见 `docs/research/2026-09-30-hotspot-wechat-writing-verification.md`。源码保留当前工作区，不混提交其他工作。

### 2026-10-08 续验收尾

- 当前主分支 `d2181cc` 全量 `npm test` 完成：1119通过、1跳过、0失败、0取消，242秒，退出码0；此前最终全量验证缺口已补齐。
- `npm run check`（凭据扫描783文件）、`npm run build` 三套产物及 mark-cjs、`git diff --check` 全部通过。旧公众号超时用例单独及全量复测通过，旧小红书失败未复现；没有推测性代码修改。
- 实施与本地验收已完成。真实微信账号草稿及用户后台确认仍为独立验收边界，本轮未触发实际提交。
