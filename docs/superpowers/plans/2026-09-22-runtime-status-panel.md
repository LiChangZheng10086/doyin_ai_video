# 抖创工坊 运行环境状态一览（渠道 / 引擎）实施计划

> **For agentic workers:** 逐 Task 执行；每个 Task 内部按 Step 顺序走，**先写失败用例再实现**。本仓库的完整门禁是 `npm run check`（= `check:backend` + `check:renderer` + `check:secrets`）与 `npm test`。

**Goal:** 把「能不能发出去」这件事所需的状态（3 个发布渠道 + 2 项发布链路依赖）**聚合到服务端一份模型**，用两个界面呈现：发布中心的**概览条**（全部零副作用免费检查，自动刷新）与设置页的**运行环境**（深检、逐层诊断、可照抄的动作）。核心不变式：**免费层永远不许说「已登录」**。

**Architecture:** 新增一个聚合模块（五项免费检查 + 深检结论持久化）与一组路由（3 个端点，自带错误边界）；深检是**后台任务 + 轮询**（复用发布中心 `running` + 僵死阈值的形状）。渲染层是**一个组件两种尺寸**渲染同一份 `RuntimeItem[]`，判定**全部在服务端**。发布链路里已经产生的登录判据**顺手回写**，于是「发一次 = 验一次」。

**Tech Stack:** Node.js + Express 4 + TypeScript（后端）、React 19 + Tailwind v4 + lucide-react（渲染层）、Node 内置 test runner（`node --import tsx --test`）。**不新增任何 npm 依赖。**

**Spec:** `docs/superpowers/specs/2026-09-22-runtime-status-panel-design.md`

## Global Constraints

- **不新增任何 npm 依赖**；**不新增任何 design token**（`renderer/src/index.css` 是令牌唯一真源，`renderer/src/styles/theme.test.ts` 是门禁，本设计不碰它）。
- **INV-1** 免费层 `detail` 与状态文案**不含**「已登录」「有效」；`verified` 只在 store 有记录时出现。
- **INV-2** `verified.state = "valid"` 只可能来自五处：① 深检成功；② 设置页既有「校验登录」（`verifyToutiaoLogin` / `verifyXhsLogin`）；③ 扫码登录成功；④ 抖音/头条发布前 `checkLogin` 通过；⑤ 小红书走完全程未被踢到登录页。**其他任何失败都不写 `verified`**。
- **INV-3** 免费层**不改变任何状态**：不写文件、不开浏览器、不触碰平台；**允许**短命只读探测（`ffmpeg -version`）。
- **INV-4a** 深检之间**全局单飞**（第二个深检，任何渠道，一律 409）。**INV-4b** 深检 ↔ 发布**按渠道**互斥；**跨渠道的发布不受影响**。
- **INV-5** `running` 的深检**不显示百分比**、不做进度条。
- **INV-6** 深检失败 / 超时必须带 `guidance`；**不得被兜底 500 吃掉**（新路由的边界必须登记错误类）。
- **INV-7** 前端不做状态判定：**红灯规则只存在于服务端的 `state` 字段**。
- **软约束**：三份 GUIDANCE 的**既有字符串导出逐字不变**（现有错误文案在插值使用）；只**新增** `*_GUIDANCE_LINES` 数组形态。
- **不做**：定时轮询/后台常驻探测、whisper/Node/HyperFrames（生成链路）、历史趋势图、"一键修复"、⌘K 命令面板。
- **测试纪律**：一律用**注入的假对象**（本仓无模块 mock 约定，fake 靠接口注入，见 `media.test.ts:21` 的 `MediaCommandRunner`）；**不联网、不启浏览器、不发布任何内容**。
- **产物纪律**：改 `src/` 必须 `npm run build:backend` 后重启后端；改 `electron/` 还需 `npm run build:electron`。**两套产物互不覆盖**，"改了没生效"多半是这里踩错。
- 中文界面文案；功能图标统一 lucide-react，**不用 emoji**。

---

### Task 1: 聚合模块与五项免费检查（测试先行）

