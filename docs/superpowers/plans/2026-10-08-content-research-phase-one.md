# 共用资料搜索与阅读第一期实施计划

> **For agentic workers:** 使用 `superpowers:executing-plans` 按任务实施。书面复核由代理完成。2026-10-08 已获用户实施授权，第一期代码与验收完成；真实Jina读取受本机网络限制，见文末实施记录。

**Goal:** 热点详情和文章资料区共用搜索／阅读能力，让用户选定真实报道正文后原子导入文章。

**Architecture:** Express 共用 ResearchService，复用现有有界公网读取，增加 Jina 与 Exa 托管 MCP 适配器；有界内存保存研究快照，已选正文进入现有文章持久化及引用链。React 共用取材面板，外部能力默认禁用，用户显式启用和触发。

**Tech Stack:** Node／TypeScript、Express、React、cheerio、官方 Node MCP SDK（版本在 Task 1 实测后精确锁定）。不增加 Python、全局 CLI 或数据库。

**Spec:** [接入规格与分期路线](../specs/2026-10-08-agent-reach-content-research-design.md)。第二期小红书与第三期视频／Skills 不在此执行计划中。

## Global Constraints

- 直接阅读 15 秒，Jina 最多 30 秒，单链接总截止 50 秒；搜索 30 秒，响应 2 MiB，正文 20000 字符，描述 1000 字符，候选最多 10 条。
- query 1～500 字符，搜索最多 5 条；文章最多 10 份，新导入每批 1～3 份。
- 搜索缓存 10 分钟，阅读快照 30 分钟，同键网络间隔 60 秒（失败也计），同操作者最多 3 个外部操作并发；每操作者快照最多 100 条，全服务最多 20 MiB。
- 外部能力默认禁用；Exa 匿名限额 MCP 固定端点且只调 web_search_exa，Jina 不转发登录态；不读个人 MCP 配置、不调用 agent_run。
- 写入／快照操作 requireActor；归属按操作者 userId；文章带 version，正文带 hash，导入原子且下游失效，快照丢失 410。
- 热榜摘要／搜索摘录／话题描述不进入正文证据；HTTP 成功不代表正文获取成功，不让 AI 补齐抓取结果。
- 外部链接安全检查与有界流式请求覆盖 HTML、Jina、MCP；纯文本显示，不加载外部图片／脚本。
- 保留旧文章、抖音四步、ASR、发布与素材契约，以及工作区其它未提交改动；每任务提交只包含本轮文件，是否提交遵从当次执行授权。

## Review Focus

1. 上游 HTTP 200 包含目标站 403／登录／验证码：必须 needs_material，不能导入。
2. 页面切换或迟到响应：热点 A 的内容不能覆盖 B，搜索失败与关闭不丢文章编辑。
3. 导入等待期间文章修改／运行、快照驱逐或 hash 改变：全部拒绝，不能半写或覆盖。
4. 代理服务与 MCP transport：实际网络截止、地址绑定和响应上限不能被 SDK 内部 fetch 绕开。
5. 已启用功能后改配置／重启：状态明确，禁用立即停止新的远端请求，文章里的已保存资料仍可用。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| 新增 `src/lib/research-types.ts` | 第一期开关、候选／搜索／阅读类型和错误 |
| 新增 `research-providers.ts`、`research-content.ts` | 外部固定端点及内容分类；各自独立测试 |
| 新增 `research-service.ts`、`research-routes.ts` | 限频／归属／快照及 HTTP；各自独立测试 |
| 修改 `article-sources.ts` | 共用 URL／DNS 与有界 transport 接口，保留旧读取函数 |
| 修改 `hotspots.ts`、`hotspot-routes.ts` | 可解析完整服务端条目快照，新增详情 |
| 修改 `articles.ts`、`article-types.ts`、`article-routes.ts` | 原子选材／创建与兼容阅读元信息 |
| 修改 `app.ts`、`src/server.ts`、`electron/server.ts` | 单实例装配、两运行入口配置注入 |
| 修改 `electron/preload.ts`、`handlers/config-handler.ts` | 非秘密开关字段；保持其它配置 |
| 新增 `renderer/src/components/ResearchPanel.tsx`、`HotspotDetailDialog.tsx` | 共用搜索／阅读／选择，以及热点元信息与新文章创建 |
| 新增 `renderer/src/components/ResearchSettingsPanel.tsx` | 两个开关与外部请求说明 |
| 修改 `HotspotsPage.tsx`、`ArticleDetailPage.tsx`、`SettingsPage.tsx`、`services/api.ts`、`utils/settingsSections.ts` | 入口、API、保存／冲突／状态；对应测试 |
| 新增 `scripts/verify-content-research.ts` | 隔离夹具／显式 live 探针，记录范围 |

