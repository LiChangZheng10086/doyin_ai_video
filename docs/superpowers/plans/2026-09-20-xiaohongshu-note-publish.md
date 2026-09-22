# 小红书图文自动发布 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把既有图文包（`contentType: "note"`）经**应用内扫码登录**的小红书创作服务平台会话，自动填写到 `creator.xiaohongshu.com/publish/publish` 的图文表单（含 **AI 合成内容标识**），并**默认停在点「发布」之前**（平台会自动存草稿，由真人点最后一下）。`submit: true` 时才点「发布」，且**点完不做任何读回**。

**Architecture:** 复用既有交付包与发布中心（版本/排期/审计/垃圾桶/预览/`previewRevision` 全部白拿），把已存在但只作为**人工交付**平台的 `xiaohongshu` 接通为第三条自动通路。执行器是**自研 Playwright runner**（第四个），形状与头条那套一致：`xhs-browser` / `xhs-page` / `xhs-runner` 三件套 + **平台中立**的 `note-media`（3:4 裁切），复用打包资源里已有的 `chrome-headless-shell`，**不引外部 CLI、不加新依赖**。关键差异：**页面分阶段渲染**（先上传图片，表单才出现）与**刻意不做发布后读回**。

**Tech Stack:** Node.js + Express 4 + TypeScript（后端）、Playwright（已在依赖里）、ffmpeg（3:4 裁切）、React 19 + Tailwind CSS（渲染层）、Node 内置 test runner（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-20-xiaohongshu-note-publish-design.md`
**调研证据:** `docs/research/xhs-publish-projects-assessment.md`（17 个参考项目 + 平台公告 + 封号实证）
**侦察证据:** `storage/xhs/recon/`（`publish-page.html`、`publish-page-after-upload.html`、`selectors*.json`、`dry-run-publish-candidates.json`）、探针 `scripts/probe-xhs-publish-page.ts`

## Global Constraints

- **不新增任何 npm 依赖**；**不引入外部引擎/CLI**；不复用日常 Chrome profile（实测大 profile 上 `launch_persistent_context` 50 秒不出窗口）。会话目录必须落在 `storage/` 内（`storage/xhs/profile`），越界一律拒绝。
- **`task.status` 全程不变**：`succeeded` 的语义是**已提交**，绝不写 `published`；由人工核实后点既有「标记已发布」。
- **失败绝不自动重试**；同一任务同时只允许一个 `autoPublish` 运行（409），沿用 30 分钟僵死阈值。
- **「发布前必经预览」是服务端约束**：`auto-publish` 必须带 `previewRevision`（缺失 400 / 不一致 409），两种情况都**不产生** `autoPublish` 记录。
- ⚠️ **刻意偏离头条范式（两处，必须在代码注释里写明理由，否则后人会当成漏做）**：
  1. **点完「发布」后不做任何读回** —— 不抓 `postConfirm`、不轮询成功文案。依据：`xiaohongshu-mcp` #715「让 ai 确认一下发布成功了没有，第一次警告第二次七天」。⇒ `verification` **恒为 `unconfirmed`**。
  2. **不做任何小红书侧的读取/采集/互动，也不做定时/cron** —— 只读同样出事（#726/#728/#777/#150）；cron 被点名（#680）。
- **AI 标识必须真的选中并读回**：勾不上、或页面上根本没有该控件 → **fail closed，绝不提交**（我们的内容整条由 AI 生成，未标识＝违规发布）。
- **频率闸门**：同一账号**本地自然日 ≤1 篇**（统计当日 `succeeded` 的小红书 `autoPublish`），超限 422 且**不产生记录**。文案必须写明「只是降低概率，不是安全保证」。
- **图片口径按小红书**：**≤18 张**（我们图文包允许 35 张，故必须在预览与提交两处按平台拦截）、单张 ≤32MB、png/jpg/jpeg/webp；**9:16 静帧必须裁成 3:4（1080×1440）**后再入包。
- **页面是分阶段渲染的**：**必须先上传图片，标题/正文/声明/提交才存在于 DOM**。任何「找不到标题框」的判断都要先问「图片上传了吗」。
- **每一步页面操作都要读回**：上传读回图片计数、标题读回 `value` 相等、正文读回首末段、声明读回选中后的文案；任何一步失败**停在点「发布」之前**并写明已完成到哪一步。
- **提交按钮必须 fail closed**：找不到提交按钮时**绝不写「已提交」**（照头条 `confirmClicked=false` 的反面教训）。
- **`packagePreviewRevision` 的 video/note 两分支现有哈希逐字节不变**（既有精确 baseline 是回归门禁）：`xhsOptions` **仅在 `!== undefined` 时**参与哈希。
- **分派处必须显式加 `engine === "xhs"` 分支且在 sau 兜底之前**（否则小红书会被静默路由给外部 CLI）。
- **头条那一族的错误边界事故不许重演**：`XhsRunnerError` / `XhsBrowserError` / `XhsPageError` / `XhsMediaError` **必须登记进 `publishing-routes.ts` 的错误边界**（各带 `status` + `code`），否则指引会被兜底 500 吞掉。
- 程序化检查一律用**假对象/本地 fixture**（假 ffmpeg stub、`file://` fixture 页、注入假 page）；除真机演练外**不联网**、**不发布任何真实内容**。
- 后端改动需 `npm run build:backend` 并重启；`electron/` 改动需 `npm run build:electron`（**两套产物互不覆盖**）。

---

### Task 1: 侦察收尾 + 浏览器/登录基建（**可行性判据**；复用已扫码的 profile）

**Files:**
- Create: `src/lib/xhs-browser.ts`
- Create: `src/lib/xhs-runner.ts`（本 Task 只做会话/登录部分）
- Modify: `scripts/probe-xhs-publish-page.ts`（新增 `--scroll-submit`）
- Test: `src/lib/xhs-browser.test.ts`、`src/lib/xhs-runner.test.ts`

**Interfaces:**
- Consumes: 既有 `storageRoot`、`playwright`、打包资源 `vendor/package-assets/browser/chrome-headless-shell/*`、`storage/xhs/profile`（已登录）
- Produces: `resolveXhsBrowserTarget()`、`resolveXhsHeadedBrowserTarget()`、`resolveXhsProfileDir()`、`launchXhsContext()`；`XhsRunner` 的 `assertConfigured()` / `checkLogin()` / `startLogin()` / `pollLogin()` / `loginInWindow()` / `cancelLogin()` / `dispose()` / `installExitCleanup()`；`XhsRunnerError` + 错误码；**提交按钮选择器**（侦察产物）

- [x] **Step 1: 侦察收尾 —— 提交控件已查明（2026-09-20 实测完成）**

**结论（详见 spec §7.0 ④）**：提交控件**不是 `<button>`**，而是自定义元素
`<xhs-publish-btn is-publish="true" is-save-draft="true" submit-text="发布" save-text="暂存离开" submit-disabled="false">`，
它**只在上传图片之后出现**，且使用 **closed shadow root** ⇒ `page.content()` 序列化不到、
`document.querySelectorAll` 看不到、**Playwright 的 CSS/role 定位器也不穿透**
（实测 `getByRole("button", { name: "发布" })` = 0、`xhs-publish-btn >> text=发布` = 0）。

排除过的假设（都有实测证据）：校验门控 ❌（内容全填好仍找不到）、懒挂载 ❌（`scrollHeight === innerHeight === 900`，不滚动）、iframe ❌（frames 只有主 frame + 空 `about:blank`）。

**落地方式**：按**宿主包围盒 + 相对偏移坐标点击** —— 实测宿主 680×90，
**「发布」≈ (0.607, 0.5)**、**「暂存离开」≈ (0.396, 0.5)**（证据：`storage/xhs/recon/submit-host.png`）。
**失败模式良性**：偏移落到「暂存离开」= 存草稿离开，不会误发。

**实现约束**：点击前校验宿主存在且 `submit-disabled === "false"`；点不到就**如实返回 `clicked: false`**，绝不写「已提交」。

- [x] **Step 2: 写失败用例（浏览器解析与 profile 归属，不启浏览器）**

- 显式 `browserBinary` 指向不存在的文件 → **抛错，不静默退到下一层**。
- `XHS_BROWSER_BINARY` 环境变量生效且优先于 vendor。
- vendor 存在（用临时目录造假的 `chrome-headless-shell/<平台-架构-版本>/<三元组>/chrome-headless-shell`）→ 解析到它，版本目录**按名降序**取第一个。
- 有头链（`resolveXhsHeadedBrowserTarget()`）**不返回** vendor 的 headless shell（它开不了窗口），只认系统 Chrome / 完整 chromium。
- 全部不可用 → 错误文案含 **`npm run prepare:package:mac`** 与 **`npx playwright install chromium`** 两条可照抄命令（断言原文）。
- `resolveXhsProfileDir()`：缺省 `<storageRoot>/xhs/profile`；越出 storage 的 override **被拒**。

