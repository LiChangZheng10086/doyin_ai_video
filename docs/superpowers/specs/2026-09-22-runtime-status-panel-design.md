# 抖创工坊 运行环境状态一览（渠道 / 引擎）设计规格

- 日期：2026-09-22
- 状态：待评审
- 关联：`docs/superpowers/specs/2026-08-11-creative-canvas-ui-redesign.md`（视觉系统与 §2「版本与开发端口退出主视觉」）
- 参考项目评估：Prism（`Laihiujin/Prism`）——**只借信息架构，不借视觉语言**，理由见 §1.2

---

## 1. 背景与结论

### 1.1 问题

发布能不能成功，取决于一串**我们已经在检查、但用户看不到**的东西：sau 有没有配、cookie 还在不在、头条/小红书的浏览器能不能解析到、profile 目录能不能写、ffmpeg 能不能裁图、storage 能不能落盘。现在这些信息分散在三处，而且**没有一处是"一览"**：

| 位置 | 现在显示了什么 | 代码 |
| --- | --- | --- |
| 设置页 › 抖音登录 | 一张 `Cookie 状态：xxx` 卡片 + 存储路径 | `SettingsPage.tsx`（`DouyinSection`） |
| 设置页 › 今日头条 / 小红书 | `QrLoginPanel` 自带的「已登录（用户名）」与警告条 | `QrLoginPanel.tsx` |
| 发布中心 | **什么都没有** —— 提交那一刻才失败 | `publishing-service.ts` |

代价是 AGENTS.md 里那三段排查文档（「配了 `SAU_BINARY` 却仍报未配置」「找不到可用于头条号发布的浏览器」「会话目录不可写 EPERM」）：**用户必须翻文档，才知道该看什么、该跑哪条命令。**

两个具体缺口（本轮实测确认，不是推测）：

- `ffmpeg` / `ffprobe` **没有任何可用性检查**（`src/lib/media.ts` 里搜不到 `access`/`existsSync`/检查方法），只在真正调用时失败。
- storage 目录可写性**只在 `mkdir` 那一刻才炸**（`xhs-runner.ts:723` 与 `toutiao-runner.ts:626` 的注释都记着那句 `launchPersistentContext: EPERM … mkdir`）。

### 1.2 结论

新增一个**服务端聚合的运行环境状态模型**，配两个界面：

1. **发布中心 · 概览条**（概览层）—— 贴着决策现场，全部是**零副作用**的免费检查
2. **设置页 › 运行环境**（深检层）—— 唯一常驻状态处，承载深检、逐层诊断与可照抄的动作

**只借 Prism 的信息架构**（一张卡集中呈现渠道状态 + `Last update` 时间戳），**不借它的视觉语言**：本项目视觉锚点是「剪辑台」（`renderer/src/index.css` 头部注释：监视器黑 4 级分层 + 抖音品牌红 `#FE2C55` + 51 项对比度实算锁 + `theme.test.ts` 门禁），Prism 是 shadcn 默认 neutral 套近黑，抄过去是降级。

### 1.3 核心不变式（一句话）

> **免费层永远不许说「已登录」；「有效」这个词只能由深检产出。**

免费检查最多能证明「凭据存在」，无法证明「服务端还认这个登录态」——后者只有 `sau douyin check` 能回答，而它最坏要 5 分钟。这条不变式贯穿契约（§3）、界面文案（§6）与用例（§9）。

---

## 2. 已确认设计决策