以下 `research-*` 文件均位于 `src/lib/`。测试使用同目录 `.test.ts`；前端测试 `.test.tsx`。若配置类型同步还涉及 `renderer/src/types/index.ts`，只添加第一期字段。

## Task 1：锁定上游契约与有界传输（R3、R4、R7）

**Files:** 新增 research-types.ts、research-providers.ts、research-content.ts 及测试；修改 article-sources.ts／测试、package.json、package-lock.json；新增 scripts/verify-content-research.ts 的探针入口。

**Interfaces:** `ResearchConfig {jinaEnabled:boolean; exaEnabled:boolean}`；`ResearchProviders.search(query,signal): Promise<ResearchCandidate[]>`；`ResearchProviders.readJina(url,signal): Promise<Omit<ResearchReadResult,'readId'|'expiresAt'>>`；`parseResearchContent(input:{url:string;provider:'direct'|'jina';body:string;format:'html'|'markdown'}):` 同一阅读结果；`parseExaCandidates(result:unknown): ResearchCandidate[]`。

- [x] 编写失败用例：公开 article、头条 topic 与候选、知乎问题／登录／目标 403、200 字符的导航垃圾、非法链接、截断；断言 topic.text 为空且无法 readable。
- [x] 编写 transport 失败用例：2 MiB+1、混合 DNS、重定向、MCP/SSE 超限、超时关闭连接和取消读取；验证没有先缓冲完整超限响应。
- [x] `node --import tsx --test src/lib/research-content.test.ts src/lib/research-providers.test.ts src/lib/article-sources.test.ts`，确认新行为测试先失败。
- [x] 用临时目录只读探测 Jina／Exa 工具 schema 与输出；不登录、不读取个人配置。将成功、空结果、403、429、schema 变化响应脱敏成夹具；失败也记录真实原因。精确锁定经 Node／Electron 验证的 MCP SDK 版本。
- [x] 实现 URL/DNS 共用与有界 HTTP，MCP SDK 注入受控 fetch；固定端点仅开放搜索工具，解析异常返回 unsupported_format，服务端原始失败内容不泄露给用户。
- [x] 运行上述测试通过；检查 SDK 在后端 ESM 和 Electron 内嵌后端实际加载均可用，不只通过类型检查。

## Task 2：共用服务、缓存与 HTTP（R3、R4、R7）

**Files:** 新增 research-service.ts、research-routes.ts／测试；修改 app.ts。

**Interfaces:** `ResearchService.search(actorId,query)`、`read(actorId,input)`、`status()`、`resolveSelections(actorId,selections): Promise<ArticleSourceRead[]>`。input 为 `{url}` 或 `{searchId,candidateId}`；输出使用规格类型。构造依赖包含 `resolveConfig`、providers、直接读取器、now；可注入测试时钟与 HTTP 客户端。

- [x] RED：同键合并与失败限频、三并发上限、10／30分钟过期、100条／20MiB LRU、跨操作者隔离、重启 410；未启用不发请求，禁用后旧内存外部结果不再用于新读取；驱逐内容不清除60秒限频，有效已读快照仍可显式导入。
- [x] RED：路由无会话 401、参数 400、禁用 422、搜索异常 502／504、429 与 retryAfterSeconds、快照 410；阅读失败 200+needs_material 不混同网络搜索成功。
- [x] 运行 `node --import tsx --test src/lib/research-service.test.ts src/lib/research-routes.test.ts` 确认失败。
- [x] 实现服务与路由；直接读取→Jina 按需降级，复制结果而非暴露可变缓存；resolveSelections 一次解析 1～3 份正文并检查 hash、归属、过期，失败整批拒绝；映射 provider→readProvider、kind→sourceKind、candidates→links，保留精确正文/hash，解析不消费快照。app.ts 构造唯一实例。
- [x] 复跑 Task 1／2 测试通过，核对真正取消超时底层请求和客户端晚响应不会写入已失效快照。