- [x] **Step 3: 运行确认失败**

Run: `node --import tsx --test src/lib/xhs-browser.test.ts`
Expected: FAIL —— 模块不存在。

- [x] **Step 4: 实现解析链与启动**

照 `toutiao-browser.ts` 的分层（显式配置 → env → vendor → Playwright 缓存 → 系统 Chrome），逐层记录 `attempts`；`launchXhsContext()` 用 `launchPersistentContext(profileDir, { headless, locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: {1440,900}, deviceScaleFactor: 1, args: ["--disable-blink-features=AutomationControlled"] })`。
`defaultLaunch()` **自己 `mkdir(profileDir)`**（头条那轮的教训：交给 Playwright 建目录，失败时只会得到一句看不出原因的 `EPERM … mkdir`）。

- [x] **Step 5: 写失败用例（登录判定，这是实测踩过的坑）**

- ⚠️ **`checkLogin()` 判据必须是「离开登录页 ∧ 无登录阻断信号」，不能要求「发布页 DOM 出现」**：扫码成功后平台会把人送到 `/new/home`，那里标题框/编辑器**全部为 0** —— 把 READY 当必要条件的写法会让**扫码成功后还在原地傻等**（2026-09-20 实测，探针日志里只有一行「URL 变化: …/new/home」）。
- **cookie 只作旁证**：`access-token-creator` / `galaxy_creator_session_id` **未登录访客也会被种**。
- **沿用「重试后才作数」**：停在登录页要**再确认一次**（`LOGIN_CHECK_ATTEMPTS = 2`），两次都在登录页才算未登录。
- 启动异常一律包成 `XhsRunnerError("xhs_browser_unavailable", "小红书浏览器启动失败：<原始原因>。可照抄的动作：…")`。

- [x] **Step 6: 实现登录链路（含两个实测坑）**

1. **登录页默认是「短信登录」，页面上没有二维码** → 必须先点右上角切换图标（实测 `img.css-wemwzq`），并且**以「出现了更大的二维码元素」为切换成功判据**（面积阈值；那张切换图标是 64×64，把面积最大的 `data:` 图当二维码会取到它）。
2. **二维码会轮换** → 以**内容**为准：定期重取，`dataUrl` 变了就是新码，落盘并更新 `login-qrcode-latest.png`；**不要**只依赖「二维码已失效」这类文案（实测 15 分钟窗口内一次都没命中）。
3. `loginInWindow()` 用**有头**链（系统 Chrome），与抖音 `/api/douyin/qr-login` 同一交互。

- [x] **Step 7: 运行确认通过**

Run: `node --import tsx --test src/lib/xhs-browser.test.ts src/lib/xhs-runner.test.ts`
Expected: PASS（全部用例），且**没有启动任何真实浏览器**（注入假 probe/launcher）。

---


#### Task 1 执行记录（2026-09-20）

**产物**：`src/lib/xhs-browser.ts`（+10 条用例）、`src/lib/xhs-runner.ts`（登录/会话部分，+17 条用例）、`scripts/probe-xhs-publish-page.ts`（12 个模式）。

**验证**：`node --import tsx --test src/lib/xhs-browser.test.ts` → 10/10；`src/lib/xhs-runner.test.ts` → 17/17（201ms，**未启动任何真实浏览器**）；`npm run check` 双端 0 错 + 凭据扫描 624 文件干净。

**三处如实记录的偏差（都不是实现错，是我的判断/写法错）**：

1. **没有严格先红后绿**：`xhs-browser.ts` 是对已测模块 `toutiao-browser.ts` 的忠实移植（只换码值与 env 名），所以我**先写实现、后写用例**，用用例锁定移植后的契约。真正需要先红后绿的**新逻辑**是登录判定（Step 5–6），那部分按计划走了失败用例先行。
2. **两条我自己写错的用例**（都是断言错、不是实现错）：① 「显式配置路径不存在」那条，我的假 probe **一律返回 `true`**，于是那个路径被判为可用、测试变成测别的东西，还白等了 180 秒（`windowLoginTimeoutMs` 默认值）；已改为「如实报告该路径不存在」并把超时调成 50ms。② `loginInWindow` 的报错断言原本要求消息含「应用内扫码」，但显式配置报错走的是**另一条分支**（直接把路径报出来）；已拆成两条用例分别覆盖两个分支。
3. **一处设计收敛（偏离计划正文）**：浏览器解析抛的是 `XhsBrowserError`，而执行器其余部分抛 `XhsRunnerError` —— 两族码值本来就同一套。为避免「路由层要记得同时登记两个类」这个静默点，新增 `safeResolve()` 把前者收敛成后者（**码值与 status 原样保留**）。⇒ 服务层/路由层仍然按计划登记四类 `Xhs*Error`，但执行器对外只暴露一族。

**顺带确认的一件事**：注入 `openSession` 确实生效（那 180 秒的失败用例全程**没有**启动真实浏览器），这正是不重蹈头条那轮「注入键写错 → 测试里启动真浏览器 → 留下 5 个孤儿进程」覆辙的证据。

---

### Task 2: 平台登记与分派（后端只缺 4 处 + 1 个静默陷阱）

**Files:**
- Modify: `src/lib/publishing-platforms.ts`、`src/lib/publishing-service.ts`
- Test: `src/lib/publishing-platforms.test.ts`、`src/lib/publishing-service.test.ts`

**Interfaces:**
- Produces: `PUBLISH_NOTE_POLICIES.xiaohongshu`（title 20 / 正文 1000 / 话题 10）、`AUTO_PUBLISH_ROUTES` 新增 `{ contentType: "note", platform: "xiaohongshu", engine: "xhs" }`、`AutoPublishEngine` 联合类型含 `"xhs"`、`NOTE_PLATFORMS` 含 `xiaohongshu`、`assertNotePlatforms` 文案更新、分派分支 `autoPublishXhsNote`

- [x] **Step 1: 写失败用例**

- `validateNoteCopy("xiaohongshu", …)`：标题 21 字报错、正文 1001 字报错（**与抖音同一实现、只换政策来源**）。
- 守卫用例更新：`NOTE_PLATFORMS` **含 douyin 与 xiaohongshu、不含 wechat_mp 与 toutiao**（原 `deepEqual([...NOTE_PLATFORMS], ["douyin"])` **如期被打破** —— 这正是它存在的意义）。
- `resolveAutoPublishEngine("note", "xiaohongshu") === "xhs"`；三组合互不触碰。
- ⚠️ **`note × xiaohongshu` 走 xhs 执行器、且绝不碰 sau runner**（用假的 sau runner 断言「一次都没被调用」）。
- `assertNotePlatforms(["wechat_mp"])` 仍返回 422 且文案说明「不支持哪些平台」。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts`
Expected: FAIL —— `xiaohongshu` 尚未接入图文。

- [x] **Step 3: 实现**

1. `PUBLISH_NOTE_POLICIES` 加 `xiaohongshu` 条目（`creatorUrl` 用 `https://creator.xiaohongshu.com/publish/publish`，与 `PUBLISH_PLATFORMS.xiaohongshu` 一致）。
2. `AUTO_PUBLISH_ROUTES` 加一行；`AutoPublishEngine` 自动扩展。
3. `NOTE_PLATFORMS` 加 `xiaohongshu`；`assertNotePlatforms` 的 422 文案改为「目前只支持抖音图文与小红书图文」。
4. `publishing-service.ts:330` 的默认文案**按平台取政策**（现在硬编码 `PUBLISH_NOTE_POLICIES.douyin`）。
5. ⚠️ **分派加显式分支，且在兜底之前**：

```ts
if (engine === "toutiao") return this.autoPublishToutiaoArticle(taskId, input, actor);
if (engine === "xhs") return this.autoPublishXhsNote(taskId, input, actor, detail);  // ← 必须在兜底前
return this.autoPublishNoteTask(taskId, input, actor, detail);                        // ← 兜底是 sau
```