| # | 决策 | 结果 | 理由 |
| --- | --- | --- | --- |
| ① | 定位 | **两层：便宜检查自动 + 贵检查手动** | 登录态验证会开浏览器、会抢 profile，不能无脑自动跑 |
| ② | 位置 | **概览在发布中心 + 深检在设置页** | 概览贴着决策现场；深检留在"我就是要排障"的地方 |
| ③ | 范围 | **3 渠道 + 发布链路依赖（ffmpeg、storage 可写）** | 都直接影响"这一次能不能发出去"；whisper / Node / HyperFrames 属生成链路，不进 |
| ④ | 深检形态 | **后台任务 + 轮询** | 抖音最坏 5 分钟，同步等待不可接受；复用发布中心 `running` + 僵死阈值的形状 |
| ⑤ | 设置页 IA | **「运行环境」= 唯一常驻状态处** | 三个登录分组瘦身为动作页；`DouyinSection` 的 Cookie 状态卡片**迁移**（不是复制）；分组顶部保留紧凑状态行（同组件、同数据、只是尺寸不同） |
| ⑥ | 数据模型 | **服务端统一聚合** | 沿用本仓纪律「状态语义只有服务端一份，前端只传 status，绝不在前端复刻判定」（发布中心即照此实现） |
| ⑦ | build tag | **收进本 spec** | 它在 §6 的「诊断信息」里已有落点，只有十几行，独立成篇反而割裂 |

---

## 3. 服务端契约与数据模型

### 3.1 端点

```
GET  /api/runtime/status
POST /api/runtime/checks            body: { id: "douyin" | "toutiao" | "xiaohongshu" }
GET  /api/runtime/checks/:checkId
```

**鉴权与审计口径**（与发布中心同源，不另创一套）：`GET` 走 `authenticated`；`POST`（唯一会启动进程的动作）走 `authenticated, writable`。深检**不写审计记录** —— 它是本机诊断，不改变任何业务状态；发布中心的 `requireActor` / `actor` 快照口径**不变**，不被本设计触碰。

### 3.2 类型

```ts
type RuntimeItemId = "douyin" | "toutiao" | "xiaohongshu" | "ffmpeg" | "storage";

/** 只有四个状态。刻意**不含** "valid" —— 有效性属于 verified 字段。 */
type RuntimeState = "ready" | "degraded" | "blocked" | "unknown";

interface RuntimeItem {
  id: RuntimeItemId;
  label: string;
  state: RuntimeState;
  /** 人话，例：「凭据已存在，有效性未知」。免费层文案**禁止**出现「已登录/有效」。 */
  detail: string;
  /** 结构化证据：路径、解析链逐层结果、errno 等。前端原样渲染，不做二次判定。 */
  evidence?: {
    paths?: { label: string; value: string }[];
    attempts?: { layer: string; ok: boolean; detail: string }[];
    errno?: string;
  };
  /** 可照抄的动作，复用既有常量（SAU_/TOUTIAO_/XHS_ GUIDANCE）。 */
  guidance?: string[];
  /** 「去登录」跳转目标：设置页对应分组的锚点。 */
  action?: { kind: "login"; target: "douyin" | "toutiao" | "xiaohongshu" };
  /** 深检（或发布预检）留下的结论。**只有它谈有效性。** */
  verified?: { state: "valid" | "invalid"; at: string };
}

interface RuntimeStatusResponse {
  checkedAt: string;              // 本次免费检查的时刻
  channels: RuntimeItem[];        // 三项，顺序固定
  dependencies: RuntimeItem[];    // ffmpeg、storage
  check: RuntimeCheckSummary | null;   // 正在跑或最近一次的深检
}

interface RuntimeCheckSummary {
  checkId: string;
  id: RuntimeItemId;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  /** 已运行毫秒数（running 时由服务端算，前端不自己算时钟差）。 */
  elapsedMs?: number;
  detail: string;
  /** 失败时**必须**带上 runner 的指引，见 §5.6。 */
  guidance?: string[];
}
```

### 3.3 三条硬规则

**① 免费层不得输出有效性语义。**
`GET /api/runtime/status` 产出的 `detail` 只能是"就绪/存在/未知/缺失"这一类事实；`verified` 字段**只在 store 里有记录时才出现**。`ready` 的语义是「**就绪到可以尝试**」，不是「服务端认这个登录态」。