> **执行记录（2026-09-22）**：已完成。落地时有四处计划外的调整，都写进了代码注释：
> ① `RuntimeStatusDeps.fs` **只暴露读方法**（access/readFile）—— INV-3 从「用例断言没写」升级成「类型上写不了」；
> ② 浏览器解析链的两种失败形态必须分开对待：**显式路径不存在时解析链直接抛错**（拿不到逐层诊断，
>    但错误文案点名了路径），**链条走完才返回 `{target:null, attempts}`**（逐层诊断齐全），两条各有用例；
> ③ 探测点复用 `filesystemBrowserProbe`（从 `toutiao-browser.ts` 导出），不另写一份 —— 否则迟早
>    出现「状态页说就绪、解析链找不到浏览器」；
> ④ `media.ts` 只提供 `ffmpegProbeCommand()`（命令形状一处定义），实际执行走注入的 `probe` 端口，
>    于是「只跑 `-version`」可被用例断言。
> 手验：独立后端 :3100 五项状态正确、逐层诊断是真实结果、无会话时 401。

**Files:**
- Create: `src/lib/runtime-status.ts`
- Test: `src/lib/runtime-status.test.ts`
- Modify: `src/lib/media.ts`（新增 ffmpeg 可用性检查）
- Modify: `src/lib/sau-runner.ts`（`export CHECK_TIMEOUT_MS`；`SAU_INSTALL_GUIDANCE_LINES`）
- Modify: `src/lib/toutiao-browser.ts`、`src/lib/xhs-browser.ts`（各补 `*_GUIDANCE_LINES`）
- Create: `src/lib/runtime-routes.ts`（本 Task 只做 `GET /api/runtime/status`）
- Modify: `src/app.ts`（装配点：`app.ts:284` 之后）

**Interfaces:**
- Consumes: `SauRunner.assertConfigured()`（`sau-runner.ts:186`）、`douyin-cookie.ts` 的 `hasCookie/hasAuthCookie/getCookiePath`、`resolveToutiaoBrowserTarget` 的 `attempts` 链（`toutiao-browser.ts:153-178`）、`XHS_BROWSER_GUIDANCE`、`MediaServiceConfig.ffmpegBinary`（`media.ts:11`）
- Produces: `RuntimeItem` / `RuntimeStatusResponse` / `RuntimeState`（spec §3.2）、`RuntimeStatusDeps`（可注入 `fs` 与命令探测端口）、`collectRuntimeStatus(deps): Promise<RuntimeStatusResponse>`、`RUNTIME_VERIFIED_TTL_MS`；路由 `GET /api/runtime/status`

- [x] **Step 1: 写失败用例（聚合形状与五项判定）**

