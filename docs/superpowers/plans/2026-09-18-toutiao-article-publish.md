# 今日头条 AI 文章发布 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把已完成任务产物（转录 + AI 洗稿）生成一篇头条文章，经**应用内扫码登录**的头条号会话，在 `mp.toutiao.com` 发布页**真实点击「发布」**；成功后只记「已提交」，由人工在头条后台核实后点既有「标记已发布」。

**Architecture:** 复用既有交付包与发布中心（版本/排期/审计/垃圾桶/预览全部白拿），把 `PackageContentType: "article"` 这条**已存在但无人调用**的通路接通，并新增 `toutiao` 平台；文章内核（AI 成文 + 结构化草稿 + 包内 `article.html`）与暂停中的公众号特性**共用一份**，按平台注入限额与渲染档案。执行器是**自研 Playwright runner**：复用打包资源里已有的 chrome-headless-shell（实测可用），不引外部 CLI、不加新依赖。

**Tech Stack:** Node.js + Express 4 + TypeScript（后端）、Playwright（已在依赖里，驱动打包的 chrome-headless-shell）、ffmpeg（封面裁剪）、React 19 + Tailwind CSS（渲染层）、Node 内置 test runner（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-18-toutiao-article-publish-design.md`
**调研证据:** `docs/research/toutiao-ops-assessment.md`

## Global Constraints

- **不新增任何 npm 依赖**；**不引入外部引擎/CLI**（不用 `@openclaw-cn/toutiao-ops`）。
- **不新增 `PublishTaskStatus` 取值**；`autoPublish` 子记录沿用；头条通路**不使用 `awaiting_code`**。
- **`task.status` 全程不变**：`succeeded` 的语义是**已提交**，绝不写 `published`。
- **失败绝不自动重试**；同一任务同时只允许一个 `autoPublish` 运行（409），沿用 30 分钟僵死阈值。
- **「发布前必经预览」是服务端约束**：`auto-publish` 必须带 `previewRevision`（缺失 400 / 不一致 409），两种情况都**不产生** `autoPublish` 记录。
- **每一步页面操作都要有读回校验**：关不掉「同时发布微头条」、封面没真的送达、标题没填进去 —— 一律**抛错并停在点「发布」之前**，绝不吞异常继续（参考实现的反面）。
- 标题 **2~30 字**（下限是本平台独有校验）；封面**必填**且服务端裁成 **16:9（1280×720）**；**正文配图 v1 不做**。
- **「同时发布微头条」默认关闭**且必须校验；校验不通过则**不发布**（fail closed）。
- **「先判输入类别、再判配置」**：未配置头条浏览器时，对 note/video 包必须仍返回该通路原本的错误。
- 共用内核时 `wechat-article.ts` 的**既有 44 个用例逐字通过**；`packagePreviewRevision` 的 **video/note 两分支哈希逐字节不变**（既有精确 baseline 用例是回归门禁）。
- 程序化检查一律用**假对象/本地 fixture**（假 ffmpeg stub、假页面、`file://` fixture 页）；除 Task 1 的只读侦察外**不联网**、**不发布任何真实内容**。
- 后端改动需 `npm run build:backend` 并重启；`electron/` 改动需 `npm run build:electron`（**两套产物互不覆盖**）。

---

### Task 1: 只读侦察与会话基建（**可行性判据**；侦察需用户扫码一次）

**Files:**
- Create: `src/lib/toutiao-browser.ts`
- Create: `src/lib/toutiao-runner.ts`
- Create: `scripts/probe-toutiao-publish-page.ts`
- Test: `src/lib/toutiao-browser.test.ts`、`src/lib/toutiao-runner.test.ts`

**Interfaces:**
- Consumes: 既有 `storageRoot`、`playwright`（已是直接依赖）、打包资源 `vendor/package-assets/browser/chrome-headless-shell/*`
- Produces: `resolveToutiaoBrowserTarget()`、`resolveToutiaoProfileDir()`、`launchToutiaoContext()`；`ToutiaoRunner` 的 `assertConfigured()` / `checkLogin()` / `startLogin()` / `pollLogin()` / `cancelLogin()`；`ToutiaoRunnerError` 与错误码；侦察产物 `storage/toutiao/recon/publish-page.html`

- [ ] **Step 1: 写失败用例（浏览器解析，不启浏览器）**

- 显式 `browserBinary` → `{ kind: "executablePath" }`。
- 环境变量 `TOUTIAO_BROWSER_BINARY` → 同上（显式配置优先于 env）。
- 都不给、但 `<repo>/vendor/package-assets/browser/chrome-headless-shell/**` 存在 → 解析到它（用临时目录造一个假的可执行文件来测这条链，**不依赖本机是否真的 prepare 过**）。
- 都不给且 vendor 不存在 → 退到 `{ kind: "playwright" }`；`channel: "chrome"` 只在前两者都不可用时作为**显式兜底配置**出现。
- 全部不可用 → 报错文案含 **`npm run prepare:package:mac`** 与 **`npx playwright install chromium`** 两条命令（断言原文，防止退化成「未找到浏览器」）。
- `resolveToutiaoProfileDir()`：缺省 `<storageRoot>/toutiao/profile`；越出 storage 的 override **被拒**（抛错，不静默接受）。
- `ToutiaoRunner.assertConfigured()`：解析失败时抛 `toutiao_browser_unavailable`，且**在任何记录写入之前**。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/toutiao-browser.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现解析与启动**