**② 深检结论持久化到 `storage/cache/runtime-checks.json`。**
沿用 `cache/publishing-index.json` 的 `LocalStorage` 形状（`publishing-store.ts:24`）。免费层每次现算、不缓存；**只有深检结论带时间戳落盘** —— 这样「上次验证：2 小时前」跨重启仍然成立。

**③ 发布链路已经跑过的登录判定，顺手写进同一个 store。**

| 渠道 | 既有预检 | 位置 |
| --- | --- | --- |
| 抖音 | `runner.checkLogin()`（**每次发布前必跑**，最坏 5 分钟） | `publishing-service.ts:1698` |
| 今日头条 | `checkLogin()` | `toutiao-runner.ts:238` |
| 小红书 | `checkLogin()` | `xhs-runner.ts:401` |

于是「发过一次」＝「深检过一次」，**用户不点任何按钮状态也会自己变新**。这是本设计里复用既有成本最彻底的一处；实现时需逐条确认各发布路径确实都走到了 `checkLogin`（抖音已确认）。

### 3.4 僵死恢复

深检任务若在 `running` 时进程被杀，会留下一条永远 `running` 的记录，界面里没有入口能清掉它 —— 与 `AUTO_PUBLISH_STALE_MS`（`publishing-store.ts`）面对的是同一个问题，注释里的推理照抄：

- 启动时按 `jobs.ts` 的做法把残留 `running` 置为可重试（`jobs.ts:135-150`）
- **僵死阈值必须大于抖音自检自己的超时**（`CHECK_TIMEOUT_MS = 300_000`，`sau-runner.ts:48`），否则会误判活着的进程

---

## 4. 免费检查清单（5 项，全部零副作用）

| id | 怎么查 | 现有代码 | 失败时给什么 |
| --- | --- | --- | --- |
| `douyin` | sau 配置齐不齐（binary + baseDir + 文件存在性）+ cookie 文件 `hasAuth` | ✅ `assertConfigured()`（`sau-runner.ts:186`）、`GET /api/douyin/cookie-status`（`app.ts:768`） | `SAU_INSTALL_GUIDANCE`（`sau-runner.ts:68`） |
| `toutiao` | 浏览器解析链能否落地 + profile 目录可写 | ✅ `attempts` 链（`toutiao-browser.ts:153-178`） | `TOUTIAO_BROWSER_GUIDANCE`（`toutiao-browser.ts:38`）+ 逐层链 |
| `xiaohongshu` | 同上 | ✅ `XHS_BROWSER_GUIDANCE`（`xhs-browser.ts:39`）、`describeAttempts()`（用于 `xhs-browser.ts:322`） | 同上 |
| `ffmpeg` | 二进制能否执行（`-version`） | ❌ **需新写** | 装 ffmpeg 或设 `FFMPEG_BINARY` |
| `storage` | 对 storage 根做 `access(root, W_OK)` | ❌ **需新写** | 原样回显路径 + errno |

**关于 `storage` 采用 `access(W_OK)` 而不是"写探针文件再删"**：AGENTS.md 记的两次事故（`EPERM: mkdir`）本质是权限/沙箱拒绝，`access` 会把同一个 errno 报出来。这样**五项全部零副作用**，不会在只读盘或受限沙箱下误判，也不需要"写完即删"这种脆弱约定。

`douyin` 项的 `detail` 取值只有三种（来自 `cookie-status` 的 `status` 字段）：`authenticated` → 「凭据已存在，有效性未知」；`no_auth` → 「凭据缺少登录态字段」；`empty` → 「尚未登录」。**三种都不出现「已登录」。**

---

## 5. 深检任务与互斥规则

### 5.1 全局单飞

同时只允许**一个**深检（任何渠道）。沿用发布中心"一次只允许一个"的纪律：`running` 期间再触发一律 **409**。理由是桌面机上同时开多个浏览器既重又没必要。

### 5.2 互斥粒度：按渠道，不是全局