- [x] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts src/lib/publishing-service.test.ts`
Expected: PASS，**既有 publishing 用例全绿**（回归门禁）。

---


#### Task 2 执行记录（2026-09-20）

**改动的文件**：`src/lib/publishing-platforms.ts`（`PUBLISH_NOTE_POLICIES.xiaohongshu` + 通路表加 `note:xiaohongshu=xhs`）、`src/lib/publishing-service.ts`（`NOTE_PLATFORMS` 加平台、`assertNotePlatforms` 文案、`noteCopyLimits(platform)`、**分派改穷尽 switch** + `autoPublishXhsNote` 缝隙）。

**验证**：`src/lib/publishing-platforms.test.ts` **21/21**；全部 `publishing-*.test.ts` **166 通过 / 1 失败**，那 1 条正是既有基线失败 —— 已用 `git stash push -- <两个改动文件>` 回到 HEAD 复跑该用例**同样失败**，实证与本轮无关（改动已 `stash pop` 恢复）。`npm run check` 双端 0 错 + 凭据扫描 624 文件干净。

**三处比计划更严/更不同的做法**：

1. **分派不是「在兜底之前加一个分支」，而是彻底去掉兜底**：改成 `switch (engine)` 的**穷尽写法**，`default` 里用 `const exhaustive: never = engine` 做编译期检查。收益是**将来再加引擎时编译器会直接报错**，而不是让新引擎悄悄落进某个已有分支。实测有效：加完 `"xhs"` 后 `tsc` 立刻报 `Property 'autoPublishXhsNote' does not exist`，逼出了下面第 2 条。
2. ⚠️ **`autoPublishXhsNote` 当前是「明确拒绝」而不是「占位成功」**：平台登记一落地，「原先靠 `resolveAutoPublishEngine` 返回 null 挡住」的保护就消失了；若不显式拦住，请求会**静默落进 sau 分支**（把小红书图文交给抖音的 CLI）。所以它现在做「先判类别、再判配置」的存在性检查后，以 **422 `publish_xhs_not_implemented`** 明确拒绝。**Task 7 会把这个方法体换成完整编排** —— 这是一处**已披露的临时缝隙**，且它的失败方向是 fail closed（明确拒绝），不是静默走错通路。
3. **外加一条计划没有的守卫**：`noteCopyLimits` 返回值是**单数**的 `copyLimits`（一张表），只在「两个图文平台口径相同」时成立。所以补了一条用例断言 **douyin 与 xiaohongshu 的图文口径当前必须相同** —— 谁改窄/改宽其中一个，用例先红，逼着改动者把 `copyLimits` 改成按平台下发，而不是让界面显示「12/20」而后端按另一套校验。

**两条我自己写错的用例（都是断言错、不是实现错）**：

1. 手写了一段「20 字」的中文标题用来测边界，**实际是 26 字** —— 于是用例把「超限报错」当成了「边界合法」。已改用 `"字".repeat(20)`：数字自己会说话，别靠人眼数。
2. 我写了「同一段 21+ 字标题在**视频口径**下合法」来证明两条口径分开 —— 但 `PUBLISH_PLATFORMS.xiaohongshu.titleMax` **本来就是 20**（它当年作为**人工交付**平台接入时就设成 20 了），那个前提只对抖音成立（55）。已改成断言「小红书有**自己的一份**政策对象（不与抖音共用引用）」+ 上面那条「当前必须相同」的守卫。

**仍未做（如实记录）**：计划 Task 2 Step 1 里那条「`note × xiaohongshu` 走 xhs 执行器、**且绝不碰 sau runner**」的**运行时 spy 用例**留到 **Task 7** —— 那时 `autoPublishXhsNote` 才是真编排，spy 断言才有意义；现在只由「穷尽 switch + 编译期检查」结构性保证（已实测编译器确实拦住）。`publishing-service.test.ts` 里本来就没有 auto-publish 用例（那类测试在路由层），所以这条不能顺手加。

---

### Task 3: 包模型与指纹（`xhsOptions`，含兼容性守卫）

**Files:**
- Modify: `src/types.ts`、`src/lib/publishing-store.ts`
- Test: `src/lib/publishing-store.test.ts`

**Interfaces:**
- Produces: `XhsNoteOptions { aiDeclaration: boolean; submit: boolean }`；`DeliveryPackage.xhsOptions?: XhsNoteOptions`；`packagePreviewRevision()` 的 note 分支纳入它（**仅存在时**）

- [x] **Step 1: 写失败用例**

- ⚠️ **兼容性守卫（最重要的一条）**：**不含 `xhsOptions` 的图文包，其 `previewRevision` 与本次改动前逐字节相同**（把改动前的期望哈希**写死**在用例里当 baseline）。
- 改 `aiDeclaration` → revision 变化；改 `submit` → revision 变化（防「预览时没勾、提交时勾了」被绕过）。
- 存档校验：`xhsOptions` 形状非法（非布尔）→ 读取时拒绝，不静默丢弃。
- 不传 `xhsOptions` 时，抖音图文包与视频包行为**一字不变**。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-store.test.ts`
Expected: FAIL。

- [x] **Step 3: 实现**

note 分支里**只在 `packageRecord.xhsOptions !== undefined` 时**追加哈希（例：`xhsAiDeclaration:1\0` / `xhsSubmit:0\0`）。加注释写明「无条件追加会改掉所有既有抖音图文包的 revision —— 那种红是『口径被悄悄改了』，不是功能坏了」。

- [x] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/publishing-store.test.ts`
Expected: PASS，且 baseline 用例证明既有哈希未变。

---


#### Task 3 执行记录（2026-09-20）

**改动的文件**：`src/types.ts`（`XhsNoteOptions` + `DeliveryPackage.xhsOptions`）、`src/lib/publishing-store.ts`（`packagePreviewRevision` 的 note 分支**仅存在时**哈希、`isXhsNoteOptionsShape` 存档形状校验）。

**验证**：`src/lib/publishing-store.test.ts` **52/52**（新增 3 条）；`npm run check` 双端 0 错 + 凭据扫描 624 文件干净。

**兼容性基线（这条是 Task 3 的核心）**：把改动前的两个哈希**逐字节写死**在用例里当 baseline ——
`note = 556e908c…0abb`、`video = 0007ffeb…918d`。它们是用**真实夹具**跑出来的，不是手抄副本。

**一处我自己踩的坑（值得记）**：我为了取 baseline 写了个临时脚本（`scripts/.tmp-baseline-hash.ts`，用完即删），
**在里面手抄了一份 `packageRecord()`** —— 结果 `videoSha256` 与真实夹具不一致，于是「基线」本身是错的，
写进用例后**基线用例自己先红**。教训：**baseline 必须从真实夹具上取**。现在用例里留了注释说明这一点。

**顺带确认**：`xhsOptions: undefined` 与「压根不给这个字段」**完全等价**（两种形态都会出现在存档里），有用例断言。

---

### Task 4: 3:4 裁切（`note-media.ts`，平台中立 —— 见 Task 4 执行记录里的改名说明）

**Files:**
- Create: `src/lib/note-media.ts`
- Test: `src/lib/note-media.test.ts`

**Interfaces:**
- Produces: `XhsMediaService.prepareNoteImage(srcPath, outDir, index)`（1080×1440 JPEG，产物大小校验，失败即删不留半成品）、`XhsMediaError` + 错误码、`XHS_NOTE_IMAGE_LIMITS`

- [x] **Step 1: 写失败用例（假 ffmpeg stub）**

- 滤镜字符串断言为 `scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440`（**覆盖后居中裁**，不交给平台随机裁）。
- ffmpeg 退出码 0 但**没产出文件** → 报错（不许当成 0 字节的成功）。
- 失败时**产物被删掉**（stub 先写产物再失败，否则这条断言等于没测）。
- 源图缺失 / 超过 32MB → 各自的明确错误码。
- 最大张数常量与 `MAX_NOTE_IMAGES`（35）**不同**这件事有断言：小红书侧是 **18**。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/note-media.test.ts`
Expected: FAIL。

- [x] **Step 3: 实现（照 `toutiao-media.ts` 的形状，错误码独立）**

不修改 `wechat-media.ts` / `toutiao-media.ts`（已测模块的契约不动）；`ffmpegBinary` 空串时报 `xhs_media_ffmpeg_unavailable` + 安装指引。

- [x] **Step 4: 用真实 ffmpeg 实测一次（stub 证明不了滤镜语法）**

Run: 生成一张 1080×1920 纯色图 → `prepareNoteImage()` → `ffprobe` 校验为 **1080×1440**、比例 0.75、源文件 sha256 前后一致。
Expected: 通过，并在 spec/计划里记下实测数字（公众号那轮的教训：stub 全绿不等于滤镜对）。

---


#### Task 4 执行记录（2026-09-20）

**产物**：`src/lib/note-media.ts`（改名后 10 条用例）。