- 返回恰好 **5 项**：`channels` 三项顺序固定 `douyin`/`toutiao`/`xiaohongshu`，`dependencies` 两项 `ffmpeg`/`storage`；每项 `state`/`detail` 非空。
- **INV-1（本设计最重要的一条）**：把五项全部构造为"配置齐、凭据存在、无 verified"，断言所有 `detail` 与状态文案**不含**「已登录」「有效」；且 `verified` 字段**不出现**。
- `未配置 SAU_BINARY → douyin.state === "blocked"`，且 `guidance.join("")` 与 `SAU_INSTALL_GUIDANCE` **逐字一致**（头条/小红书同理对 `TOUTIAO_BROWSER_GUIDANCE` / `XHS_BROWSER_GUIDANCE`）。
- `解析链能落地但无 verified → toutiao/xiaohongshu 均为 "degraded"（不是 "ready"）`。
- `cookie-status` 三态映射：`authenticated`/`no_auth`/`empty` → 三句 `detail`，**都不出现「已登录」**。
- `ffmpeg 探测失败 → "blocked"` 且指引含 `FFMPEG_BINARY`。
- `storage 不可写 → "blocked"`，`evidence.errno` 原样回显（用注入的 fake `access` 抛 `EACCES`）。
- **profile 目录祖先规则**：目录不存在但**最近已存在祖先可写** → **不因此 `blocked`**（`state` 仍按 §3.4 为 `degraded`），且 `evidence.notes` 含「尚未创建」；祖先不可写 → `blocked` + errno。
- `免费检查自身抛错 → "unknown"`（注入 fake `readFile` 抛错）。
- **INV-3 零副作用**：注入 fake `fs`/`probe`，整个 `collectRuntimeStatus()` 期间**没有任何写操作**（断言 fake 未收到 `writeFile`/`mkdir`）；`probe` 只收到 `ffmpeg -version`。
- `verified.state === "valid"` 且 `age ≤ RUNTIME_VERIFIED_TTL_MS` → `ready`；超过 TTL → `degraded`；`verified.state === "invalid"` 且在 TTL 内 → `blocked`。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/runtime-status.test.ts`
Expected: FAIL —— 模块不存在。

- [x] **Step 3: 实现 `runtime-status.ts`（判定集中在这一处）**

状态映射严格照 spec §3.4 表实现；跨渠道/依赖共用一个纯函数 `resolveState(checks, verified)`，**不允许在别处再写一份判定**（INV-7）。`RuntimeStatusDeps` 至少含 `{ fs: { access, readFile, readdir }, probe: { runCommand }, now(): Date }`，`now` 可注入以便测 TTL。

- [x] **Step 4: 实现 ffmpeg 检查与三份 `*_GUIDANCE_LINES`**

`media.ts` 新增可用性检查（执行 `-version`，**不改 `MediaService` 既有构造签名**——新增独立导出函数由聚合层调用）。三份常量**只新增数组导出**，既有字符串逐字不动。

- [x] **Step 5: 运行确认通过（含既有用例不回归）**

Run: `node --import tsx --test src/lib/runtime-status.test.ts`
Expected: PASS。
Run: `npm test`
Expected: PASS（既有全量用例不回归）。

- [x] **Step 6: 接上路由**

`runtime-routes.ts` 导出 `registerRuntimeRoutes(app, deps)`；`GET /api/runtime/status` 走 `authenticated`（沿用本地操作者会话中间件）。在 `app.ts:284` 之后装配。

- [x] **Step 7: 端到端手验**

Run: `npm run build:backend && npm start`
Run: `curl -s localhost:3100/api/runtime/status | python3 -m json.tool | head -40`
Expected: 5 项 + `checkedAt`；本机若未配 `SAU_*`，`douyin.state` 应为 `blocked` 且带指引。
Run: `npm run check`
Expected: PASS。

---

### Task 2: 深检任务、互斥与错误边界（测试先行）

> **执行记录（2026-09-22）**：已完成。落地时三处调整：
> ① **`writable` 中间件去掉** —— 发布中心那个检查的是发布索引的只读保护，与运行环境无关，套上只会变成永远放行的空壳；
> ② **补了取消端点** `POST /api/runtime/checks/:checkId/cancel` —— 原计划只有界面出口、没有路由，按钮点不动；
> ③ **runner/browser 错误登记进边界的想法被证伪**：它们到不了边界，探测内部的异常一律在任务里收敛成
>    **带指引的 `failed` 记录**（比抛到边界更好），所以边界只需登记 `RuntimeCheckError` / `RuntimeRouteError` / `LocalAuthError`。
>
> 另外两处实现选择：互斥闸放在 **`autoPublish()` 这一个分派入口**（不是三个通路各写一遍）；store 的
> 「该平台在跑」查询**复用既有僵死阈值**（`autoPublishInFlight`），不在服务层重写一遍。
>
> 手验（独立后端 :3100，用假 sau 脚本避免任何真实平台访问）：同渠道 409、**跨渠道也 409**（全局单飞）、
> `elapsedMs` 服务端算、取消落 `cancelled` 并如实提示会话锁。
>
> ⚠️ **手验过程中的一次失误，记下来当教训**：我把「应该被 409 挡掉」的第二发请求打给了**头条**，而抖音那次
> 检测在毫秒内就失败结束了 → 第二发没被挡住，**真的启动了一次头条登录检测**（零副作用自检：打开首页读
> URL/阻断信号/昵称），并把 `verified.toutiao` 写成了 `valid`。**规则：验证「应该被挡住」的请求时，第二发
> 也必须选一个不会产生真实副作用的渠道。**

**Files:**
- Create: `src/lib/runtime-checks.ts`
- Test: `src/lib/runtime-checks.test.ts`
- Modify: `src/lib/runtime-routes.ts`（`POST /api/runtime/checks`、`GET /api/runtime/checks/:checkId`、**自带错误边界**）
- Modify: `src/lib/publishing-service.ts`（发布入口读 check 状态 → 同渠道 409）

**Interfaces:**
- Consumes: `SauRunner.checkLogin()`（`sau-runner.ts:192`）、`ToutiaoRunner.checkLogin()`（`toutiao-runner.ts:238`）、`XhsRunner.checkLogin()`（`xhs-runner.ts:401`）
- Produces: `startRuntimeCheck(id, deps)`、`getRuntimeCheck(checkId)`、`RuntimeCheckError`（带 `status` + `code` + `guidance`）、`RUNTIME_CHECK_TIMEOUT_MS = 120_000`、`RUNTIME_CHECK_STALE_MS = 10 * 60_000`；发布侧新错误码 `publish_blocked_by_runtime_check`

- [x] **Step 1: 写失败用例（状态机与互斥，全用假 runner）**

- `running` 期间再触发**任何渠道**的深检 → **409**（INV-4a），且不产生第二个任务。
- **跨渠道不互斥**：抖音深检 `running` 时，**头条发布**仍可发起（INV-4b；用 fake 发布入口断言未被拦）。
- **同渠道互斥**：头条深检 `running` 时，**头条发布** → 409 `publish_blocked_by_runtime_check` + 中文文案。
- 反方向：该渠道**有发布在跑**时发起该渠道深检 → 409。
- 超时 → `failed` 且 `guidance` 非空（INV-6）。抖音超时用 `CHECK_TIMEOUT_MS`（新导入，见 Task 1 Step 4）。
- `取消 → status === "cancelled"`（**不是** `failed`），并带回「可能需要重新验证一次」的提示。
- **僵死恢复**：store 里留一条 `running`，启动后该渠道**可重新发起**；断言 `RUNTIME_CHECK_STALE_MS > CHECK_TIMEOUT_MS`（用 `sau-runner.ts` 新导出的常量比对）。
- **错误边界**：`RuntimeCheckError` 被路由边界识别，响应带**自己的 status/code/guidance**（对标既有用例 `toutiao runner errors surface with their own status, code and guidance`）；未识别的异常走兜底 500 **且调用 `console.error`**。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/runtime-checks.test.ts`
Expected: FAIL。