分层实现 §4.1 的五层解析；`launchToutiaoContext()` 用 `chromium.launchPersistentContext(profileDir, { headless: true, locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: {1440,900}, args: ["--disable-blink-features=AutomationControlled"] })`，`executablePath` 按解析结果注入。

- [ ] **Step 4: 写失败用例（会话生命周期，用假 automation）**

- `isLoginUrl()`：`https://mp.toutiao.com/auth/page/login?redirect_url=…` → true；`…/profile_v4/graphic/publish` → false；`sso.toutiao.com/...` → true。
- `checkLogin()`：假页面停在发布页 → `loggedIn: true` + 昵称；停在登录页 → `loggedIn: false`。
- **单飞**：`startLogin()` 进行中再调 → `toutiao_login_in_progress`（409 语义），且不产生第二个 context。
- **TTL**：注入假时钟推进 10 分钟后再 `pollLogin()` → `status: "expired"` 且 context 已关闭（断言 `close()` 被调用）。
- `cancelLogin()` → context 关闭，后续 `pollLogin()` 返回 `idle`。
- 二维码取不到（假页面无 data URL 图片）→ `toutiao_qr_unavailable`。

- [ ] **Step 5: 运行确认失败**

Run: `node --import tsx --test src/lib/toutiao-runner.test.ts`
Expected: FAIL —— `ToutiaoRunner` 不存在。

- [ ] **Step 6: 实现 runner 的登录会话**

页面通过窄接口注入（测试传假对象）；context/page 由可注入的 `launch` 函数提供，**runner 单测全程不启浏览器**。

- [ ] **Step 7: 实现只读侦察脚本（`scripts/probe-toutiao-publish-page.ts`）**

按 spec §13 的 7 步：起无头浏览器 → 登录页取二维码并落盘 + 打印路径 → 轮询登录（打印昵称）→ 进发布页 → 落 DOM 快照到 `storage/toutiao/recon/publish-page.html` → 打印各候选选择器的命中数与摘要（**不填表、不点发布**）→ 探一次富文本粘贴并读回 → 尝试打印「发布成功判据」候选 → 关闭浏览器。脚本**只读**，退出前打印「本次未发布任何内容」。

- [x] **Step 8: 运行确认通过，并请用户执行侦察**

Run: `node --import tsx --test src/lib/toutiao-browser.test.ts src/lib/toutiao-runner.test.ts && npm run check`
Expected: PASS。
Run（**需要用户扫码，只读**）: `node --import tsx scripts/probe-toutiao-publish-page.ts`
把侦察结论（各选择器命中数、粘贴是否生效、无头是否被风控、发布成功判据）**逐条回填进本计划与 spec §1.4**；侦察结果同时是 Task 4 的 fixture 输入。

> **注**：Task 2/3 不依赖侦察结果，可与本步并行推进；**Task 4 的选择器必须等侦察证据**。

### Task 2: 文章内核共享化（测试先行；**既有 50 个用例是门禁**）

> **执行记录（2026-09-18）**：只抽了 `article-draft.ts`（成文 + 草稿 + 兜底 + 限额档案 + 校验/压缩），
> **`article-html.ts` 没有抽** —— 偏离原计划，理由：头条正文由**结构化草稿**渲染（`sections` → `<h2>/<p>`），
> **根本不接收任意 HTML**，所以不需要 wechat 那套 sanitizer；共享它只会把一个不需要的
> 锚点策略与 mmbiz 图片白名单搬到头条场景里。头条侧只做「**全部转义**」（比事后清洗更强）。
> 已验证：`wechat-article.test.ts` **50 个用例逐字通过**（行为未变），`article-draft.test.ts` 新增 10 个用例。
> 另有一条经验：**渲染类改动必须把真实样例打出来看一眼**（本次渲染器是新增模块，未复用 wechat 渲染）。

**Files:**
- Create: `src/lib/article-draft.ts`、`src/lib/article-html.ts`
- Modify: `src/lib/wechat-article.ts`（改为薄封装）
- Test: `src/lib/article-draft.test.ts`、`src/lib/article-html.test.ts`（+ 既有 `src/lib/wechat-article.test.ts` 全程必须通过）

**Interfaces:**
- Consumes: 既有 `planWechatArticle` / `renderWechatArticleHtml` / `sanitizeWechatHtml` / `validateArticleDraft` 的行为契约
- Produces: `ArticleDraft` / `ArticleSection` / `ArticleSourceContext` / `ArticleLimits` / `ArticleProfile`、`planArticle(context, deps, profile)`、`validateArticleDraftAgainstProfile(draft, profile)`、`compressToLimit`、`sanitizeArticleHtml(html, profile, allowBlocks?)`、`renderArticleHtml(draft, profile, options?)`

- [ ] **Step 1: 写失败用例（中立内核）**