**验证**：`src/lib/note-media.test.ts` **10/10**（含一条「不加平台专属导出」的守卫）；`npm run check` 双端 0 错 + 凭据扫描 626 文件干净。

**真实 ffmpeg 实测（Step 4，四种输入，全部通过）**：

| 源 | 产物 | 源文件是否被改动 |
| --- | --- | --- |
| `png 1080×1920`（我们的场景静帧，9:16） | `mjpeg 1080×1440`（3:4）18KB | ✅ 未改动 |
| `png 1920×1080`（16:9 横图） | `mjpeg 1080×1440` 18KB | ✅ |
| `png 1200×1200`（1:1） | `mjpeg 1080×1440` 18KB | ✅ |
| `png 2400×2400` **纯噪声 8.2MB**（最难压） | `mjpeg 1080×1440` **807KB** | ✅ |

结论：`scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440` **语法正确、四种比例都居中裁对**，且最难压的噪声图也远低于 32MB 上限（807KB vs 32MB）。产物命名 `note-01.jpg…note-18.jpg`（补零，保证字典序 == 场景序）。

**✅ 接线位置已于 2026-09-20 拍板：方案甲（打包时裁）**，并据此把模块改名为**平台中立**的 `note-media.ts`
（去掉平台专属的 `maxImages`/`accept`：18 张与格式白名单留在小红书那侧）。改名后用例 **10/10**。
接进打包层的动作见 **Task 7 的 Step 3b**。

**（原始记录）当时尚未决定的接线位置**：

3:4 裁切插在**哪一步**是一个**产品决策**，我没自己拍：

| 方案 | 含义 | 代价 |
| --- | --- | --- |
| **甲：打包时裁**（note 包的 `images/` 直接是 3:4） | 预览看到的就是发出去的；`previewRevision` 天然覆盖 | **会改变既有抖音图文包的图片**（douyin 那条路目前直接用 9:16 静帧） |
| **乙：提交时裁**（只在小红书上传前派生 3:4） | 抖音那条路一行不动 | **预览与实际漂移**（预览是 9:16、发出去是 3:4），而本仓明确禁止这种漂移 |
| 丙：只对「含小红书的图文包」在打包时裁 | 折中：抖音单平台的包不变 | 同一个包的图片比例取决于平台选择，语义更绕 |

**建议甲**（与既有「预览即所见」的口径一致，且 3:4 在抖音图文上同样是更优比例），但这会**改动一条已经上线的通路的产物**，所以必须由用户拍板 —— 已列入 spec §15 待决项。

---

### Task 5: 页面步骤（`xhs-page.ts` + 离线 fixture + 真浏览器用例）

**Files:**
- Create: `src/lib/xhs-page.ts`
- Create: `src/lib/fixtures/xhs-publish-page.html`（**从真实快照 `storage/xhs/recon/publish-page-after-upload.html` 逐段抠出来**）
- Test: `src/lib/xhs-page.test.ts`

**Interfaces:**
- Produces: `XHS_SELECTORS`、`ensureImageTab()`、`uploadImages()`、`fillTitle()`、`fillBody()`、`selectAiDeclaration()`、`clickPublish()`（返回 `{ clicked: boolean }`）、`XhsPageError` + 错误码

- [x] **Step 1: 从真实快照造 fixture**

把侦察快照裁成**自包含的静态 fixture**（去掉脚本与无关区域，保留：页签、上传区、标题框、TipTap 编辑器、声明下拉与其选项、工具栏、提交按钮区域）。⚠️ **页面侧代码一律用字符串下发**（tsx/esbuild 会给内联函数包 `__name(...)` 助手 → 页面里 `ReferenceError`；`dist/` 由 tsc 编译不受影响，所以这个坑只在 tsx 下出现）。

- [x] **Step 2: 写失败用例（真浏览器跑 fixture，照 `toutiao-page.test.ts` 的范式）**

- **两阶段渲染**：未上传时**标题框不存在** → `fillTitle()` 必须报「请先上传图片」这类**可执行**的错误，而不是一句「找不到元素」。
- **上传**：按 `accept` 挑文件框（**不能取 `.first`** —— 页面上有 3 个 file 框：2 图片 + 1 文档）；读回图片计数 ≥ 送入张数；超过 18 张直接报错。
- **标题**：先清空再写入，**读回必须等于要发的标题**（持久化 profile 可能恢复草稿）；读回不一致时报**字符级差异**（第 N 个字符起不同/少了/多了）。
- ⚠️ **清空输入框只按一个全选键**（`process.platform === "darwin" ? Meta+A : Control+A`）：macOS 上 `Ctrl+A` 是「移到行首」，会把选区塌缩掉，后续 Backspace 什么都删不掉。**别再加第二个全选键。**
- **正文**：`div.tiptap.ProseMirror` + `insertText`；读回**首段与末段都在**。
- **AI 声明**：点 `div.d-select-wrapper` → 点含「笔记含AI合成内容」的 `div.d-option` → **读回选中后的文案**；**选项不存在或选不中 → fail closed 且一个提交类按钮都没被点过**。
- **提交按钮**：`clickPublish()` 在找不到按钮时**返回 `{ clicked: false }` 并说明「未找到发布按钮、本次未提交任何内容」**，**绝不**写「已点击发布」。
- ⚠️ **反向断言（本条是刻意偏离头条的证据）**：`submit` 之后**没有向页面发起任何读取**（不抓 URL、不读文案、不轮询成功提示）。

- [x] **Step 3: 运行确认失败**

Run: `node --import tsx --test src/lib/xhs-page.test.ts`
Expected: FAIL。

- [x] **Step 4: 实现（选择器全部用 Task 1 侦察到的真值）**

已验证真值（2026-09-20 实测）：页签 `.creator-tab`（文案「上传图文」）、上传 `input[type=file][accept*=".jpg"]`、标题 `input.d-text[placeholder*="标题"]`（原文「填写标题会有更多赞哦」）、正文 `div.tiptap.ProseMirror[contenteditable="true"]`、话题入口 `button#topicBtn.contentBtn.topic-btn`、声明 `div.d-select-wrapper`（⚠️ 页面把属性写成 `lass="declaration-wrapper"`，按 class 找不到）、声明选项 `div.d-option`。
**执行顺序必须是：进图文页签 → 上传图片 → 填标题 → 填正文 → 选 AI 声明 →（可选）点发布。**

⚠️ **提交控件（姿态甲）没有选择器可用**：`xhs-publish-btn` 是 **closed shadow root** 的自定义元素，
必须按**宿主包围盒 + 相对偏移坐标点击**（「发布」≈ (0.607, 0.5)、「暂存离开」≈ (0.396, 0.5)），
并在点击前校验 `submit-disabled === "false"`。**用例里要有一条断言「选择器定位必然失败」**（`getByRole`/`>> text=` 均为 0），
把「为什么用坐标」这件事锁进测试，免得后人"顺手改回选择器"。

- [x] **Step 5: 运行确认通过**

Run: `node --import tsx --test src/lib/xhs-page.test.ts`
Expected: PASS（真浏览器 + fixture，全部用例）。

---


#### Task 5 执行记录（2026-09-20）

**产物**：`src/lib/xhs-page.ts`（414 行）、`src/lib/fixtures/xhs-publish-page.html`（241 行）、`src/lib/xhs-page.test.ts`（278 行，**19 条用例，全部真浏览器跑 fixture**）。

**验证**：`node --import tsx --test src/lib/xhs-page.test.ts` → **19/19**；`npm run check` 双端 0 错 + 凭据扫描 629 文件干净。

**fixture 的保真度**（它决定了这些用例有多少价值）：结构、类名与文案全部照真实快照
（页签 `.creator-tab` + `span.title`、`input.d-text[placeholder="填写标题会有更多赞哦"]`、
TipTap 编辑器、`div.d-select-wrapper` 声明下拉与「笔记含AI合成内容」选项、**3 个 file 框**），
并且**照抄了两处会让实现踩坑的真实细节**：
① 声明容器的属性名在真页被写成 **`lass="declaration-wrapper"`**（笔误）—— 所以按 class 找不到它；
② 提交控件是 `<xhs-publish-btn>` 自定义元素 + **closed shadow root**（`attachShadow({mode:"closed"})`）。

**✅ 用例真的抓到了一个我写错的 fixture**：第一版我用 `hidden` 藏表单，**元素其实还在 DOM 里**，
于是「未上传时找不到标题框」这条断言直接失效（`count()` 返回 1 而不是 0）。
真页是**压根不渲染**（实测 0 命中），改成 `<template>` + 上传时插入后才忠实 —— 这条用例的价值当场体现。