冲突的根源是**同一个浏览器 profile 目录被两个进程同时使用**，不是"系统里只能有一个自动化"。因此：

1. **该渠道有发布在跑 → 不允许发起该渠道的深检**（按钮禁用，文案写明"有发布在进行中"）
2. **该渠道有深检在跑 → 不允许发起该渠道的发布**，但界面提供「**取消检测**」出口

抖音深检不挡头条发布（两者不碰同一个 profile），挡住是白挡。**这两条各有一条用例守**（§9 后端 #7）。

### 5.3 取消与 profile 锁文件（已知风险）

取消 = 终止进程 + 记 `cancelled`（**不是** `failed`）。⚠️ 但**强杀 Chromium 可能留下 profile 锁文件**，所以取消后**不许假装干净** —— 必须如实告知「检测已取消；如需确认登录态，请稍后重新验证一次」。

### 5.4 不许做假进度条

`sau` 的 CLI **不输出任何中间进度**，我们拿不到中间态。因此界面只能陈述事实：

> 已运行 42 秒 · 通常 10–30 秒，最坏 5 分钟

**不显示百分比、不做进度条、不假装"还差一点"。** 与本仓一贯的"不伪造成功"是同一条纪律。

### 5.5 轮询

**直接复用 `QrLoginPanel` 那套，不新发明**（`QrLoginPanel.tsx:57-97`）：`setTimeout` 自续期 + `POLL_INTERVAL_MS` + `stopped` ref + **轮询失败不清状态、下一拍自愈** + 卸载清理。间隔 2s，上限与任务超时一致。

### 5.6 超时、失败与错误边界

- 抖音上限用既有 `CHECK_TIMEOUT_MS = 300_000`（不新造常量）；头条/小红书沿用各自 `verify` 的超时
- 超时 → `failed` + **必须把 runner 的指引原样带上**
- ⚠️ **`RuntimeCheckError` 必须登记到新路由自己的错误边界**。AGENTS.md 记着那次事故：头条一族错误类漏登记的表现**不是状态码不准，而是"指引整条丢掉"**，全落进兜底 500 且没有日志（`publishing-routes.ts:727` 的 `console.error` 正是为此补的）。

新路由放在**新文件** `src/lib/runtime-routes.ts`，自带错误边界（登记 `RuntimeCheckError` 与 `SauRunnerError` / `Toutiao*Error` / `Xhs*Error` 三族），兜底分支同样 `console.error`。**不复用** `publishing-routes.ts` 的边界：两个模块的路由装配彼此独立，边界跨模块隐式共享迟早会漏。

---

## 6. 界面与入口

### 6.1 发布中心 · 概览条（概览层）

位置：页面标题下方、渠道页签上方，一条常驻行。

- 五项：抖音 / 头条 / 小红书 / ffmpeg / 存储目录，每项 = 名称 + 状态徽章 + 短文案
- 右侧「重新检查」+ 页面标题右侧显示「本次检查：刚刚」
- blocked / degraded 项可点 → 下钻到设置页「运行环境」对应行（那里有逐层诊断与可照抄命令）

**文案纪律在此落地**：抖音那格写 `凭据已存在`，**不写** `已登录`；只有带 `verified` 的项才显示「2h 前验证 · 登录态有效」。

**刷新时机**（三处，缺一个就会出现"状态不更新"的观感 bug）：

| 时机 | 动作 |
| --- | --- |
| `PublishingPage` 挂载 | 拉一次 `GET /api/runtime/status` |
| 点「重新检查」 | 同上（免费检查，可随意重复） |
| **某个深检轮询到终态**（`succeeded` / `failed` / `cancelled`） | **重新拉一次 status** —— 否则 §10 AC-6「概览条同步变绿」不成立 |
| **一次发布结束**（含失败） | 重新拉一次 —— §3.3 第③条的 `verified` 是发布写进去的 |