- `planArticle` 用**假 AI 客户端**：合法 JSON → `copySource: "ai"`；坏 JSON / 抛异常 / 缺字段 / 空段落 / `null` / 数字 → **一律** `copySource: "fallback"` + `warning`，且产出的草稿**必定能通过 `validateArticleDraftAgainstProfile`**（对每种输入都断言一次）。
- 提示词里的限额数字**来自传进来的 profile**：换一个 profile（titleMax 30）后，提示词里必须出现 30 且**不出现** 32（防止另写一份数字）。
- `validateArticleDraftAgainstProfile`：支持 `titleMin`（1 字 → 报错；2 字 → 通过）。
- `sanitizeArticleHtml`：`<style>/<script>/<svg>/iframe` 被去掉；`class/id/data-*/on*` 被去掉；`div→section`；列表改写为块级（`<li>甲</li><li>乙</li>` **不得粘成「甲乙」**）；段内块级边界换成 `<br>`；`<img src>` 与 `<a href>` 的属性**必须保留**（`ensureStyle` 早期版本整标签重建会静默抹掉 `src`，这是上一轮被用例抓到的真 bug）。
- `renderArticleHtml`：样式来自 profile（换 profile 换样式）；`anchorPolicy` 生效（"unwrap" 的锚点成对拆掉只留文字）；`allowImageSrc` 拒绝的图被丢弃；渲染长度超限**抛出并指出第几段**。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/article-draft.test.ts src/lib/article-html.test.ts`
Expected: FAIL —— 两个模块都不存在。

- [ ] **Step 3: 实现（**只移动、不改行为**）**

把 `wechat-article.ts` 里平台中立的部分搬进新模块，`wechat-article.ts` 保留全部既有导出名并委托过去（类型用别名）。**公众号的限额、样式、锚点策略、mmbiz 图片白名单、`{{wechat-image-N}}` 占位符语义一字不改。**

- [ ] **Step 4: 运行确认通过（**并肉眼复核渲染样例**）**

Run: `node --import tsx --test src/lib/wechat-article.test.ts src/lib/article-draft.test.ts src/lib/article-html.test.ts && npm run check`
Expected: **既有 44 个 wechat-article 用例全部通过**、新增用例通过。
另：打印一份真实渲染样例（含标题/段落/加粗/列表/引用）**肉眼看一眼** —— 纯函数全绿 ≠ 产物读得通（既有教训）。

### Task 3: 头条文章档案、渲染与封面（测试先行）

**Files:**
- Create: `src/lib/toutiao-article.ts`、`src/lib/toutiao-media.ts`
- Test: `src/lib/toutiao-article.test.ts`、`src/lib/toutiao-media.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ArticleProfile` / `planArticle` / `renderArticleHtml`
- Produces: `TOUTIAO_ARTICLE_LIMITS`、`planToutiaoArticle`、`validateToutiaoArticle`、`renderToutiaoArticleHtml`、`articleDraftToBodyText`、`ToutiaoMediaService.prepareCoverImage`

- [ ] **Step 1: 写失败用例（成文与校验）**

- 标题 1 字 → 报错（指出「至少 2 字」）；2 字 → 通过；31 字 → 被压到 30 字并带省略号（`compressToLimit` 语义），且**按码点计数**（emoji 不被算成两个）。
- 正文 20001 字符 → 报错；20000 → 通过。
- 兜底链：无标题但有要点 → 用首个要点；**一条素材都没有** → 给一句可执行的占位说明（绝不产出空文章）。
- 提示词含 2/30/20000（由 `TOUTIAO_ARTICLE_LIMITS` 生成）。
- 假 AI 六种坏输出 → 全部落到可渲染的兜底（同 Task 2 的不变式）。

- [ ] **Step 2: 写失败用例（渲染）**

- `renderToutiaoArticleHtml`：`sections` 渲染成 `<h2>` + `<p>`；内联样式非空；`<script>` 被去除；长度超限抛错并给段号。
- `articleDraftToBodyText`：段落之间空行分隔、去掉标题标签；空草稿给占位文案。

- [ ] **Step 3: 运行确认失败**

Run: `node --import tsx --test src/lib/toutiao-article.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现档案、渲染与正文纯文本**

- [ ] **Step 5: 写失败用例（封面，**假 ffmpeg stub**）**

- stub 把自己的 argv 写进文件供断言：滤镜是 `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720`，输出名 `cover.jpg`。
- stub 退出码 0 但**不产出文件** → 报错（不能当成 0 字节的成功）；stub 抛错 → 报错且**产物被删掉**（断言目录里没有残留）。
- 产物超过 `coverBytes` → 报错且删产物。
- 源图前后 sha256 一致（**源文件只读**）。
- `ffmpegBinary` 传空白字符串 → `toutiao_media_ffmpeg_unavailable` + 安装指引；缺省回退 PATH 的 `ffmpeg`。

- [ ] **Step 6: 运行确认失败并实现**

Run: `node --import tsx --test src/lib/toutiao-media.test.ts` → FAIL → 实现 → PASS。
（另用**真实 ffmpeg**实测一张 1080×1920 静帧 → 断言产物是 1280×720 的 JPEG，并记录在计划里；stub 只能证明 argv，证明不了滤镜语法对。）

### Task 4: 页面步骤与发布执行器（测试先行；fixture 页用**真实 Playwright**）