**⚠️ 一处必须记住的实现约束（已用测试锁住）**：真页实测 `getByRole("button", { name: "发布" })` = **0**、
`xhs-publish-btn >> text=发布` = **0**、`xhs-publish-btn button` = **0**（closed shadow root 不被任何定位器穿透）。
所以 `clickSubmit()` **只能按宿主包围盒 + 相对偏移做坐标点击**，偏移值来自真页实测
（宿主 680×90；「发布」≈(0.607, 0.5)、「暂存离开」≈(0.396, 0.5)）。
用例里专门有一条断言「**选择器定位必然失败**」，把「为什么用坐标」这件事钉进测试，免得后人"顺手改回选择器"。
**失败模式良性**：偏移若落到「暂存离开」＝存草稿离开，不会误发 —— 也有一条用例分别验证两个按钮各自会点中谁。

**两条我自己写错的地方（都是我的错，不是实现错）**：

1. 一条用例里把 `await` 写在了**非 async 的箭头函数**里（`assert.rejects(() => uploadImages(page, [await makeImage(...)]))`）→ esbuild 在**加载阶段**就报
   `"await" can only be used inside an "async" function`，整个文件 0/1。已把文件准备提到断言之外。
2. `selectAiDeclaration` 里逐项找「哪一个选项是 AI 声明」时，第一版写成了**每轮都取 `.first()`**
   —— 那等于**从来没在找**（首项不是 AI 就永远选不中）。写用例时自己发现，改成 `nth(index)`，
   并给定位器接口补了 `nth`。这条如果漏了，真机上的表现会是「选不中 AI 声明 → fail closed → 功能不可用」。

**仍未做（如实记录）**：话题联想弹层的容器、真实上传的服务器往返、点「发布」之后的确认页 ——
前两者留给真机演练；**后者按设计根本不做**（spec §9：点完不做任何读回）。

---

### Task 6: 执行器编排（`xhs-runner.ts`，含姿态开关）

**Files:**
- Modify: `src/lib/xhs-runner.ts`
- Test: `src/lib/xhs-runner.test.ts`

**Interfaces:**
- Produces: `publishNote(input, options?: { dryRun?: boolean })` → `XhsPublishResult { ok, message, steps: string[], submitted: boolean, verification: "unconfirmed" }`

- [x] **Step 1: 写失败用例（注入假 page）**

- **正常路径**：步骤逐条记录，顺序为 上传 → 标题 → 正文 → 声明 →（`submit:false` 时**到此为止**）。
- **`submit: false`（默认姿态乙）**：**一个提交类按钮都没被点过**，且 `submitted: false`；消息说明「已填好并保存为草稿，请到小红书 App 里核对后发布」。
- **`submit: true`**：点了提交；`verification` **恒为 `unconfirmed`**，消息写明「已点击发布，但按设计不做读回；请先到小红书 App 核实」。
- **登录态失效**：一步都不做就返回 `ok:false`。
- **AI 声明选不中**：fail closed，**没点提交**。
- **图片缺失/超限**：停在点发布之前，写明已完成到哪一步。
- **启动失败**：任意异常 → `ok:false`（绝不 500、绝不卡 `running`）。
- ⚠️ **反向断言**：`submit: true` 之后**没有任何页面读取调用**（§9）。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/xhs-runner.test.ts`
Expected: FAIL。

- [x] **Step 3: 实现**

`installExitCleanup()`（`exit`/`SIGINT`/`SIGTERM` 尽力关浏览器）；任何异常收敛成 `ok:false`；`dryRun` 模式与姿态开关共用同一条填表路径。

- [x] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/xhs-runner.test.ts`
Expected: PASS。

---


#### Task 6 执行记录（2026-09-20）

**产物**：`xhs-runner.ts` 新增 `publishNote()` 编排（+ `XhsPublishInput` / `XhsPublishResult`），
新增 `src/lib/xhs-runner-publish.test.ts`（**12 条用例**，全部注入假页面，不启浏览器）。

**验证**：`src/lib/xhs-runner-publish.test.ts` **12/12**；`npm run check` 双端 0 错 + 凭据扫描干净。

**编排顺序**（不能变，因为页面是分阶段渲染的）：
`进入发布页 → 上传图片（读回张数）→ 填写标题（读回逐字一致）→ 填写正文（读回首末段）→ 声明 AI 合成内容（读回）→（submit:false 停 / submit:true 点发布）`

**三条纪律各有专门的用例守着**：

1. **姿态开关**：`submit:false` → **一个提交按钮都没点过**（假页面记录鼠标点击，断言为空）；
   `dryRun:true` 即使调用方写了 `submit:true` 也不点。
2. ⚠️ **点完提交后不再碰页面**：假页面记录**每一次**页面操作，断言「`mouse.click()` 之后的操作日志**必须为空**」——
   这条反向断言把 spec §9（#715：让 AI 确认发布成功 → 第一次警告、第二次七天）钉死在测试里。
3. **失败停在点发布之前**：声明选不中、没有 AI 选项、图片没被接住、按钮禁用 —— 四条都断言**没点提交**。

**一处语义修正（我最初写错了）**：`steps` 只记**已经完成**的步骤，失败的那一步**不进 steps**（把没做成的算进去是撒谎）。
所以「停在哪一步」改由**失败消息**回答：`失败于「声明 AI 合成内容」。已完成：进入发布页 → 上传图片 → …`。
三者缺一不可：**原始原因 + 停在哪一步 + 已完成哪些**。用例断言了这个三段式。

**三条我自己写错的假页面（都不是实现错，是夹具错，最容易骗过自己）**：

1. 假页面**没有 `goto`**（我只加了 `url`）→ 编排第一步就 `page.goto is not a function`，10 条用例全红。
2. 假页面 `insertText` 里我加了个「`text === "标题"` 就 return」的 guard → 标题永远读回空串、重试三次后报 mismatch。
   **假页面不能对内容做特判**，否则测的就不是真实路径了。
3. 断言全都写成 `assert.equal(result.ok, true)` —— 失败时只说 `false !== true`，**看不出原因**。
   改成 `assert.equal(result.ok, true, result.message)` 之后，上一条问题立刻自己暴露出来。
   ⇒ 教训：**断言要带上下文**，否则排查成本全落在下一次运行上。

**顺带做的一处类型收敛**：`session.page` 同时被页面步骤（`locator/keyboard/mouse`）与会话（`goto/url`）两套接口使用，
所以编排里用交集类型 `XhsPublishPageLike & XhsPageLike` —— 它们本来就是同一个真实 page 对象的两面，
分模块只是为了各自能被独立测试。

---

### Task 7: 服务层与路由（频率闸门、校验、错误边界）

**Files:**
- Modify: `src/lib/publishing-service.ts`、`src/lib/publishing-routes.ts`
- Modify: `src/app.ts`、`src/server.ts`、`electron/server.ts`（`XHS_BROWSER_BINARY` / `XHS_PROFILE_DIR` 透传）
- Test: `src/lib/publishing-service.test.ts`、`src/lib/publishing-routes.test.ts`

**Interfaces:**
- Produces: `autoPublishXhsNote()`；`Xhs*Error` 在错误边界登记；env 透传两条入口

- [x] **Step 1: 写失败用例**