**断点**：`≥ md` 显示全部五项；`< md` 只显示非 `ready` 项，全绿时收成一行「环境正常 · 刚刚检查」（断点沿用 `AppShell` 既有口径，不新造）。

### 6.2 设置页 › 运行环境（深检层）

结构（自上而下）：

1. 分组标题 + 说明（「免费检查零副作用；验证登录态会打开浏览器，同渠道的发布请等它结束」）+「重新检查」
2. **发布渠道**：三个渠道行，每行 = 名称 + 状态徽章 + `detail` + `evidence`（可折叠）+ `guidance`（等宽字体 + 复制按钮）+ 动作（「立即验证登录态」「去登录」）+ `verified` 时间戳
3. **发布链路依赖**：ffmpeg、storage（只有状态 + 路径 + 指引，**没有深检按钮** —— 它们没有"登录态"可验）
4. 深检进行中行（`running` 时出现）：`已运行 N 秒 · 通常 10–30 秒，最坏 5 分钟` + 「取消检测」
5. **诊断信息（默认收起）**：`dist/` 与 `dist-electron/` 的构建时间（即决策 ⑦ 的 build tag）

**`DouyinSection` 的迁移**：那张 `Cookie 状态` 卡片**移到这里**，原分组顶部改为一行紧凑状态行（同组件 `variant="compact"`、同一份数据）。这不是"两处各自维护"，是同一实现两种尺寸 —— ⑤ 选 A 时确认过的缓解措施。

**顺带修掉的旧问题**：`DouyinSection` 现有说明只讲采集（「登录后即可使用签名 API 批量采集视频」），但**同一份 cookie 也是 sau 发布的唯一真源**。新界面必须写明「采集与发布共用同一份」。

**build tag 的落点**：默认收起的诊断信息里显示后端 `dist/` 与 Electron `dist-electron/` 的构建时间。呼应 spec §2「**版本与开发端口退出主视觉**」—— 只在排障时被看见。

### 6.3 组件边界

| 单元 | 职责 | 依赖 |
| --- | --- | --- |
| `renderer/src/components/RuntimeStatusList.tsx` | 渲染 `RuntimeItem[]`，`variant: "compact" \| "full"` | 纯展示，不含判定 |
| `renderer/src/components/RuntimeStateBadge.tsx` | 状态 → lucide 图标 + 文字 | 四种状态映射 |
| `renderer/src/utils/runtime.ts` | 纯函数：状态→图标/文案、窄屏过滤、耗时格式化（`已运行 42 秒`） | 有独立用例 |
| `renderer/src/services/api.ts` | 三个新方法 | — |

**状态 → 图标**（统一 lucide，本仓禁止 emoji 当功能图标）：`ready` → `CheckCircle2`、`degraded` → `AlertTriangle`、`blocked` → `XCircle`、`unknown` → `HelpCircle`。

**颜色映射复用既有 token，不新增任何 token**：`ready` → `--color-success`、`degraded` → `--color-warning`、`blocked` → `--color-danger`、`unknown` → `--color-ink-subtle`。徽章**必须同时有图标与文字**（不能只靠颜色，spec §5.1）。`theme.test.ts` 的门禁因此原样通过。

---

## 7. 状态表达与不变式

便于用例逐条引用：

- **INV-1** `GET /api/runtime/status` 的 `detail` 与状态文案**不含**「已登录」「有效」；`verified` 仅在 store 有记录时出现
- **INV-2** `verified.state = "valid"` 只可能来自：深检成功、或发布链路里跑过的 `checkLogin` 成功
- **INV-3** 免费层零副作用：不写文件、不启动进程、不开浏览器
- **INV-4** 全局同时最多一个深检；同渠道的深检与发布互斥；跨渠道不互斥
- **INV-5** `running` 的深检**不显示百分比**
- **INV-6** 深检失败 / 超时**必须**带 `guidance`（不得被兜底 500 吃掉）
- **INV-7** 前端不做状态判定：红灯规则只存在于服务端的 `state` 字段
- **INV-8** 不新增 design token