- [x] **Step 3: 实现 `runtime-checks.ts`**

单飞用模块级 `current` 句柄；僵死判定读 `startedAt` 与 `RUNTIME_CHECK_STALE_MS`；结论写 `cache/runtime-checks.json`（`LocalStorage` 形状，照 `publishing-store.ts:24`）。**`elapsedMs` 由服务端算**（前端不自己算时钟差）。

- [x] **Step 4: 接上路由与错误边界**

在 `runtime-routes.ts` 内实现边界：登记 `RuntimeCheckError` 与 `SauRunnerError` / `Toutiao*Error` / `Xhs*Error` 各族（**别漏**——漏登记的表现是**指引整条丢掉**，不是状态码不准）；兜底分支 `console.error`。

- [x] **Step 5: 发布侧互斥**

发布入口（`autoPublishNoteTask` / `autoPublishToutiaoArticle` / `autoPublishXhsNote` 的公共前置）先查同渠道 check 是否 `running`，是则 409 + 文案「正在检测该渠道登录态，通常 10–30 秒，最坏 5 分钟；可先取消检测」。

- [x] **Step 6: 运行确认通过 + 全量门禁**

Run: `node --import tsx --test src/lib/runtime-checks.test.ts`
Expected: PASS。
Run: `npm test && npm run check`
Expected: PASS。

---

### Task 3: 发布与登录动作回写 `verified`（测试先行）

> **执行记录（2026-09-22）**：已完成。五处来源全部接上（抖音/头条发布前预检、设置页「校验登录」、
> 扫码成功、小红书发布内归因），共 10 条用例。落地时三处值得记下：
> ① 回写走**独立端口** `runtimeVerified.record(id, state)`，与 Task 2 的互斥闸分开（各自一件事）；
>    实现在 `RuntimeChecks.recordVerified`，**与深检共用同一个 store**，且**不动 `check` 段**
>    —— 否则一次发布会把深检任务记录擦掉。
> ② 回写失败**只警告、不上抛**：它是辅助动作，绝不能让发布失败；但也不静默（静默正是状态页
>    会悄悄变旧的原因，而那正是本功能要消灭的东西）。
> ③ `previewRevision` 必须取自**包级预览** `packagePreview()`（路由
>    `GET /publishing/packages/:id/preview` 用的就是它），**不是**建包前的
>    `/jobs/:id/publishing/preview` —— 用错来源会稳定撞 409 `publish_revision_conflict`
>    （本 Task 第一版就是这么错的，用例抓出来了）。
>
> ⚠️ **已知缺口（有意留着）**：头条**文章发布**路径的回写已实现，但**没有服务层用例** ——
> 既有测试里没有任何「文章包」的建包辅助（查过 `publishing-service.test.ts`），为本 Task 造一套
> 不划算。该路径与「校验登录」共用同一个 helper 与同一份 runner 判据；真机走查 AC-7 覆盖抖音那条。