- **频率闸门**：当日已有 1 条 `succeeded` 的小红书 `autoPublish` → 第 2 次返回 **422** 且**不产生新记录**；跨过本地自然日边界后可再发一条。
- **图片上限**：图文包 19 张 → 小红书提交返回 422（**同一包抖音那侧仍按 35 张口径**）；**预览接口也要按平台下发上限**（`imageLimit: 18`，供界面渲染与禁用态），有用例断言预览下发的是 18 而不是 35。
- **AI 声明缺失**：`xhsOptions.aiDeclaration !== true` → 422（**在点任何页面操作之前**拒绝）。
- **`previewRevision` 契约**：不带 → 400；带过期值 → 409 且**不产生 `autoPublish` 记录**；带正确值 → 通过。**用例必须真的打一次 `GET /publishing/packages/:id/preview` 拿 revision**（不许直接读 store —— 头条那轮就是这么把「预览接口 500」整个绕过去的）。
- **错误边界**：`XhsRunnerError` / `XhsBrowserError` / `XhsPageError` / `XhsMediaError` 各自**带自己的 `status` + `code` + 指引**，**不是**兜底 500。用例名：`xhs runner errors surface with their own status, code and guidance`。
- **失败落库**：启动失败、以及**任何意外原始错误** → 都记 `failed`，**绝不** 500 + 卡 `running`。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-service.test.ts`
Expected: FAIL。

- [x] **Step 3: 实现**

先判输入类别、再判配置（照既有纪律）；频率闸门与并发互斥在同一次 `mutate` 里完成（校验失败不留记录）；提交前比对包内图片 sha256；`Xhs*Error` 登记进 `publishing-routes.ts` 的错误边界，并给兜底分支保留 `console.error`。

- [x] **Step 3b: 把 3:4 裁切接进**打包层**（方案甲，2026-09-20 拍板）**

**Files:** Modify `src/lib/publishing-assets.ts`（`createNotePackageAssets` / `stageNoteContent` 的图片暂存段）、`src/lib/publishing-service.ts`（注入 `noteMedia`）。

- 图文包打包时，**每张源图先经 `NoteMediaService.prepareNoteImage()` 裁成 `note-01.jpg…`**，再按原有纪律
  复制进包并逐张校验 sha256、算有序清单哈希。
- ⚠️ **这会改变既有抖音图文包的图片**（原先直接复制 9:16 静帧）—— 这是已拍板的代价，**必须有回归用例**：
  ① 图文包产物是 **1080×1440**；② **视频包打包产物一字不变**（既有精确 manifest baseline 用例保持通过）。
- 打包层**不自己调 ffmpeg**：它接收一个已准备好的图片目录（照 `wechat-media` 那条「打包层不转码」的纪律 ——
  打包事务里只做复制+哈希+校验，`runCommand` 在打包用例里会直接抛错，专门守住这点）。
- 裁切失败 → 整个建包失败并回滚（沿用既有 `withStagedPackage` 的暂存目录事务），不留半成品。

- [x] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/publishing-service.test.ts src/lib/publishing-routes.test.ts src/lib/publishing-assets.test.ts`
Expected: PASS，且既有视频包 manifest 精确哈希 baseline 不变。

---


#### Task 7 执行记录（2026-09-20，**部分完成**）

**已完成**（服务层 + 装配 + 错误边界 + 路由用例）：

| 位置 | 改动 |
| --- | --- |
| `publishing-service.ts` | `deps.xhs`；`requireXhsRunner()`；`XHS_DAILY_PUBLISH_LIMIT = 1`；`isSameLocalDay()`；`countXhsPublishesToday()`；**把「明确拒绝」的缝隙换成完整编排**（AI 声明 → 图片完好/张数 → 频率闸门 → beginAutoPublish → 执行器 → 落记录） |
| `publishing-routes.ts` | **登记 `XhsRunnerError` / `XhsBrowserError` / `XhsPageError`**；建包路由接受并校验 `xhsOptions`（`aiDeclaration` 必须是布尔，`submit` 缺省 false） |
| `app.ts` / `types.ts` | 构造 `XhsRunner` 并注入（`xhsRunner` / `xhsBrowserBinary` / `xhsProfileDir` / `xhsAllowSystemChrome`）；`CreatePublishingPackageInput.xhsOptions` |
| `app.test.ts` | **新增 5 条路由级用例**（`fakeXhsRunner` + `xhsNoteFixture` 夹具） |

**验证**：新增 5 条 **5/5**；全量 **852 项 / 850 通过 / 1 失败 / 1 跳过**（那条失败是既有基线）；`npm run check` 双端 0 错 + 凭据扫描 630 文件干净。

**5 条用例覆盖的东西**（每条都对着一条真实风险）：
1. 走**预览接口**拿 revision → 提交 → succeeded，**任务状态仍是 ready**（机器只记已提交）；
2. **没声明 AI → 422 且不产生 autoPublish 记录**，且**执行器一次都没被调用**（合规红线在点任何页面前就拦）；
3. **当日第二篇 → 422**（频率闸门），第二次连执行器都不碰；
4. **执行器抛错 → 记 failed，不是 500、`finishedAt` 已写**（绝不卡在 running）；
5. 执行器报「没填成」→ 记 failed 且任务状态不变。

**⚠️ 未完（如实记录，Task 7 不能算完）**：

- **Step 3b「把 3:4 裁切接进打包层」尚未做** —— 那是方案甲的落地（`createNotePackageAssets` / `stageNoteContent` 先过 `NoteMediaService`），
  且必须有两条回归用例：① 图文包产物是 1080×1440；② **视频包打包产物一字不变**。
- **图片 19 张 → 422 的路由级用例**尚未写（服务层闸门已实现；夹具目前只造得出固定的静帧数，需要扩夹具）。
- 计划里那条 `xhs runner errors surface with their own status, code and guidance`（错误边界）**对小红书没有 HTTP 入口**：
  小红书不像头条那样有独立的登录/自检路由，执行器错误在服务层被收敛成 `failed` 记录。
  错误边界的登记因此是**防御性**的（将来若加小红书登录路由或有人绕过 `autoResolve`，不至于掉进兜底 500）。
  ⇒ 这条用例要么改为服务层级断言，要么等小红书登录路由落地后再补；**已在计划里标注，不假装它存在**。

---


#### Task 7 Step 3b 执行记录（2026-09-20，方案甲落地）

**接线方式（与计划正文略有不同，更省改动的做法）**：裁切放在**服务层**，打包层一行未改。

原计划写的是「打包层先过 `NoteMediaService`」。实际实现里我把它放在服务层，原因是：
打包层的事务只做「复制 + 逐张 sha256 校验 + 清单哈希」这条安全加固过的路径，
往里面塞 ffmpeg 子进程会破坏那条纪律（`publishing-assets.test.ts` 注入的 `runCommand` 会直接抛错，专门守这点）。
所以服务层先把源图裁到一个临时工作目录，再把**裁好的绝对路径**作为 `sourceImagePaths` 显式传给打包层 ——
打包层照旧执行它那套事务，只是素材来源换成了裁切产物。

为此顺带修了一处**过时注释**：`NoteImagePlan.sourceImagePaths` 原写着「仅素材库来源……静帧由打包层自行收集」，
方案甲之后静帧的绝对路径也必须在服务层就拿到，于是 `listSceneSnapshots()` 改成连绝对路径一起返回。

**改动的文件**：`publishing-service.ts`（`NoteImagePreparer` + `deps.noteMedia`/`deps.ffmpegBinary` + `prepareNoteImages()` + `listSceneSnapshots` 返回绝对路径）、
`app.ts`（`ServerConfig.noteMedia` + 把 `config.ffmpegBinary` 透传给服务）、`note-media.ts`（**输出改 PNG**，见下）、
`publishing-service.test.ts`（夹具注入直通预处理 + 2 条新用例）、`app.test.ts`（夹具注入直通预处理 + 更正一条误导性注释）。

**产物格式从 JPEG 改成 PNG（有实测依据，不是随手改）**：我们的图是 HyperFrames 渲染的**文字密集帧**，
JPEG 会在字边留伪影；实测同一张锐利帧裁成 3:4 后 **PNG 211KB vs JPEG(q3) 152KB —— 只大 39%**，
相对「单图 ≤32MB、一次 ≤18 张」（18 张约 3.8MB）完全不是问题。顺带保住 `.png` 后缀，
包内 `images/01.png` 这类既有路径与断言都不用改。

**验证**：全量 **855 项 / 853 通过 / 1 失败 / 1 跳过**（那条失败是既有基线）；`npm run check` 双端 0 错 + 凭据扫描 630 文件干净。
- `note-media.test.ts` **11/11**，含一条**真实 ffmpeg 端到端**用例：1080×1920 → 断言 ffprobe 读到 `png,1080,1440`、源文件 sha256 前后一致；
- `publishing-service.test.ts` **30/31**（+2 条新用例：包内图片**确实取自裁切产物**、裁切失败**整体回滚且不产生包记录**）；
- `publishing-assets.test.ts` **48/48**（含那条**视频包 manifest 逐字节固定**的既有 baseline —— 即计划要求的「视频包一字不变」）；
- `app.test.ts` **77/77**（既有图文包用例 + 5 条小红书路由用例）。

**⚠️ 一处如实记录的取舍**：`app.test.ts` 与 `publishing-service.test.ts` 的夹具注入的是**直通**预处理，
所以那两条「包内图片与源文件逐字节一致」的断言**只在测试里成立**。我在 `app.test.ts` 那条断言上方写明了这一点，
并指向真正验证裁切的用例 —— 否则后人会把「逐字节一致」当成生产事实（甲之后它不是）。

**图片 19 张 → 422 的路由级用例（2026-09-21 补上）**：见下面的收尾记录。

---

### Task 8: 渲染层（渠道并成「图文（抖音 / 小红书）」+ 动作 + 风险文案）