> **执行状态（2026-09-18）：已完成。**（原记录见下：先卡在侦察，用户扫码后立刻补完）
> `toutiao-page.ts`（选择器 + 8 个步骤，每步读回校验）与 `ToutiaoRunner.publishArticle` 已实现，
> 逐段纯文本兜底与「关不掉微头条就不发布」的 fail closed 也已写好；
> **但选择器尚未经登录后的真实发布页校准**（`scripts/probe-toutiao-publish-page.ts` 起了两次扫码窗口都过期）。
> **用户扫码后侦察完成，三件事都做完了**：
> ① 按 `selectors.json` 的命中证据重写 `TOUTIAO_SELECTORS`（标题 `.ProseMirror`/`.article-cover-add`/
> 「发布得更多收益」那只 LABEL/`publish-btn-last`）；
> ② 从快照里逐段抠出离线 fixture `src/lib/fixtures/toutiao-publish-page.html`；
> ③ 补了 11 项**真浏览器**用例（标题/正文粘贴+纯文本兜底/封面/首发/声明/微头条 fail closed/提交判据）。
> **这轮 fixture 用例抓到 3 个真问题**：点外层 div 不会切换复选框（见 `clickCheckboxByText`）、
> 「头条首发」勾完缺读回确认、tsx 的 `__name` 助手会让 `page.evaluate(内联函数)` 在页面里直接 ReferenceError。

**Files:**
- Create: `src/lib/toutiao-page.ts`
- Modify: `src/lib/toutiao-runner.ts`（`publishArticle()`）
- Test: `src/lib/toutiao-page.test.ts`（fixture 页）、`src/lib/toutiao-runner.test.ts`（假 automation）

**Interfaces:**
- Consumes: Task 1 的浏览器解析与 session、Task 3 的渲染产物与封面、**Task 1 的侦察证据**
- Produces: `TOUTIAO_SELECTORS`、`isLoginUrl`、`readQrCodeDataUrl`、`fillTitle`、`fillBodyHtml`、`uploadCover`、`setFirstPublish`、`setDeclarations`、`ensureWeitoutiaoUnchecked`、`submitAndConfirm`；`ToutiaoPublishResult`

- [ ] **Step 1: 写失败用例（**离线 fixture 页**，真实 Playwright）**

在 `src/lib/fixtures/toutiao-publish-page.html` 复刻侦察到的发布页结构（标题框、`contenteditable` 编辑器、封面 `<input type=file>` 与上传区、微头条勾选框、首发与声明、`预览并发布`/`确认发布` 按钮，以及页面内脚本站点记录被点过的按钮）。