**Files:**
- Modify: `src/lib/publishing-service.ts`
- Test: `src/lib/publishing-service.test.ts`（既有文件，追加用例）

**Interfaces:**
- Consumes: Task 2 的 store 写入函数
- Produces: 五处来源的写回（INV-2）

- [x] **Step 1: 写失败用例**

- `一次抖音发布尝试（预检通过）后，verified.at 变新且 state === "valid"`。
- **抖音归因边界**：`checkLogin()` 返回 `exitCode === 0 && ok === false` → `invalid`；返回 `exitCode === -1`（超时/起不来）→ **不写** `verified`（断言 store 无新记录）——这条防的是"一次超时被记成 7 天红灯"。
- `抖音 checkLogin() ok === true → valid`。
- **小红书三条归因**：`result.code === "xhs_not_logged_in"` → `invalid`；走完全程（含 `submit: false` 只填到草稿）→ `valid`；其他失败 → **不写**。
- `头条预检通过 → valid`。
- `POST /publishing/toutiao/verify`（设置页「校验登录」）成功 → `valid`。
- `扫码登录成功（pollLogin → logged_in）→ valid`。
- **反向断言**：以上任何一条**都不得新增页面访问**（用 fake runner 断言调用序列里没有额外的 `goto`）。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-service.test.ts`
Expected: FAIL（新用例失败，既有用例仍通过）。

- [x] **Step 3: 实现回写（薄封装，别把判定散开）**

统一走一个 `recordVerified(source, state)` 辅助函数，**五处调用点都只传事实**，判定仍在 `runtime-status`/`runtime-checks` 一侧。

- [x] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/publishing-service.test.ts && npm test`
Expected: PASS。

---

### Task 4: 渲染层组件与纯函数（测试先行）

> **执行记录（2026-09-22）**：已完成，16 条用例。两处值得记下：
> ① **组件必须显式 `import React`** —— 本仓没有 `renderer/tsconfig.json`，tsx/esbuild 走的是**根**
>    `tsconfig.json`，而它**没有 `jsx` 设置** → 回落到 classic 转换。新组件不 import 就会
>    `ReferenceError: React is not defined`（这正是既有每个组件都手写那行的原因）。
> ② 徽章文案取**状态词**（就绪/待确认/不可用/未知）而不是 `detail` 的片段 —— 与稿子上的
>    「✓ 凭据已存在」略有差异：状态词更稳（不随服务端 detail 措辞变），detail 紧跟在徽章右侧，
>    视觉上仍是「徽章 + 短文案」。若你要严格照稿，改 `RuntimeStateBadge` 接受文案覆盖即可。
> ③ `visibleItems(compact)` 只滤 `ready`；`blocked` 项在**两种尺寸下都摊开可照抄动作** ——
>    发布现场最需要命令的时刻恰恰是"发不出去"的时候。

**Files:**
- Create: `renderer/src/components/RuntimeStatusList.tsx`、`renderer/src/components/RuntimeStateBadge.tsx`
- Create: `renderer/src/utils/runtime.ts`
- Test: `renderer/src/utils/runtime.test.ts`、`renderer/src/components/RuntimeStatusList.test.tsx`
- Modify: `renderer/src/services/api.ts`（3 个方法）

**Interfaces:**
- Consumes: `RuntimeStatusResponse`（与后端同形，`renderer/src/types/index.ts` 同步类型）
- Produces: `<RuntimeStatusList items variant="compact"|"full" />`、`<RuntimeStateBadge state />`、纯函数 `runtimeStateMeta(state)` / `visibleItems(items, variant)` / `formatElapsed(ms)`

- [x] **Step 1: 写失败用例（纯函数）**