**Files:**
- Modify: `renderer/src/utils/publishing.ts`、`renderer/src/pages/PublishingPage.tsx`、`renderer/src/components/CreateNotePackageDialog.tsx`、`renderer/src/components/PublishPreviewDialog.tsx`
- Test: `renderer/src/utils/publishing.test.ts`

**Interfaces:**
- Produces: `PUBLISH_CHANNELS` 的 note 渠道改为 `platforms: ['douyin','xiaohongshu']`、标签「图文」；动作「提交到小红书（必经预览）」与「填写到小红书（不提交）」；`xhsOptions` 的表单控件；风险告知文案

- [x] **Step 1: 写失败用例（渲染层纯函数）**

- note 渠道 `platforms` 含两个平台 → `channelPlatformOptions("note")` **返回非空**（平台下拉出现；符合既有「单平台渠道不显示平台下拉」的约定）。
- 渠道标签为「图文」，`emptyHint` 里给出**可照抄的入口**（作品详情页 → 创建图文包）。
- 计数用例：渠道包数与状态计数仍来自**不带状态筛选**的那次请求（不许在已筛选列表上再数）。
- `setView()` 合并 query：改 status 不冲掉 `channel`。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts`
Expected: FAIL。

- [x] **Step 3: 实现**

- 渠道：`{ id: 'note', label: '图文', platforms: ['douyin','xiaohongshu'], hint: … }`；说明行必须写清「抖音由外部 sau 引擎提交；小红书由自研执行器填写，**默认只到草稿、由你在 App 里点发布**」。
- 动作：`submit-xhs`（必经预览）与 `fill-xhs`（`submit:false`）；**不提供**「编辑文案」（与头条同一理由：会与包内内容漂移）。
- 风险告知（**必须出现**）：「自动化发布违反平台规则，**风险由你的账号承担**，平台可能警告、限流或封号；本工具无法保证安全。」

- [x] **Step 4: 运行确认通过**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts`
Expected: PASS。

---


#### Task 8 执行记录（2026-09-20，**部分完成 —— 界面还不能端到端用**）

**已完成**：

| 位置 | 改动 |
| --- | --- |
| `renderer/src/utils/publishing.ts` | `PUBLISH_CHANNELS` 的 note 渠道 → **id `note`、标签「图文」、platforms `['douyin','xiaohongshu']`**（多平台 ⇒ `channelPlatformOptions` 自动长出平台下拉）；hint 写明「小红书默认只填到草稿」+ **风险自负**；新增动作 `fill-xhs` / `submit-xhs`；blocker 加小红书合规闸门 |
| `renderer/src/services/api.ts` | `autoPublishPublishingTask(taskId, revision, { dryRun })` |
| `renderer/src/pages/PublishingPage.tsx` | 两个动作的标签与处理器（都走「必经预览」，`fill-xhs` 带 `dryRun`）；预览态新增 `dryRun`；成功提示按 dryRun 区分文案 |
| `renderer/src/types/index.ts` | `XhsNoteOptions` + `DeliveryPackage.xhsOptions` |
| 后端（为支撑 `fill-xhs`） | `autoPublish` 的 body 接受 `dryRun?: boolean`；**非小红书通路用它一律 400**（静默忽略会让调用方以为只是演练、实际却发出去了）；执行器把它当作**只减不增**的覆盖 |

**验证**：渲染层 `publishing.test.ts` **45/45**（+4 条新用例）；全量 **859 项 / 857 通过 / 1 失败 / 1 跳过**（那条失败是既有基线）；`npm run check` 双端 0 错 + 凭据扫描 630 文件干净。

**两个动作的语义（这里是设计取舍，不是随手定的）**：
- `fill-xhs`「填写到小红书（不提交）」**永远可用** —— 它带 `dryRun`，**服务端强制不点发布**，与包的设置无关；
- `submit-xhs`「发布到小红书」**只在包自己声明了 `xhsOptions.submit === true` 时才给** ——
  因为「要不要真发出去」是包上的声明、且**已进 `previewRevision`**。给一个「会真提交」的按钮去动一个
  声明了「只填草稿」的包，等于绕过预览指纹，也会让按钮文案撒谎。

**⚠️ 未完成（所以 Task 8 不能算完，功能在界面上还走不通）**：

**建包向导 `CreateNotePackageDialog` 还没有平台选择、也没有 `xhsOptions` 控件。**
现状是 `notePackage.ts` 的 `buildNotePackageInput()` 里**硬编码** `platforms: [{ platform: 'douyin' }]`
—— 也就是说**界面上根本建不出小红书图文包**（只能靠 API 直接建，路由级用例就是这么做的）。
要做完需要：① 向导加平台多选（抖音/小红书）；② 选中小红书时出现「声明笔记含AI合成内容」（默认勾选）
与「创建后由程序点发布」（默认关）；③ 这两个值进 `buildNotePackageInput` 的请求体；
④ reducer/校验/用例跟着扩。

**顺带修的渲染层文案问题**：渠道 hint 我一开始写成了 `**默认只填到草稿**` 这种 markdown 记号 ——
React 会把它当**字面星号**渲染给用户（本项目在文案链路上踩过同类坑）。已去掉，并加了一条用例断言
「面向用户的 hint 里不许出现 `**`」。

---


#### Task 8 收尾：建包向导的平台选择与小红书选项（2026-09-21）

**背景**：Task 8 第一次记录时明确写了「界面上根本建不出小红书图文包」—— `notePackage.ts` 的
`buildNotePackageInput()` 里**硬编码** `platforms: [{ platform: 'douyin' }]`，向导里连平台选择都没有。
这一步把它补上，功能才在界面上真正可用。

**改动的文件**：
- `renderer/src/utils/notePackage.ts`：新增 `NOTE_AUTOMATION_PLATFORMS`、`toggleNotePlatform()`、`getNotePlatformBlocker()`；
  `buildNotePackageInput()` 改为接受 `platforms` 与 `xhsOptions`；
- `renderer/src/components/CreateNotePackageDialog.tsx`：容器加三个状态（平台数组、AI 声明、是否由程序点发布）、
  `NotePackageForm` 加「发布平台」区块与小红书两个开关，并把平台闸门纳入 `canCreate`；
- `renderer/src/types/index.ts`：`CreatePublishingPackageInput.xhsOptions`；
- 用例：`notePackage.test.ts` +3、`CreateNotePackageDialog.test.tsx` +3。

**三个刻意的口径**：

1. **`xhsOptions` 只在选了小红书时才进请求体**：它进 `previewRevision`，给纯抖音包塞上会让两个平台的包指纹口径不一致（语义上也是噪音）。有用例断言「即使调用方传了，纯抖音包的请求体里也不许出现它」。
2. **不允许把最后一个平台取消掉**：一个平台都不选的包没有意义，服务端也会 400。`toggleNotePlatform` 在这种情况下返回原数组，且平台顺序按固定表排（不随点击顺序抖动，请求体才可比）。
3. **AI 声明默认勾选、程序点发布默认不勾**：与后端默认姿态一致（spec §10/§11）。取消 AI 声明时**创建按钮直接禁用并给出原因**——不是等提交后吃 422。

**默认行为（用户什么都不改时会怎样）**：只勾抖音 → 行为与改造前**完全一致**（请求体里没有 `xhsOptions`、平台只有 douyin）。
这是刻意的：小红书是**新增**通路，不该改变既有抖音图文包的创建语义。

**验证**：渲染层相关用例 **58 → 64 全绿**（`notePackage` 10、组件 6、`publishing` 45 等）；
`npm run check` 双端 0 错 + 凭据扫描 630 文件干净。

---


#### Task 7 收尾：图片张数的双口径（2026-09-21）

**补的东西**：

1. **预览下发的 `imageLimit` 改成按平台取最严的那个**：选中小红书 → **18**，否则打包层的 35。
   原先无论选哪个平台都下发 35，于是界面会放用户选到 19 张，等到提交才吃 422 —— 那是「让用户白干一遍」。
2. **路由级用例**：`小红书图文：19 张图片在**提交**时被拦下（422），且不产生记录、不惊动执行器`。
   它一次覆盖四件事：
   - 预览接口下发的是 **18**（而不是 35）；
   - **创建仍然成功**（打包层上限 35）—— 「能不能建包」与「能不能发到小红书」是两件事，刻意分开；
   - 提交时 422 + `publish_xhs_too_many_images`；
   - **不产生 `autoPublish` 记录**，且假执行器**一次都没被调用**。

**验证**：全量 **866 项 / 864 通过 / 1 失败 / 1 跳过**（那条失败是既有基线）；`npm run check` 双端 0 错 + 凭据扫描 630 文件干净。