---

## 8. 明确不做

- ❌ **定时轮询 / 后台常驻探测** —— 会与发布抢 profile；我们不需要多一个后台进程
- ❌ **whisper / Node 22 / HyperFrames**（生成链路，决策 ③ 已排除）
- ❌ **历史趋势、可用率图表** —— 这是排障工具，不是监控面板
- ❌ **"一键修复"** —— 我们能给的是**可照抄的命令**；装环境不该由应用代劳，也不该假装能代劳
- ❌ **⌘K 命令面板**（先前排的第二项）—— 单独一张 spec，不塞进这份
- ❌ 把运行环境状态挂进 `GET /api/publishing/packages` 的响应（评估过，耦合过重）

---

## 9. 测试与验证

### 9.1 后端用例

1. `聚合端点返回 5 项，每项 state/detail 非空`
2. `免费层永远不输出「已登录/有效」语义`（守 INV-1；`verified` 只在有记录时出现）
3. `未配置 SAU_BINARY → douyin 为 blocked，且 guidance 与 SAU_INSTALL_GUIDANCE 逐字一致`
4. `解析链能落地但登录态未知 → degraded 而不是 ready`（头条、小红书各一条）
5. `ffmpeg 不可用 → blocked + 指引`；`storage 不可写 → blocked + 原样回显路径与 errno`
6. `同渠道深检重复触发 → 409`；`全局第二个深检（任何渠道）→ 409`
7. `抖音深检进行中，头条发布仍可发起`；`头条深检进行中，头条发布 → 409`（守 §5.2）
8. `残留 running 的深检在启动后被置为可重试，且僵死阈值 > CHECK_TIMEOUT_MS`
9. `深检失败必须带上 runner 的指引`（对标既有用例 `toutiao runner errors surface with their own status, code and guidance`）
10. `一次抖音发布尝试后，runtime-checks.json 的 verified.at 变新`（守 §3.3 第③条）
11. `取消检测 → status = cancelled（不是 failed），并提示可能需要重新验证`

### 9.2 前端用例

1. `variant="compact" 与 "full" 渲染同一份模型`
2. `状态徽章同时含图标与文字`（不能只靠颜色）
3. `免费层文案不含「已登录」`（前端再守一遍，双保险）
4. `检测中显示「已运行 N 秒」与耗时区间，且不含百分比`
5. `blocked 项把 guidance 的每一行命令都渲染出来`

### 9.3 门禁

- `npm run check`（含 `check:secrets`）
- `theme.test.ts` **不改**（本设计不新增 token）
- 改完 `npm run build:backend` / `build:renderer` **再验**（AGENTS.md 记着两套产物踩错的表现都是「改了没生效」）

---

## 10. 验收标准

| # | 验收（可观察行为） |
| --- | --- |
| AC-1 | 打开发布中心，**不做任何操作**即可看到 5 项状态与"本次检查"时刻 |
| AC-2 | 小红书没装浏览器时概览条显示 blocked，点「查看」→ 运行环境，展开即见三段可照抄命令 |
| AC-3 | 三渠道的「去登录」都能跳到对应登录分组 |
| AC-4 | 点「验证登录态」**立刻返回**并显示「检测中 · 已运行 N 秒 · 通常 10–30 秒，最坏 5 分钟」，可切走再回来 |
| AC-5 | 检测期间**同渠道**发布禁用并说明原因；**跨渠道不受影响** |
| AC-6 | 检测完成 → 该行显示「登录态有效 · 刚刚」，概览条同步变绿，无需手动刷新 |
| AC-7 | 发一次抖音图文后，**即便没点过深检**，抖音行的"上次验证"也变新了 |
| AC-8 | 免费层任何文案都不出现「已登录」；只有深检/发布留下的结论才谈有效性 |
| AC-9 | 诊断信息默认收起，展开才见 `dist/` 与 `dist-electron/` 构建时间 |