- `runtimeStateMeta` 四态 → 图标 + 文案映射：`ready`→`CheckCircle2`、`degraded`→`AlertTriangle`、`blocked`→`XCircle`、`unknown`→`HelpCircle`；**每个都含文字**（不能只靠颜色）。
- `formatElapsed(42_000) === "已运行 42 秒"`；**不含 `%`**（INV-5）。
- `visibleItems(items, "compact")`：无 `ready` 项时返回全部非 ready 项；全 `ready` 时返回空数组（由调用方渲染「环境正常」那一行）。
- **INV-1 前端再守一遍**：对 5 种 `state` 的默认文案断言**不含**「已登录」。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test renderer/src/utils/runtime.test.ts`
Expected: FAIL。

- [x] **Step 3: 实现纯函数与两个组件**

`RuntimeStatusList` **一个组件两种尺寸**，判定一律读 `item.state`，**不在前端复算红灯**（INV-7）。徽章同时渲染图标与文字；颜色只用既有 token（`success`/`warning`/`danger`/`ink-subtle`）。

- [x] **Step 4: 写失败用例（组件渲染）**

- `variant="compact"` 与 `"full"` 渲染**同一份模型**：断言两处都出现全部 5 项的 label。
- `blocked` 项的 `guidance` **每一行都渲染出来**。
- `verified` 存在时显示「N 小时前验证 · 登录态有效」；**不存在时不显示任何有效性字样**。
- `running` 行显示「已运行 N 秒 · 通常 10–30 秒，最坏 5 分钟」+「取消检测」。

- [x] **Step 5: 实现组件 + api 方法，并确认通过**

Run: `node --import tsx --test renderer/src/components/RuntimeStatusList.test.tsx && npm run check:renderer`
Expected: PASS。

---

### Task 5: 两个界面（概览条 + 运行环境）

> **执行记录（2026-09-22）**：已完成（5 条新用例 + 界面实测截图复核）。四处值得记下：
> ① **紧凑状态行复用同一个 hook 与组件**：`DouyinSection` 用 `useRuntimeStatus()` 取 douyin 那一项、
>    交给 `RuntimeStatusList variant="compact"` 渲染 —— 不是"第二份实现"，是同一实现的紧凑尺寸
>    （决策 ⑤ 选 A 的缓解措施）。同时把「Cookie 状态：已登录」那张卡片**迁走**，并顺手修掉
>    文案只讲采集的问题：「这份凭据**采集与发布共用同一份**」。
> ② ⚠️ **两套 id 不同名**：设置分组里小红书叫 `xhs`，运行环境的渠道叫 `xiaohongshu` ——
>    直接互用会让「去登录」跳到错组。编译器拦下了（`'xiaohongshu'` 不在 `SettingsSection` 里），
>    现在由 `loginSectionOf()` 显式映射并有 5 条用例守（含"三个渠道必须落到三个不同分组"）。
> ③ **看截图否掉了一个我在 Task 4 定的设计**：compact 原本在 blocked 时也摊开可照抄动作，
>    实测把那 6 行命令一渲染，概览条直接被撑成半屏 —— 正是"发布现场被塞满"。改成 compact
>    只留徽章 + 详情，命令留在设置页，「查看」一键到达；用例也跟着反向断言（compact 不渲染命令）。
> ④ 深检轮询**终态一到就整份重拉**（不只是更新 check 字段）：终态会改 `verified`，
>    AC-6「概览条同步变绿」靠的就是这一次重拉。
>
> 实测（headless Chrome + Vite dev + 独立后端）：发布中心概览条（compact，2 行）、
> 设置页「运行环境」（full，五项 + 诊断）、抖音登录分组（紧凑状态行 + 迁移后文案）三处均符合预期。

**Files:**
- Modify: `renderer/src/pages/PublishingPage.tsx`
- Modify: `renderer/src/pages/SettingsPage.tsx`
- Modify: `renderer/src/utils/settingsSections.ts`（7 项 → 8 项，新增 `{ id: 'runtime', label: '运行环境' }`）
- Test: `renderer/src/utils/settingsSections.test.ts`（新建；**本仓没有页面级 `.test.tsx` 惯例**，用例一律落在 `utils/` 与 `components/`，页面本身靠 Task 7 的真机走查覆盖）

> ⚠️ 本仓既有用例分布：`renderer/src/utils/*.test.ts`（纯函数）与 `renderer/src/components/**/*.test.tsx`（组件渲染 + 文案断言）。**不要新建 `renderer/src/pages/*.test.tsx`** —— 那会引入一种仓库里不存在的测试形态。

**Interfaces:**
- Consumes: Task 4 的组件与 api 方法
- Produces: 概览条（发布中心）+ 运行环境分组（设置页）+ `DouyinSection` 迁移后的紧凑状态行

- [x] **Step 1: 概览条**

位置：页面标题下方、渠道页签上方。五项 + 右侧「重新检查」+ 标题右侧「本次检查：刚刚」。

- [x] **Step 2: 刷新时机（四选一漏一个就是观感 bug）**

挂载时拉一次；点「重新检查」拉一次；**深检轮询到终态**（`succeeded`/`failed`/`cancelled`）后**重拉**（否则 AC-6 不成立）；**一次发布结束**（含失败）后**重拉**（AC-7）。

- [x] **Step 3: 断点行为**

`≥ md` 全显五项；`< md` 只显非 `ready` 项，全绿时一行「环境正常 · 刚刚检查」（断点沿用 `AppShell` 口径）。

- [x] **Step 4: 设置页「运行环境」分组**

自上而下：分组标题 + 说明（「免费检查零副作用；验证登录态会打开浏览器，同渠道的发布请等它结束」）+「重新检查」→ 发布渠道三行（徽章 + `detail` + 可折叠 `evidence` + `guidance` 等宽字体 + 复制按钮 + 「立即验证登录态」/「去登录」+ verified 时间戳）→ 发布链路依赖两行（无深检按钮）→ 深检进行中行 → 诊断信息（默认收起，见 Task 6）。

- [x] **Step 5: `DouyinSection` 迁移（本 Task 唯一的行为变更）**

把那张 `Cookie 状态：…` 卡片**迁到运行环境**，原分组顶部改一行紧凑状态行（同组件 `variant="compact"`、同一份数据）；`DouyinSection` 说明补上「**采集与发布共用同一份 cookie**」。
⚠️ 既有渲染层用例（`components/**/*.test.tsx`，含 `shell.test.tsx` 的导航断言）是门禁，**逐条通过**；`settingsSections` 新增分组后，断言分组数量/顺序的用例要同步更新（7 → 8），并保留"状态仍可见"的覆盖（紧凑状态行仍在页面里）。

- [x] **Step 6: 「去登录」锚点**

三个渠道行的「去登录」跳到设置页对应分组（用既有分组 id 切换，不新增路由）。

- [x] **Step 7: 运行确认通过**

Run: `npm test && npm run check`
Expected: PASS。
Run: `npm run dev:renderer`（或 `npm run dev`）
Expected: 手验 AC-1…AC-5（见 Task 7）。

---

### Task 6: build tag 诊断区（决策 ⑦）

> **执行记录（2026-09-22）**：**后端部分**完成（4 条用例）；**界面渲染归入 Task 5**（诊断区就在
> 「运行环境」分组里，分开做会造成两次改同一个组件）。
> 落地时两点：
> ① `stat` 加进 `RuntimeStatusDeps.fs` 端口 —— 它仍是**只读**，INV-3 不受影响；不这么做就得为
>    诊断信息再开一个端口，反而更碎。
> ② 路径由 **app.ts 注入**（`<rootDir>/dist/server.js` 与 `<rootDir>/dist-electron/server.js`），
>    而不是让 `runtime-status.ts` 去猜自己在哪个产物里 —— 打包后布局不同，猜必错。
>    读不到就**不显示**，绝不让诊断信息把整条状态响应弄失败。
>
> 真机验证时它当场证明了价值：本机 `dist/server.js` 是**今天 12:13**、`dist-electron/server.js`
> 是**昨天 13:38** —— 两份产物差一天，正是「改了没生效」那类事故的现场（本次没改 `electron/`，
> 所以此刻无害，但一眼可见）。

**Files:**
- Modify: `src/lib/runtime-status.ts`（或 `runtime-routes.ts`）—— 产出两个产物的构建时间
- Modify: `renderer/src/pages/SettingsPage.tsx` —— 诊断信息里渲染
- Test: `src/lib/runtime-status.test.ts`（追加）

**Interfaces:**
- Produces: `RuntimeStatusResponse.buildTag?: { backend?: { path: string; mtime: string }, electron?: { path: string; mtime: string } }`

- [x] **Step 1: 写失败用例**

- 两个产物都存在 → 两项 `mtime` 都有。
- Electron 产物不存在（独立后端跑）→ `electron` 为 `undefined`，**不报错**。
- 读不到（权限/异常）→ 该字段为 `undefined`，**不影响整个响应**（免费层不许因为诊断信息而整体失败）。

- [x] **Step 2: 实现并确认通过**

Run: `node --import tsx --test src/lib/runtime-status.test.ts`
Expected: PASS。

- [ ] **Step 3: 渲染（默认收起、不进主视觉）**

收起时只显示「▸ 诊断信息」；展开显示后端与 Electron 的构建时间。呼应 **UI 重构 spec §2**「版本与开发端口退出主视觉」。

---

### Task 7: 全量验证、编译与真机走查

> **执行记录（2026-09-22，部分完成）**：全量门禁与两套产物编译已完成；AC 走查在**真实应用窗口**里做的
> （Electron + 真实 userData + 真实 storage），结果与两处发现记在下面。
>
> **走查立刻抓到一处我自己的偏差**：AC-1 要求"打开发布中心即可看到**五项**"，实测只有 3 项 ——
> 我在 Task 4 把「只显示非 ready」当成了 compact 的**恒定行为**，而 spec/计划写的是**断点行为**
> （`≥md` 全显、`<md` 才收起）。已改为**纯 CSS 断点**（`hidden md:block`），不引入 JS 判定；
> `visibleItems` 换成 `compactVisibilityClass` + `allReady`，用例同步改写。
> 另外补上概览条缺的「本次检查」时刻（AC-1 的后半）。
>
> **又抓到一处既有 bug（未修，仅报告）**：`electron/server.ts:38` 的 dev 分支写的是
> `path.join(__dirname, '../..')`，而 `__dirname` 是 `<repo>/dist-electron` ⇒ **仓库的上一级**。
> 影响：`repoRoot` 与 `rootDir` 派生的路径（vendored 浏览器解析、`getWhisperRoot` 的 `rootDir/vendor/whisper`）
> 全部指错；目前被后续兜底（playwright 缓存、`process.cwd()`）掩盖，所以一直没暴露 —— 正是
> build tag 这类功能该暴露的东西。建议单独一次改动修它并验证（本次不动，避免与走查混在一起）。
>
> ⚠️ **我自己制造并立刻修掉的一次回归**：为推产物路径我在 `src/app.ts` 用了裸 `__dirname`，
> 而 `dist/` 是 **ESM**（`src/server.ts` 用的是 `fileURLToPath(import.meta.url)`）⇒ 自由变量触发
> `ERR_AMBIGUOUS_MODULE_SYNTAX`，**独立后端直接起不来**。`npm start` 一跑就抓出来了；
> 改用同一 ESM 惯用法后正常。

**Files:** 无新增；只读验证与记录。

- [ ] **Step 1: 全量门禁**

Run: `npm test && npm run check`
Expected: PASS（含 `check:secrets`）。

- [ ] **Step 2: 编译两套产物并重启**

Run: `npm run build:backend && npm run build:electron`
Expected: 无错误。
⚠️ 重启前确认端口真的释放（`lsof -nP -iTCP:<port> -sTCP:LISTEN`）——旧进程没死会让请求仍由**跑着旧代码**的进程应答，表现就是"修复没生效"。

- [ ] **Step 3: 真机走查 AC-1…AC-9**

| # | 怎么做 | 期望 |
| --- | --- | --- |
| AC-1 | 打开发布中心，**不点任何东西** | 五项状态 + 「本次检查：刚刚」 |
| AC-2 | 故意让小红书解析不到（临时改 `XHS_BROWSER_BINARY` 指向不存在文件） | 概览条 blocked → 点「查看」→ 运行环境展开见**三段可照抄命令** |
| AC-3 | 三个渠道各点「去登录」 | 都跳到对应登录分组 |
| AC-4 | 点「验证登录态」（抖音） | **立刻返回**并显示「检测中 · 已运行 N 秒 · 通常 10–30 秒，最坏 5 分钟」，可切走再回来 |
| AC-5 | 检测期间看同渠道发布按钮 | 禁用并说明原因；**切到别的渠道，发布仍可用** |
| AC-6 | 等检测完成 | 该行变「登录态有效 · 刚刚」，概览条**同步变绿**（无需手动刷新） |
| AC-7 | 发一次抖音图文（或只跑到失败） | 即便没点过深检，抖音行「上次验证」也变新 |
| AC-8 | 通读两个界面的全部文案 | 免费层**任何**文案都不出现「已登录」；只有带时间戳的 verified 才谈有效性 |
| AC-9 | 设置页运行环境底部 | 诊断信息默认收起；展开见 `dist/` 与 `dist-electron/` 构建时间 |

- [ ] **Step 4: 回填与收尾**

把走查结论（哪几条过、哪几条要改）写回本计划与 spec 的"实施记录"；`docs/worklog.md` 补一条。

---

## 完成判据

- `npm test` + `npm run check` 全绿；两套产物已编译。
- AC-1…AC-9 全部在真机走通，并在本计划里逐条打勾。
- INV-1…INV-8 每条都有对应用例（见 Task 1/2/3/4 的用例清单）。
- 没有新增 npm 依赖、没有新增 design token、既有 GUIDANCE 字符串逐字未变。