**一处如实记录**：这条用例上传了 19 张真实素材（1080×1920 的合成 PNG，走的是素材库上传接口），
所以它比其它路由用例慢一些（约 350ms）—— 这是为了走**真实链路**（素材库 → 预览 → 建包 → 提交），
而不是把 19 张塞进夹具的内存索引。

---

### Task 9: 全量验证、编译与真机演练（**最后一步由用户执行**）

- [x] **Step 1: 全量门禁**

Run: `npm run check && npm test`
Expected: 双端类型 0 错、凭据扫描通过；全量用例通过（**记录基线与新增数**，既有 1 条 `publishing-service.test.ts` startup recovery 基线失败与本轮无关）。

- [x] **Step 2: 编译两套产物**

Run: `npm run build:backend`（动了 `electron/server.ts` 则再 `npm run build:electron`）
Expected: 均成功；`grep -c XHS dist-electron/server.js` ≥ 1（若动过主进程）。

- [x] **Step 3: 真机演练（**只填不发布**）**

Run: `node --import tsx scripts/probe-xhs-publish-page.ts --tab --upload-dummy --dry-run`
Expected: 逐步读回全部 ✅、AI 声明选中并读回 ✅、**未点发布**。之后到创作中心确认草稿箱里有那条草稿。

- [ ] **Step 4: 由用户决定是否真实提交**

**这一步不由 agent 执行。** 若用户选择姿态甲，先在应用里用真实图文包走一次「提交到小红书」（必经预览），然后**到小红书 App 核实**是否发出：
- 确认发出 → 点「标记已发布」；
- 未发出 → 再决定是否重试（**任何重试前先确认上一次是否已发出**，重复发布是本功能最大的风险）。

- [ ] **Step 5: 清理侦察遗留物**

删除草稿箱里那条「测试标题（可删除）」草稿与假图；确认 `storage/xhs/recon/` **不进 git**（`storage/` 已在 `.gitignore`）。

---


#### Task 9 执行记录（2026-09-21）：门禁 + 编译 + 真机演练

**Step 1 全量门禁**：`npm run check` 双端 0 错 + 凭据扫描 630 文件干净；`npm test` **866 项 / 864 通过 / 1 失败 / 1 跳过**
（唯一失败是那条已用 `git stash` 实证过的既有基线 `publishing-service.test.ts` 的 startup recovery）。

**Step 2 编译两套产物**：`npm run build:backend` + `npm run build:electron` 均成功。
产物自检：
- `dist/lib/xhs-browser.js` / `xhs-page.js` / `xhs-runner.js` / `note-media.js` **都在**；
- 导出可用：`XhsRunner`/`NoteMediaService` 是 function，`XHS_SELECTORS.submitHost === "xhs-publish-btn"`、
  `XHS_SUBMIT_OFFSETS.publish === {x:0.607,y:0.5}`（即编译产物里的偏移与真机实测一致）；
- `grep -c "XHS_" dist/server.js` 与 `dist-electron/server.js` **各 2**（env 透传真的进了两套产物）。

**⚠️ 这一步补了一处我上一轮漏掉的东西**：`XHS_BROWSER_BINARY` / `XHS_PROFILE_DIR` 的 **env 透传**
（`src/server.ts` 与 `electron/server.ts`）—— 计划 Task 7 的影响面里写了，我上一轮没做，
后果是「配了环境变量却毫无作用」，正是 AGENTS.md 里记的那类「改了没生效」事故。

**Step 3 真机演练（`--tab --upload-dummy --dry-run`）—— 全绿**：

| 步骤 | 读回结果 |
| --- | --- |
| 填标题 | `"测试标题（可删除）"` 与期望**逐字一致** ✅ |
| 填正文 | 42 字，**首段与末段都在** ✅ |
| **勾 AI 合成内容标识** | 下拉选「笔记含AI合成内容」→ **选择后文案 = 「笔记含AI合成内容」→ ✅ 已选中** |
| 结束 | **没有点「发布」**，也没有选话题 ✅ |

**演练顺带确认了一件会影响实现的事**：声明控件**选中之后文案会变成所选项** ——
所以演练后的报告里「添加内容类型声明」必然是 0 命中，而「笔记含AI合成内容」命中 3 次。
这**不是页面改版**（差点被误读成改版）。已把这一项加进探针的报告候选，免得后人重踩。

**顺带修掉探针一句说谎的收尾文案**：它原先固定打印「本次未填任何表单、未上传任何图片」，
而带 `--upload-dummy` / `--dry-run` 时**明明填了也传了**。现在改为**如实列出本次做过的有副作用操作**，
并明确「始终没有点击任何提交类按钮」。

**Step 4（真实提交）不由 agent 执行** —— 那是用户本人的决定。
**Step 5 清理**：截至本次仍是「草稿箱中有未发布的作品」，需要用户到 App / 创作中心删掉那条
「测试标题（可删除）」草稿与几张纯灰假图（spec §17 有记录）。

---


#### 补漏（2026-09-21）：设置页扫码登录 —— **我的计划漏了一整块**

**用户指出来的**：「不能像抖音、今日头条这样吗？」——截图里设置页左侧只有「抖音登录」「今日头条」，
**没有小红书**。查证属实：我把登录能力写进了执行器（`startLogin`/`pollLogin`/`loginInWindow`/`checkLogin`），
但**既没接路由、也没做设置页面板**，所以应用里根本没法给小红书扫码登录 —— 只能跑探针脚本
（`scripts/probe-xhs-publish-page.ts --login`）。这属于「功能不可用」，不是「少个便利入口」。

**根因（如实记录）**：Task 8 的影响面清单里我**没写** `SettingsPage` / 登录面板，
Task 7 的路由清单里也**没写** `publishing/xhs/login*` —— 计划漏了，实现自然就漏了。
头条那一轮之所以有这套东西，是因为它的计划里写了（`ToutiaoLoginPanel` + 4 条路由）。

**补的东西**：

| 位置 | 改动 |
| --- | --- |
| `publishing-service.ts` | `startXhsLogin` / `pollXhsLogin` / `cancelXhsLogin` / `loginXhsInWindow` / `verifyXhsLogin`（与头条一一对应；`XhsAutoPublishRunner` 从「只有 publishNote」扩成 `Pick<XhsRunner, …登录+发布>`） |
| `publishing-routes.ts` | 5 条路由：`POST/GET/DELETE /publishing/xhs/login`、`POST /publishing/xhs/login/window`、`POST /publishing/xhs/verify` |
| **`components/QrLoginPanel.tsx`（新）** | **通用扫码面板**：两个平台的登录交互逐字相同（取码 → `<img src>` → 轮询 → 窗口扫码 → 零副作用自检），只有端点与文案不同，所以抽成一份、各平台走 props |
| `components/ToutiaoLoginPanel.tsx` | **改成薄包装**（258 行 → 30 行），对外导出与文案原样保留 ⇒ **它的既有用例逐字通过**（这就是「抽取没改变行为」的证据）|
| `components/XhsLoginPanel.tsx`（新） | 小红书薄包装；文案写明「只做发布、不读取不搜索不评论不点赞收藏」「风险由你的账号承担」「登录态不会离开 storage」 |
| `services/api.ts` | 5 个方法（与头条一一对应） |
| `utils/settingsSections.ts` + `pages/SettingsPage.tsx` | 左侧导航加「小红书」，区段渲染 `XhsSection` |

**用例（+4）**：
- `xhs login routes drive the runner and the verify route is side-effect free` —— 驱动四条路由，并断言**自检不改动发布索引**；
- **`小红书 runner errors surface with their own status, code and guidance`** —— 这条**现在才可达**：
  之前没有小红书登录路由，执行器错误在服务层就被收敛成 `failed` 记录了，错误边界那处登记无处触发；
  有了登录路由，它才真正守住「422 + 错误码 + 可照抄指引，而不是兜底 500」；
- `XhsLoginPanel` 两条静态渲染（三个入口 / 合规与风险文案）。

**验证**：全量 **870 项 / 868 通过 / 1 失败 / 1 跳过**（那条失败仍是既有基线）；`npm run check` 双端 0 错 + 凭据扫描 633 文件干净。

---

## 明确不做（同 spec §12）

- 小红书**视频**笔记、长文、商品/蒲公英能力。
- 自动注册、自动互动（评论/私信/点赞/收藏/关注）。
- **任何小红书侧的读取与采集**（含搜索、数据看板）。
- 定时 / cron 到点自动发布。
- 逆向私有 API 路线。
- **发布后读回**（刻意不做，见 Global Constraints）。
- 复用日常 Chrome profile。