- fixture 存在且 `resolveToutiaoBrowserTarget()` 拿不到浏览器时 **skip**（打印原因），与既有 `RUN_HYPERFRAMES_INTEGRATION` 同一惯例。
- `fillTitle(page, "甲")` → 读回 `value === "甲"`；元素不存在 → 抛错。
- `fillBodyHtml(page, html, text)` → fixture 的 paste 处理器收到 `text/html`，编辑器纯文本含正文；**构造一个「不吃 paste」的 fixture** → 返回 `"plain"` 且逐段输入后纯文本一致；**两者都读回校验**。
- `uploadCover(page, coverPath)` → fixture 的 file input 真的收到该文件（断言文件名）；**构造「确定按钮点了不上传」的 fixture** → 必须抛错（**绝不静默**）。
- `ensureWeitoutiaoUnchecked(page)`：默认勾选的 fixture → 点击后读回未勾选；**构造「点了没反应」的 fixture** → 抛 `toutiao_weitoutiao_unchecked_failed`，且**断言发布按钮从未被点过**。
- `submitAndConfirm(page)` → 依次点「预览并发布」「确认发布」，返回 `url` 与 `signal`；**构造「确认发布后没有成功提示」的 fixture** → `signal: "unconfirmed"`。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/toutiao-page.test.ts`
Expected: FAIL（或 skip —— 若 skip，必须先解决浏览器来源再往下走）。

- [ ] **Step 3: 实现页面步骤**

选择器全部来自 Task 1 的侦察证据（**不许照抄参考项目的启发式选择器**），集中在 `TOUTIAO_SELECTORS`；每个动作后读回校验。

- [x] **Step 4: 写用例（执行器编排）—— 真浏览器 + fixture，而非字符串匹配的假页面**
  （2026-09-18 补做：先查覆盖率发现 `publishArticle` 零用例，属本计划的漏项）

- `publishArticle()` 正常路径 → `ok: true`、`verification: "confirmed"`、`steps` 含「填标题 / 填正文 / 传封面 / 关微头条 / 点发布 / 确认」六条。
- 未登录（页面停在登录页）→ 抛 `toutiao_not_logged_in`，**不点发布**。
- 封面缺失（文件不存在）→ 抛 `toutiao_cover_required`，**不点发布**。
- 微头条关不掉 → `ok: false` + 明确 message，**不点发布**。
- 点发布后拿不到判据 → `ok: true` 但 `verification: "unconfirmed"`，message 写明「请到头条后台核实」（**不谎报 confirmed**）。
- 任何步骤抛错 → context 被关闭（断言 `close()` 调用，**不留孤儿浏览器**）。

- [ ] **Step 5: 运行确认失败并实现**

Run: `node --import tsx --test src/lib/toutiao-runner.test.ts` → FAIL → 实现 → PASS。

- [ ] **Step 6: 运行确认通过**

Run: `node --import tsx --test src/lib/toutiao-page.test.ts src/lib/toutiao-runner.test.ts && npm run check`
Expected: PASS。

### Task 5: 平台接入、包模型与内容指纹（测试先行）

**Files:**
- Modify: `src/types.ts`、`src/lib/publishing-platforms.ts`、`src/lib/publishing-assets.ts`、`src/lib/publishing-store.ts`
- Test: `src/lib/publishing-platforms.test.ts`、`src/lib/publishing-store.test.ts`、`src/lib/publishing-assets.test.ts`

**Interfaces:**
- Consumes: 既有 `createArticlePackageAssets` / `withStagedPackage` / `copyOrderedImages`
- Produces: `PublishPlatform` 含 `toutiao`；`ArticleCopy`（`WechatArticleCopy` 变别名）；`DeliveryPackage.toutiaoOptions`；`AUTO_PUBLISH_ROUTES` + `resolveAutoPublishEngine`；导出 `validateCopyAgainstPolicy`；`packagePreviewRevision` 的 article 分支

- [ ] **Step 1: 写失败用例（平台清单 7 处）**

- `PUBLISH_PLATFORMS` 键集合 = 6 个平台（既有守卫数组更新为含 `toutiao`）。
- `APPROVED_PLATFORMS`、`PLATFORMS`、`SUPPORTED_PLATFORMS` 与它**集合相等**。
- `isPlatform("toutiao") === true`（**漏这一处的后果是静默的**：读回索引时任务被丢掉）。
- 渲染层平台表的守卫数组同步更新（Task 7 里一并做，但**这里先写后端断言**）。
- `PUBLISH_PLATFORMS.toutiao`：label「今日头条」、`titleMax === 30`、`descriptionMax === TOUTIAO_ARTICLE_LIMITS.bodyChars`、`creatorUrl` 指向发布页；`hashtag*` 保留但不提交。
- `validateNoteCopy("toutiao", …)` **仍抛错**（头条走 article 通路，不许塞进图文闸门）。
- `NOTE_PLATFORMS` 仍是严格子集且不含 `toutiao`/`wechat_mp`。

- [ ] **Step 2: 写失败用例（指纹与硬闸）**

- `packagePreviewRevision` 的 article 分支：改 `articleCopy.htmlSha256` / `articleCopy.title` / `coverPath` / `toutiaoOptions.firstPublish` / `declarations`（**集合敏感、顺序无关**）/ `crossPostWeitoutiao` → 指纹**都变**；`imagePaths` 顺序参与。
- **video 与 note 的指纹逐字节不变**（既有精确 baseline 用例原样通过）。
- `resolveAutoPublishEngine("note","douyin") === "sau"`、`("article","toutiao") === "toutiao"`；`("video","douyin") === null`、`("note","toutiao") === null`。
- `beginAutoPublish`：video 包仍报**既有错误码 `publish_not_a_note_package`**（既有用例逐字断言，不许改）；note+douyin 通过；video+toutiao 等组合报 `publish_auto_publish_unsupported` 并带 `{ contentType, platform }`。

- [ ] **Step 3: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts src/lib/publishing-store.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现类型、平台表、路由表、指纹分支、store 硬闸**

要点：article 包的 `videoSha256` 承载**图片清单哈希**（沿用 note 口径）、`videoSize` 承载图片总字节、`videoMethod = "copy"`；**不要把 `htmlSha256` 塞进 `videoSha256`**（会让 `verifyPackageImages` 误判 `missing_images`）。

- [ ] **Step 5: 写失败用例（article 打包接线）**

- `createArticlePackageAssets` 传 `sourceCoverPath`（Task 3 的 16:9 产物）→ 包内出现 `cover.jpg`、`assetHealth === "healthy"`、`coverPath` 指向包内文件。
- 不传封面 → `assetHealth === "missing_cover"`（头条封面必填，由服务层与界面拦）。
- article 包**一张正文图都没有是合法状态**（不报错、不标 `missing_images`）。
- `articleCopy.htmlSha256` 与包内 `article.html` 的 sha256 一致；改一个字节 → 不一致。
- **存量兼容**：既有 30+ 个视频包与图文包用例逐字通过。

- [ ] **Step 6: 运行确认失败并实现，再确认通过**

Run: `node --import tsx --test src/lib/publishing-assets.test.ts src/lib/publishing-store.test.ts src/lib/publishing-platforms.test.ts`
Expected: PASS，且既有用例全部保持通过。

### Task 6: 服务编排与路由（测试先行）

**Files:**
- Modify: `src/lib/publishing-service.ts`、`src/lib/publishing-routes.ts`、`src/app.ts`、`src/server.ts`、`electron/server.ts`
- Test: `src/lib/publishing-service.test.ts`、`src/app.test.ts`

**Interfaces:**
- Consumes: Task 3 的成文/封面、Task 4 的执行器、Task 5 的包模型与指纹
- Produces: `previewArticlePackage` / `createArticle` / `createToutiaoArticlePackage` / `autoPublishToutiaoArticle` / `verifyToutiaoLogin` / `readPackageArticleHtml`；4 个头条路由；`contentType()` 接受 `article`；`(平台 × 内容类型)` 分派

- [ ] **Step 1: 写失败用例（预览与创建）**

- `preview(jobId, ["toutiao"], "article")` → 返回 `articleCopy`（标题 ≤30、正文文本）、封面候选（静帧有序 / 素材库带 `assetId`）、`articleLimits`、`toutiaoOptions` 默认值（全关）、`previewRevision`；**不再静默返回视频预览**（既有行为是 article 落到视频分支）。
- 该 `previewRevision` 能被创建接口接受（**端到端闭环**：先预览取 revision，再带它创建）。
- 创建时缺 `previewRevision` → 400；过期 revision → 409；标题 1 字 / 31 字 → 422；正文超 20000 → 422；封面选择非法（素材库 0 张、或给了不存在/不归属的 assetId）→ 400/422 明确错误。
- 创建成功 → 包记录 `contentType === "article"`、`articleCopy.htmlSha256` 与包内文件一致、`coverPath` 指向包内 `cover.jpg`、`toutiaoOptions` 落库、任务文案与包级一致（**服务端同步生成，客户端不许传两份**）。
- 素材库封面经 `AssetStore.resolveFile` 解析（**id → 路径的归属校验只有这一个真源**）。

- [ ] **Step 2: 写失败用例（包级预览与提交分派）**

- `packagePreview` 对 article 包 → 标题、**正文纯文本**、封面可用性、头条选项、`copyChecks`；**不再给出空 `video` 元数据**。
- **分派**：article+toutiao 任务调 `auto-publish` → 走头条通路（**断言不触碰 sau**：注入的假 sau 一次都没被调用）；note+douyin 任务 → 走 sau 通路（**断言不触碰头条 runner**）。
- **分派顺序**：**未配置头条浏览器**时，对 note 包调用仍得到该通路原本的错误（例如未配置 sau），而**不是**「未找到浏览器」。
- article 包不带 `previewRevision` → 400 且**不产生** `autoPublish` 记录；预览后改内容（改包内 `article.html`）→ 409 且不产生记录；未配置浏览器 → 明确错误且不写记录；运行中重复触发 → 409。
- 成功路径 → `autoPublish.status === "succeeded"`、message 含 `verification`、**`task.status` 仍是 `ready`、`publishedAt` 为空**（最关键的一条断言）。
- 头条 runner 抛错 → `failed` + 可执行 message；`verification: "unconfirmed"` → message 必须含「未能在作品列表确认」与「请到头条后台核实」。
- 缺封面的 article 包 → 明确拒绝（**头条封面必填**），不写记录。
- `GET /packages/:id/article` → 200 `text/html` 且与包内文件字节一致；非 article 包 → 404；未认证 → 401。

- [ ] **Step 3: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-service.test.ts src/app.test.ts`
Expected: FAIL —— 路由与分支都不存在。