## Task 3：两入口配置与设置（R9）

**Files:** 修改 src/server.ts、app.ts 的 ServerConfig、electron/server.ts、electron/preload.ts、electron/handlers/config-handler.ts、SettingsPage.tsx、settingsSections.ts／测试、services/api.ts；新增 ResearchSettingsPanel.tsx 及配置解析测试。

**Interfaces:** ServerConfig 注入 `resolveResearchConfig(): Promise<ResearchConfig>`；桌面 AppConfig 增加可选 research 字段，旧配置回落 false；独立端从两个 `RESEARCH_*_ENABLED` 环境变量解析，只接受 `1` 为开启。`GET /api/research/status` 不联网验证。

- [x] RED：缺省关闭、正确类型／非法值、桌面即时生效、更新其它配置不丢开关；HTTP 模式不能误写另一份配置冒充生效。
- [x] 运行配置测试和 `renderer/src/utils/settingsSections.test.ts` 确认新增断言失败。
- [x] 接入配置回调，桌面开关复用 IPC 保存，独立模式显示环境启动指引。精确文案：「启用 Jina 阅读：向该服务发送公开网页链接」「启用 Exa 搜索：向该服务发送搜索词，受免费限额约束」。保存失败提示未保存，不冒称已启用；状态未探测显示未验证。
- [x] 运行配置／API／设置测试及 `npm run check:backend`、`npm run check:renderer` 通过；mock 证明渲染设置或保存开关不触发外网。

## Task 4：热点解析与文章原子导入（R1、R2、R5、R6）

**Files:** 修改 hotspots.ts、hotspot-routes.ts、articles.ts、article-types.ts、article-routes.ts、app.ts 及对应测试。

**Interfaces:** `HotspotService.resolveDetail(sourceId,itemId): Promise<{item:HotspotItem;fetchedAt?:string}|undefined>` 共用现有榜单／收藏真源，不新抓榜；`ArticleService.importResearchSources(id,version,selections,actorId): Promise<ArticleRecord>`；create 增加可选 researchSelections 和 actorId，注入的 `resolveResearchSelections(actorId,selections): Promise<ArticleSourceRead[]>` 绑定 Task 2 `research.resolveSelections`。已有 readSources 使用兼容 reader，保留测试注入 config.readArticleSource 的优先级。

- [x] RED：详情只能引用服务端榜单或收藏，下榜收藏摘要保留，未知404；topic不能导入。article version/hash409、归属拒绝、快照410、重复URL／总数超限422、一项失效导致零项写入。
- [x] RED：等待取材时文章变化／开始执行、一次创建失败不留空文章；导入保存精确正文/hash/readProvider，重启仍可读；invalidations／旧参考稿／quote校验不回归。
- [x] 运行 `node --import tsx --test src/lib/hotspots.test.ts src/lib/hotspot-routes.test.ts src/lib/articles.test.ts src/lib/article-routes.test.ts src/lib/article-writing.test.ts` 确认新断言失败。
- [x] 实现详情路由；导入先解析快照，再于现有串行写入中检查 version/running 和重复／限额，最后一次 persist。create 的资料与新记录在同一持久化动作完成；不接受客户端正文覆盖快照，不在失败时撤销其它用户编辑。
- [x] 复跑上述测试通过，保留旧 addUrl／addText／readSources 行为及原发布预览和包自包含逻辑。

## Task 5：热点详情与共用取材 UI（R1、R2、R5、R8）

**Files:** 新增 ResearchPanel.tsx、HotspotDetailDialog.tsx／测试；修改 HotspotsPage.tsx／测试、ArticleDetailPage.tsx、services/api.ts／测试。

**Interfaces:** ResearchPanel props 为 `initialQuery`、可选 `initialItem`、`maxSelection=3`、`onImport(selections)`；UI 使用 readId/hash，不把远端正文回传导入。Dialog 接收服务端热点条目身份，调用详情读取；文章创建接受 researchSelections。