---

## 11. 风险与控制

| 风险 | 说明 | 控制 |
| --- | --- | --- |
| **🟠 与发布抢 profile** | 深检与发布同时用同一 profile 会互相破坏 | 按渠道互斥（§5.2）+ 取消出口；两条用例守 |
| **🟠 取消后的 profile 锁文件** | 强杀 Chromium 可能留下锁，下次启动异常 | 如实告知"可能需要重新验证一次"（§5.3），**不假装干净** |
| **🟡 免费层被误读成"能发"** | 用户看到绿点以为万无一失 | INV-1 + 双端文案用例（§9.1#2、§9.2#3）；`ready` 定义写进契约注释 |
| **🟡 抖音 5 分钟被当成卡死** | 无进度可显示 | 明确耗时区间 + 可切走 + 轮询自愈（§5.4/§5.5） |
| **🟡 新错误类漏登记** | 表现是**指引整条丢掉**，不是状态码不准 | §5.6 自带边界 + 用例 #9 |
| **🟡 两处呈现漂移** | 概览条与运行环境各写一套判定 | INV-7：判定只在服务端；两处共用同一模型与同一组件（§6.3） |
| **🟢 迁移动到 `DouyinSection`** | 删掉既有状态卡片属行为变更 | 紧凑状态行（同组件）保证"看不到状态"不成立；既有用例作为门禁 |

---

## 12. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/lib/runtime-status.ts`（新） | 聚合五项免费检查、读写 `cache/runtime-checks.json` |
| `src/lib/runtime-checks.ts`（新） | 深检任务状态机、单飞与按渠道互斥、僵死恢复 |
| `src/lib/runtime-routes.ts`（新） | 三个端点 + **自带错误边界** |
| `src/lib/publishing-service.ts` | 发布/预检处顺手写 `verified`（§3.3 第③条） |
| `src/lib/media.ts` | 新增 ffmpeg 可用性检查（供 `runtime-status.ts` 调用） |
| `src/app.ts` | `registerRuntimeRoutes(app, { … })`（装配点见 `app.ts:284` 附近） |
| `renderer/src/pages/PublishingPage.tsx` | 概览条 |
| `renderer/src/pages/SettingsPage.tsx` | 新增「运行环境」分组；`DouyinSection` 迁移状态卡片 |
| `renderer/src/utils/settingsSections.ts` | 7 项 → 8 项 |
| `renderer/src/components/RuntimeStatusList.tsx`（新） | 同一模型的两种尺寸 |
| `renderer/src/components/RuntimeStateBadge.tsx`（新） | 徽章（图标 + 文字） |
| `renderer/src/utils/runtime.ts`（新） | 纯函数 + 用例 |
| `renderer/src/services/api.ts` | 三个新方法 |
| `docs/superpowers/plans/` | 实施计划（下一步） |

---

## 13. 实施顺序

1. **Task 1 · 服务端聚合**：`runtime-status.ts` + 端点 + 五项检查（含新写的 ffmpeg / storage）+ 用例 1–5
2. **Task 2 · 深检任务**：状态机、单飞与按渠道互斥、僵死恢复、错误边界 + 用例 6–9、11
3. **Task 3 · 发布预检回写**：`publishing-service.ts` 三处接上 + 用例 10
4. **Task 4 · 渲染层**：`RuntimeStatusList` / `RuntimeStateBadge` / `utils/runtime.ts` + 前端用例 1–5
5. **Task 5 · 两个界面**：发布中心概览条 → 设置页「运行环境」→ `DouyinSection` 迁移 → 「去登录」锚点
6. **Task 6 · build tag 诊断区**：`dist/` 与 `dist-electron/` 构建时间（决策 ⑦）
7. **Task 7 · 收尾**：`npm run check`、编译两套产物、真机走一遍 AC-1…AC-9