- [ ] **Step 4: 实现编排与路由**

编排留在 `PublishingService`（薄路由不变式）。提交前**校验包内 `article.html` 的 sha256 与 `articleCopy.htmlSha256` 一致**（不一致 → 明确错误，不提交）。`sau` 与 `toutiao` runner 都通过 `ServerConfig` 注入，缺配置时**在写入任何记录之前**失败。

- [ ] **Step 5: 运行确认通过**

Run: `node --import tsx --test src/lib/publishing-service.test.ts src/app.test.ts && npm run check`
Expected: PASS（仅剩既有那条基线失败）。

### Task 7: 渲染层（设置页扫码登录 + 创建向导 + 发布动作）

**Files:**
- Create: `renderer/src/utils/toutiaoArticle.ts`、`renderer/src/components/CreateToutiaoArticleDialog.tsx`、`renderer/src/components/ToutiaoLoginPanel.tsx`
- Modify: `renderer/src/types/index.ts`、`renderer/src/utils/publishing.ts`、`renderer/src/components/PublishPreviewDialog.tsx`、`renderer/src/pages/PublishingPage.tsx`、`renderer/src/pages/SettingsPage.tsx`、`renderer/src/utils/settingsSections.ts`、`renderer/src/services/api.ts`、`renderer/src/pages/JobDetailPage.tsx`
- Test: `renderer/src/utils/publishing.test.ts`、`renderer/src/utils/toutiaoArticle.test.ts`、`renderer/src/components/PublishPreviewDialog.test.tsx`、`renderer/src/components/CreateToutiaoArticleDialog.test.tsx`、`renderer/src/components/ToutiaoLoginPanel.test.tsx`

**Interfaces:**
- Consumes: Task 6 的接口
- Produces: 今日头条平台行与动作；创建向导；扫码登录面板；article 预览分支

- [ ] **Step 1: 写失败用例（纯逻辑）**