- [x] RED：标题可访问按钮、首次打开无外网、已有摘要显示；搜索线索／topic／失败不可勾选正文；A→B 切换及关闭后晚响应不覆盖。
- [x] RED：选择最多3份、409/410保留选择并提示重读／载入新版本，导入成功更新完整 ArticleRecord；未保存文章编辑时禁止导入直到现有保存流程完成，不悄悄覆盖。
- [x] 运行对应前端测试确认失败；补 apiClient 会话、字段、65秒读取／40秒搜索超时断言。
- [x] 实现主题令牌 UI、Modal 焦点与独立请求序号／取消；网络阅读期间仍可关闭阅读窗口，取消后不创建文章、不修改文章。文章导入中暂禁重复动作；保留原文外部打开、热榜多列及备注 useBlocker。
- [x] 测试通过后用隔离 UI 夹具检查桌面与390px、浅深主题、键盘、搜索失败、阅读403和保存冲突；SSR测试不能代替交互验收。

## Task 6：集成验收与交付记录（R1～R10）

**Files:** 完善 scripts/verify-content-research.ts；新增 docs/research/2026-10-08-content-research-verification.md（实施时创建）；只在确有实现后更新 AGENTS.md 相关约定。

- [x] 默认验证模式仅启动隔离数据／mock上游，临时 storage 全程独立，退出清理；不把真实用户文章、收藏或发布索引用作模拟写入目标。
- [x] `--live` 只读公开样本，服务每次调用明确选择；头条topic、公开文章、知乎受限页分别记真实状态。三个中文选题各核对前5条标题/来源/相关性，记录延迟、失败或限频；不含登录、不触发实际发布。
- [x] 使用mock正文/AI验证：搜索→阅读→选择→创建/导入→事实引用→旧发布预览，网络失败与410均可恢复；不得假定标题正确就代表材料支持论点。
- [x] 执行 `npm test`、`npm run check`、`git diff --check`；对应测试全部通过，失败须定位为本轮问题或有证据的既有失败，记录真实汇总，不引用历史测试数字。
- [x] 执行 `npm run build:backend`、`npm run build:electron`、`npm run mark-cjs`、`npm run build:renderer`，重启实际开发运行方式，复核两入口配置及 SDK 网络调用；noEmit／源码测试不能替代构建。
- [x] 内部复核本轮diff、R1～R10覆盖与Review Focus，修正问题；更新验证记录，明确真实站点／免费服务限制和未实现的后续各期，不混提交其它在途改动。

## 规格覆盖与文档复核记录

| 规格验收 | 主任务 |
| --- | --- |
| R1／R2 | Task 1、4、5 |
| R3／R4／R7 | Task 1、2 |
| R5／R6 | Task 4、5、6 |
| R8 | Task 5 |
| R9 | Task 3、6 |
| R10 | Task 6 |

2026-10-08 内部复核已完成：任务输入／输出与规格一致，时间、缓存、数量限制一致；五项Review Focus有对应测试；第一期以无需平台登录的匿名搜索和公开阅读为边界，后续路线单独列出。待实施上游探针锁定具体SDK版本和工具schema是Task 1的明确产出，不是已验证能力。该段记录文档创建时状态；执行结果以后附实施记录为准。


## 2026-10-08 实施记录

六个任务已实施，执行复选框表示相关工作与检查已执行，不表示每个第三方网站都读取成功。专项测试按实际新增的research-*、article-research、research-config和ResearchPanel等文件组织；全量回归1144通过、1跳过、0失败，check与四套构建步骤通过。官方MCP SDK锁定1.32.1，编译后的Electron加载及即时配置已隔离验证。

真实Exa三领域查询分别返回5／2／5条HTTPS线索；人工核对相关性并保留机构主页、结果不足等限制。真实Jina三目标均直连超时，未认定读取成功。完整平台现场403／429不伪造为真实成功，对应错误映射、正文分类与限频由隔离测试覆盖。浏览器实际走查创建／导入、保存保护、409、搜索502、关闭与迟到响应，以及390px／桌面浅深主题。默认脚本走通mock事实引用和原文章预览，不触发真实AI／发布。

内部独立审查的问题已回归修复；未提交、未推送、不混提交其它在途改动。第二／三期保持未实现。详见[第一期实现与验收记录](../../research/2026-10-08-content-research-verification.md)。