- 平台表守卫：`PUBLISHING_PLATFORMS` 的 id 集合 = 6 个（含 `toutiao`），且 `toutiao` 的 `titleMax === 30`、`creatorUrl` 与会话口径一致。
- `getPublishingAutoPublishBlocker`：article+toutiao 且 `ready` → `null`；`missing_cover` → 「缺少封面」；`contentType === "video"` → 既有文案不变（**回归断言**）；note+douyin → 既有文案不变。
- article 任务**不提供** `edit-content`（断言动作列表里没有它，且 `preview`/`auto-publish` 仍在）。
- `toutiaoArticle.ts`：标题 1 字 / 31 字 / 2 字 / 30 字的即时反馈；未完成预览就组装请求体 → 抛错（**不发注定被拒的请求**）；封面来源为素材库但未选 → 阻塞原因。

- [ ] **Step 2: 写失败用例（组件静态渲染）**

- `PublishPreviewDialog` 的 article 分支：渲染封面区、标题 `n/30`、**正文纯文本段落**、头条选项；缺封面 → 显眼提示且确认按钮禁用。
- `ToutiaoLoginPanel`：`waiting` 时渲染 **`<img>` 且 `src` 是 `data:image/png;base64,…`**（**必须断言 src 形状，不能只断言元素存在** —— 本项目吃过「元素存在 ≠ 图上屏」的亏）；`logged_in` 时渲染昵称与「重新登录」；失败时渲染可执行文案（含两条命令之一）。
- `CreateToutiaoArticleDialog` 静态渲染：封面单选、标题/正文字数、头条选项默认全关、未就绪时创建按钮禁用。

- [ ] **Step 3: 运行确认失败**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts renderer/src/utils/toutiaoArticle.test.ts renderer/src/components/PublishPreviewDialog.test.tsx`
Expected: FAIL。

- [ ] **Step 4: 实现渲染层**

要点：`<img>` 的封面必须走 `apiClient` 取 blob（**带会话**，`<img src>` 不会带 `X-Local-Session` 头 → 401 破图）；二维码是后端给的 data URL，可直接放 `<img src>`；新增组件按惯例显式 `import React`（根 tsconfig 没有 `jsx` 设置，静态渲染会 `ReferenceError`）。

- [ ] **Step 5: 运行确认通过**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts renderer/src/utils/toutiaoArticle.test.ts renderer/src/components/PublishPreviewDialog.test.tsx && npm run check`
Expected: PASS，`tsc` 双端退出码 0。

### Task 8: 全量验证、编译与人工复核

**Files:** 无（验证与文档）

- [ ] **Step 1: 类型检查与全量测试**

Run: `npm run check && npm test`
Expected: 仅剩既有失败 `src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge`；基线 **608 项 / 606 通过 / 1 跳过 / 1 既有失败**（2026-09-18 实测）。

- [ ] **Step 2: 编译并重启**

Run: `npm run build:backend`；若改过 `electron/` 则再跑 `npm run build:electron`，随后重启后端与 Electron。
自查：`grep -c TOUTIAO_BROWSER_BINARY dist-electron/server.js` 应为 ≥1（否则就是「改了没生效」那类事故）。

- [ ] **Step 3: 用真机 HTTP 做隔离实例验证**

用 `dist/` 产物 + **临时 storage** 起隔离实例（不碰用户正在用的后端与 Vite 端口）：建文章包 → 包级预览取 revision → 提交（用一个**假头条 runner** 注入）→ 断言 `autoPublish` 与任务状态；并对 note 包跑一次分派回归（证明未触碰头条通路）。

- [ ] **Step 4: 人工真机验证（只到发布前一步）**

在真实应用里：设置页扫码登录 → 「校验登录」通过 → 作品详情页创建头条文章包 → 发布中心预览（确认封面、标题、正文、选项都对）→ **不点提交**，只确认「提交到头条号」前置条件全部满足与禁用原因都说得通。

- [ ] **Step 5: 真实发布留给人工决定 —— 执行清单（2026-09-18 写，含三种结果的各自动作）**

  **发布前**
  1. 应用里先点「预览」，确认 **封面 / 标题（≤30 字）/ 正文纯文本 / 发布选项** 与预期一致
     （预览里看到的必须与要发出去的一致；`previewRevision` 会拦住「预览之后又被改」的情况）。
  2. 确认这篇文章**确实是要发出去的**，且没有历史重试造成的重复。
  3. 记住：**重复发布是本功能最大的风险** —— 任何重试前都必须先确认上一次是否已发出。

  **发布**：发布中心任务行点「提交到头条号」→ 先弹预览（**必经确认**，服务端约束）→ 点确认。

  **三种结果与各自动作**

  | 结果 | 含义 | 你要做什么 |
  | --- | --- | --- |
  | `succeeded` + `verification: "confirmed"` | 点了发布**并且**页面上拿到了成功提示 | 仍只表示「已提交」：到头条后台「内容管理」核实 → 确认后点既有「标记已发布」 |
  | `succeeded` + `verification: "unconfirmed"` | 点了发布，但**没拿到成功判据** | **先去头条后台核实是否已发出**，再决定要不要重试；不要盲目再点 |
  | `failed` + message 里带「**没有找到确认按钮** … 当时页面上的可见按钮是：A / B / C」 | **什么都没发出去**（只点了「预览并发布」） | 把那段按钮文案发给维护者，即可把「确认发布」的真实文案补进 `confirmButtons` 与用例；这条路径**绝不会产生半发出去的文章** |

  **发布后核对**（三个字段一起看，缺一不可）
  - `task.status` **仍然是 `ready`**（机器绝不写 `published`）；
  - `publishedAt` **为空**；
  - `task.autoPublish.status` 与 `message`（审计里也有同一条）。

  **为什么这样设计**：与抖音通路同一条不变式 —— 机器只能把内容**送出去**，「是否真的发出去了」
  永远由人去平台后台核实后点「标记已发布」。头条这条通路还多一层：拿不到成功判据时**如实**记
  `unconfirmed`，绝不谎报。

  ---

  **原始记录（下面这段是当时的计划原文）**

- [ ] **Step 5: 真实发布留给人工决定**

真实点击「发布」由用户执行。发布后逐项记录：`autoPublish.status`、`verification`、`task.status` 是否仍为 `ready`、`publishedAt` 是否为空、是否需要人工到头条后台核实。**任何一次真实发布前，都要先确认上一次是否已发出**（重复发布是本功能最大的风险）。

- [ ] **Step 6: 文档同步**

`AGENTS.md` / `CLAUDE.md`（逐字一致）、`README.md`：架构清单、新接口、`TOUTIAO_*` 配置、新增「今日头条文章发布」注意事项与故障排查（含「选择器过时 → 先跑只读侦察脚本」）。`docs/worklog.md` 追加本轮记录。**只暂存本特性文件**，提交前做私密数据审计（不得出现 cookie/session/profile 内容）。

  ---

  **执行记录（2026-09-18，真浏览器界面验收）：在真页面上发现并修掉一个「界面根本走不通」的 bug。**

  - **发现方式**：用打包的 `chrome-headless-shell` + Playwright 对着真实界面（Vite 5173 + 隔离后端 3100，**没碰用户的 Electron 与 3100**）逐项点。动作按钮、弹窗、设置页都点到了，**只有「提交到头条号」点下去之后 `GET /publishing/packages/:id/preview` 是 500**。
  - **根因**：`copyCheck()` 第 5 个参数是布尔值（原叫 `noteScope`），文章分支照图文包传了 `true` → `validateNoteCopy("toutiao")` 抛错。**离线用例全绿是因为它们直接读 store 里的 revision，把这条接口绕过去了**。
  - **修法**：参数改为 `copyPolicy: "platform" | "note"`（名字直说选哪份政策）；文章/视频走 `"platform"`、图文走 `"note"`。新增 `articleHtmlToBodyText()`（HTML → 带 `## ` 的正文，与 `articleDraftToBodyText` 逐字相同），包级预览的正文改用它 —— 此前预览正文经 `htmlToPlainText()` 丢了 `## `，与创建向导里看到的形态不一致。
  - **用例（先红后绿）**：`article package preview returns the toutiao article checks instead of failing`（打真接口、断言 200 + 头条文章口径 + `previewRevision` 等于 store 里那个）；`articleHtmlToBodyText` 2 条（往返逐字相同 / 空 HTML 给占位）。
  - **顺带记两条不算 bug 的观察**：① 打开预览弹窗时 React 19 **development** 构建会报 `Expected static flag was missing`，**图文包预览同样会报**（生产构建无此检查，功能无影响），代码里已注明；② 我的执行沙箱里 Electron 必须带 `--no-sandbox --disable-gpu` 才能起来（`sandbox initialization failed: Operation not permitted` 是沙箱限制，不是应用问题）。
  - **验证**：`npm run check` 双端 0；`npm test` 731 项 / 729 通过 / 1 跳过 / 1 个既有失败（与基线同一条）；`build:backend` + `build:electron` 已重编译；真浏览器 17 项断言中通过 15 项、2 项是我自己断言写错（把图文包展开行也算进「编辑文案」检查、把设置页未点击时的文案当成了面板文案），已按证据修正后全部通过 —— 含「校验登录」返回真实结果 **已登录（今天不学习明天就完蛋）**。

  ---

  **执行记录（2026-09-20，Task 8 Step 5「真实发布」完成）：用户手动提交并核实成功。**

  - 结果：**文章已成功发布到今日头条**（用户确认）。应用记录：`autoPublish.status = succeeded`、
  步骤「进入发布页 → 填标题（28 字） → 粘正文（富文本） → 上传封面 → 关闭「同时发布微头条」 → 点击发布并确认」、
  `verification = unconfirmed`；用户到后台核实后点了「标记已发布」→ 任务状态才变 `published`。
  - 这印证了三件事：① 候选确认按钮文案**在真机上命中**；② 成功提示文案**不在** `successTexts` 里
  （所以 `unconfirmed` + 「先去后台核实」是**正确**行为，不是缺陷）；③ 「机器只记已提交、真发出由人工核实」
  这条不变式在真机上完整走通。
  - 本轮随后做的收尾（见 worklog 同日条）：`submitAndConfirm` 每次都带回确认后证据（URL / 是否离开发布页 /
  可见文案头+尾摘要）、`hasLeftPublishPage()` 纯函数并注明只是旁证、fixture 新增 `?silent=1` 复刻这次真机情形、
  修掉服务层双「但」前缀。
  - 遗留（下次真机跑一把即可闭环）：`autoPublish.message` 里会带上确认后的 URL 与可见文案 → 照着补 `successTexts`
  就能把这条路径升级成 `confirmed`。
