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
POST /api/runtime/checks                     body: { id: "douyin" | "toutiao" | "xiaohongshu" }
GET  /api/runtime/checks/:checkId
POST /api/runtime/checks/:checkId/cancel     ← 实现时补的（见下方 ⚠️）
```

**鉴权与审计口径**（与发布中心同源，不另创一套）：四个端点都走 `authenticated`。深检**不写审计记录** —— 它是本机诊断，不改变任何业务状态；发布中心的 `requireActor` / `actor` 快照口径**不变**，不被本设计触碰。

> ⚠️ **实现时对 spec 的三处修正**（Task 2 落地后回填，都有代码依据）：
> ① **取消了原写的 `writable` 中间件**：发布中心那个 `writable` 检查的是 `app.locals.publishingHealth.readOnly`，是**发布索引**的只读保护；运行环境不碰发布索引，套上去只会变成一个永远放行的空壳。
> ② **补了取消端点**：原稿只在 §5.3 写了「界面提供取消出口」，却没给路由 —— 没有端点那个按钮点不动。
> ③ **`check` 字段由路由合并**：`collectRuntimeStatus()` 保持纯净（只做免费检查、不 import 任务层），当前深检摘要由路由并发取一次再合进响应，于是深检没装上时也只是 `check: null`。

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
    /** 补充说明（如「目录尚未创建（首次使用时创建）」），用例会断言其存在。 */
    notes?: string[];
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
`GET /api/runtime/status` 产出的 `detail` 只能是「存在 / 未知 / 缺失」这一类**事实**，不能替平台下结论；`verified` 字段**只在 store 里有记录时才出现**。

⚠️ 因此**免费层自己产不出 `ready`**：渠道的 `ready` 依据的是**持久化的 `verified` 记录** + 配置齐备（§3.4 映射表），而不是"配置看起来没问题"。免费层单独能给出的最好结论是 `degraded`（「凭据已存在，有效性未知」）。

**② 深检结论持久化到 `storage/cache/runtime-checks.json`。**
沿用 `cache/publishing-index.json` 的 `LocalStorage` 形状（`publishing-store.ts:24`）。免费层每次现算、不缓存；**只有深检结论带时间戳落盘** —— 这样「上次验证：2 小时前」跨重启仍然成立。

**③ 发布链路里已经产生的登录判据，顺手写进同一个 store。**

⚠️ 三个渠道的**判据来源不同**，别按"都有 precheck"去实现（本 spec 初稿就是这么写错的，评审指出后更正）：

| 渠道 | 判据来源 | 位置 | 是否新增访问 |
| --- | --- | --- | --- |
| 抖音 | 发布前**显式预检** `runner.checkLogin()`（每次必跑，最坏 5 分钟） | `publishing-service.ts:1698` | 否，本来就在跑 |
| 今日头条 | 同上 | `publishing-service.ts:1113` → `toutiao-runner.ts:238` | 否 |
| 小红书 | **没有 precheck**。用发布流程**内部已有**的登录判据：`goto(发布页)` 后命中 `isXhsLoginUrl` 即"**一步都不做**"返回 | `xhs-runner.ts:578` | **否，且禁止为此新增任何页面访问** |

回写规则（三渠道统一，**只写确凿证据**）：

- 判据为「登录态有效」→ `verified = valid`
  - 抖音：`checkLogin()` 的 `ok === true`（即 `exitCode === 0` **且**输出命中 `valid`）
  - 今日头条：发布前预检通过
  - 小红书：走完全程且全程未被踢到登录页（含默认的"只填到草稿"姿态）
- 判据为「登录态失效」→ `verified = invalid`
  - ⚠️ 抖音**只有 `exitCode === 0 && ok === false` 才算失效**：`checkLogin()` 的 `ok = exitCode === 0 && VALID_OUTPUT_PATTERN.test(output)`（`sau-runner.ts:194`）。而 `exitCode === -1` 是**超时或进程起不来**（`sau-runner.ts:129-137` 的 `CommandError` 分支），那是"**没验成**"，不是"失效" —— 按 `!ok` 就写 `invalid`，会把一次超时变成最长 7 天的错误红灯
  - 小红书：`result.code === "xhs_not_logged_in"`
- **其他任何失败 → 不写**（保持未知，不许猜）

于是「发过一次」＝「深检过一次」，**用户不点任何按钮状态也会自己变新**。这是本设计里复用既有成本最彻底的一处。

小红书那条**不需要任何接口改动**：`XhsPublishResult` 已经有 `code?: string`（`xhs-runner.ts:159-160`），而 `xhs-runner.ts:578` 的早返回已经把它设成 `"xhs_not_logged_in"`，结果为 `{ok:false, code:"xhs_not_logged_in", submitted:false, verification:"unconfirmed"}`，服务层在 `publishing-service.ts:1554` 就拿得到整个结果。**明确禁止**为了归因去新增任何页面访问 —— 这条通路我们连"发布后读回"都刻意不做。

### 3.4 状态映射（条件 → 四态）

四个状态是契约核心字段，**判定只有服务端一处**（INV-7）。规则如下：

| 项 | `ready` | `degraded` | `blocked` | `unknown` |
| --- | --- | --- | --- | --- |
| **渠道** | 配置齐 + 凭据存在 + `verified.state = "valid"` 且 `age ≤ RUNTIME_VERIFIED_TTL_MS` | 配置齐 + 凭据存在，但**无 `verified`** 或**已超过 TTL** | 配置缺失 / 可执行文件缺失 / 目录不可写 / 凭据为空（`empty`）/ `verified.state = "invalid"` 且在 TTL 内 | 免费检查**自身抛错**（读不到凭据文件、探测异常） |
| **依赖** | 检查通过 | （渠道项专用；依赖项不产出） | 检查失败（不可执行 / 不可写） | 检查抛错 |

`RUNTIME_VERIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000`（7 天，可调）。

要点：**渠道只有在"真的验证过且没过期"时才是 `ready`** —— 绿点才有含金量。这与 INV-1（免费层不谈有效性）不冲突：`ready` 依据的是**持久化的 `verified` 记录**，不是免费层的推断。

### 3.5 僵死恢复

深检任务若在 `running` 时进程被杀，会留下一条永远 `running` 的记录，界面里没有入口能清掉它 —— 与 `AUTO_PUBLISH_STALE_MS`（`publishing-store.ts`）面对的是同一个问题，注释里的推理照抄：

- 启动时按 `jobs.ts` 的做法把残留 `running` 置为可重试（`jobs.ts:135-150`）
- **僵死阈值 `RUNTIME_CHECK_STALE_MS = 10 * 60_000`**：必须大于最大超时（抖音 `CHECK_TIMEOUT_MS = 300_000`，`sau-runner.ts:48`），否则会误判活着的进程。取值与 §5.6 的超时表联动，改一处要改两处

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

**profile 目录可写性要多说一层**：目录由 runner 自己 `mkdir`（调用点 `xhs-runner.ts:728` / `toutiao-runner.ts:654`；两处 `EPERM: … mkdir` 的注释在 `:723` / `:626`），首次运行时目录**可能还不存在** —— 此时对目录本身 `access(W_OK)` 会得到 `ENOENT`，报成 `blocked` 就是**假阳性**。规则是：目录存在 → 查它本身；不存在 → 查**最近的已存在祖先目录**的 `W_OK`。

⚠️ 这条**只决定"要不要判 `blocked`"，不直接给 `ready`** —— 最终状态一律按 §3.4 的总规则（无 `verified` 就是 `degraded`）。祖先可写 → 该子检查通过，`evidence.notes` 记「目录尚未创建（首次使用时创建）」；祖先不可写 → `blocked` + errno。

**`guidance` 统一为 `string[]`，但既有常量是单串**：三份 GUIDANCE 都是 `[...].join("")` 产出的**一个长串**（`sau-runner.ts:68`、`toutiao-browser.ts:38`、`xhs-browser.ts:39`），元素之间**没有换行符**，直接当数组渲染不出来。做法：**给三份常量各补一个数组形态导出**（`SAU_INSTALL_GUIDANCE_LINES` 等），既有字符串导出**逐字不变**（现有错误文案在插值使用），聚合层用数组形态。用例 #3 因此断言「数组形态 `join("")` 后与既有常量逐字一致」—— 两份形态**不可能漂**。

`douyin` 项的 `detail` 取值只有三种（来自 `cookie-status` 的 `status` 字段）：`authenticated` → 「凭据已存在，有效性未知」；`no_auth` → 「凭据缺少登录态字段」；`empty` → 「尚未登录」。**三种都不出现「已登录」。**

---

## 5. 深检任务与互斥规则

### 5.1 深检之间：全局单飞

同时只允许**一个**深检（任何渠道）。沿用发布中心"一次只允许一个"的纪律：`running` 期间再触发一律 **409**。理由是桌面机上同时开多个浏览器既重又没必要。

### 5.2 深检 ↔ 发布的互斥粒度：按渠道（不是全局）

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

**直接复用 `QrLoginPanel` 那套，不新发明**（`QrLoginPanel.tsx:57-97`）：`setTimeout` 自续期 + `POLL_INTERVAL_MS` + `stopped` ref + **轮询失败不清状态、下一拍自愈** + 卸载清理。**形状与间隔都复用**：间隔取 `QrLoginPanel.tsx:16` 的 `POLL_INTERVAL_MS = 3_000`，不另定一套。

### 5.6 超时、失败与错误边界

- **超时常量**（runner 里**没有** verify 专属超时，只有登录/窗口登录的超时，不能借用）：

  | 渠道 | 上限 | 来源 |
  | --- | --- | --- |
  | 抖音 | `CHECK_TIMEOUT_MS = 300_000` | 复用既有常量（`sau-runner.ts:48`），**需把它改成 `export`** —— 现在是模块私有，而用例 #8 要读它做比对 |
  | 今日头条 | `RUNTIME_CHECK_TIMEOUT_MS = 120_000` | **新常量**（`DEFAULT_LOGIN_TIMEOUT_MS = 10min` 是扫码登录的，不是自检的） |
  | 小红书 | `RUNTIME_CHECK_TIMEOUT_MS = 120_000` | 同上 |

- 超时 → `failed` + **必须把 runner 的指引原样带上**
- ⚠️ **`RuntimeCheckError` 必须登记到新路由自己的错误边界**。AGENTS.md 记着那次事故：头条一族错误类漏登记的表现**不是状态码不准，而是"指引整条丢掉"**，全落进兜底 500 且没有日志（`publishing-routes.ts:727` 的 `console.error` 正是为此补的）。

新路由放在**新文件** `src/lib/runtime-routes.ts`，自带错误边界，兜底分支同样 `console.error`。**不复用** `publishing-routes.ts` 的边界：两个模块的路由装配彼此独立，边界跨模块隐式共享迟早会漏。

> ⚠️ **实现时修正（Task 2）**：原稿要求把 `SauRunnerError` / `Toutiao*Error` / `Xhs*Error` 也登记到这个边界，**实现下来它们到不了这里** —— 探测内部的任何异常都在深检任务里被收敛成**带指引的 `failed` 记录**（见 §5.4 的超时/失败规则）。这比抛到边界更好：那次失败本来就该留在记录里给界面看。所以边界只登记真正会逃逸的 `RuntimeCheckError` / `RuntimeRouteError` / `LocalAuthError`，并有用例守「失败必带指引」。

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

**与既有三个登录分组的关系（不写清就会自相矛盾）**：登录分组里的「**校验登录**」按钮**保留**，并让它**同时刷新 `verified`** —— 它与「运行环境」的「验证登录态」是**同一份结论的两个入口**（服务端复用同一套实现：头条/小红书走 `verifyToutiaoLogin` / `verifyXhsLogin`）。扫码登录成功也写 `verified`（INV-2 ③）。

于是不会出现「设置页刚说已登录、运行环境却是黄的」：两处读的都是**同一条带时间戳的 `verified` 记录**。`QrLoginPanel` 那句「已登录（昵称）」是**登录动作的即时反馈**，保留原样；长驻状态一律以运行环境的徽章为准。

**build tag 的落点**：默认收起的诊断信息里显示后端 `dist/` 与 Electron `dist-electron/` 的构建时间。呼应 **UI 重构 spec §2**「**版本与开发端口退出主视觉**」—— 只在排障时被看见。

### 6.3 组件边界

| 单元 | 职责 | 依赖 |
| --- | --- | --- |
| `renderer/src/components/RuntimeStatusList.tsx` | 渲染 `RuntimeItem[]`，`variant: "compact" \| "full"` | 纯展示，不含判定 |
| `renderer/src/components/RuntimeStateBadge.tsx` | 状态 → lucide 图标 + 文字 | 四种状态映射 |
| `renderer/src/utils/runtime.ts` | 纯函数：状态→图标/文案、窄屏过滤、耗时格式化（`已运行 42 秒`） | 有独立用例 |
| `renderer/src/services/api.ts` | 三个新方法 | — |

**状态 → 图标**（统一 lucide，本仓禁止 emoji 当功能图标）：`ready` → `CheckCircle2`、`degraded` → `AlertTriangle`、`blocked` → `XCircle`、`unknown` → `HelpCircle`。

**颜色映射复用既有 token，不新增任何 token**：`ready` → `--color-success`、`degraded` → `--color-warning`、`blocked` → `--color-danger`、`unknown` → `--color-ink-subtle`。徽章**必须同时有图标与文字**（不能只靠颜色，**UI 重构 spec §5.1**）。`theme.test.ts` 的门禁因此原样通过。

---

## 7. 状态表达与不变式

便于用例逐条引用：

- **INV-1** `GET /api/runtime/status` 的 `detail` 与状态文案**不含**「已登录」「有效」；`verified` 仅在 store 有记录时出现
- **INV-2** `verified.state = "valid"` 只可能来自**五处**：① 运行环境深检成功（`POST /api/runtime/checks`）；② 设置页既有的「**校验登录**」（`POST /publishing/toutiao/verify` / `xhs/verify`，本身就是零副作用自检）；③ **扫码登录成功**（`pollXhsLogin` 拿到 `logged_in` ——「刚刚亲眼确认过」，最强证据）；④ 抖音 / 头条发布前的 `checkLogin` 通过；⑤ 小红书走完全程且全程未被踢到登录页。**其他任何失败都不写 `verified`**（不许猜）
- **INV-3** 免费层**不改变任何状态**：不写文件、不开浏览器、不触碰平台。**允许**执行短命的只读探测命令（`ffmpeg -version`）—— 否则只能退化成"PATH 里有没有那个文件"，查不出装坏的 ffmpeg
- **INV-4a** 深检之间：全局同时最多一个
- **INV-4b** 深检 ↔ 发布：**按渠道**互斥（同渠道互斥；跨渠道的**发布**不受影响）
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
3. `未配置 SAU_BINARY → douyin 为 blocked`，且 `guidance` 数组形态 `join("")` 后与 `SAU_INSTALL_GUIDANCE` **逐字一致**（头条/小红书同理，对 `TOUTIAO_BROWSER_GUIDANCE` / `XHS_BROWSER_GUIDANCE`）
4. `解析链能落地但登录态未知 → degraded 而不是 ready`（头条、小红书各一条）
5. `ffmpeg 不可用 → blocked + 指引`；`storage 不可写 → blocked + 原样回显路径与 errno`
6. `同渠道深检重复触发 → 409`；`全局第二个深检（任何渠道）→ 409`
7. `抖音深检进行中，头条发布仍可发起`；`头条深检进行中，头条发布 → 409`（守 §5.2）
8. `残留 running 的深检在启动后被置为可重试，且 RUNTIME_CHECK_STALE_MS > 抖音自检超时`（用 `sau-runner.ts` 新导出的 `CHECK_TIMEOUT_MS` 比对，见 §12）
9. `深检失败必须带上 runner 的指引`（对标既有用例 `toutiao runner errors surface with their own status, code and guidance`）
10. `一次抖音发布尝试后，runtime-checks.json 的 verified.at 变新`（守 §3.3 第③条）
11. `取消检测 → status = cancelled（不是 failed），并提示可能需要重新验证`
12. `免费层零副作用`（守 INV-3）：**注入 fake 端口**后，整个 `GET /api/runtime/status` 期间没有任何写操作、没有浏览器启动；`ffmpeg` 探测只执行 `-version`（断言调用形状）。依赖 §12 里 `RuntimeStatusDeps` 的注入缝 —— 本仓没有模块 mock 约定，fake 一律靠接口注入（如 `media.test.ts:21` 注入 `MediaCommandRunner`）
13. `profile 目录不存在但祖先可写 → 不因此报 blocked（state 仍按 §3.4 为 degraded），且 evidence.notes 含「尚未创建」`（守 §4 的假阳性规则）
14. `小红书三条归因各一条：被踢到登录页 → verified=invalid；走完全程（含"只填到草稿"）→ verified=valid；其他失败 → **不写** verified`（守 §3.3 第③条与 INV-2）

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
| AC-5 | 检测期间**同渠道**发布禁用并说明原因；**跨渠道的发布不受影响**（深检本身仍全局单飞，见 §5.1） |
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
| **🟡 小红书 `verified` 是"当时有效"的推断** | 发布成功 ≠ 登录态永远有效，它只证明"那一刻没被踢到登录页" | 文案一律带时间戳（「2h 前验证 · 登录态有效」）+ `RUNTIME_VERIFIED_TTL_MS` 到期回落 `degraded`；**不写成"当前已登录"** |

---

## 12. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/lib/runtime-status.ts`（新） | 聚合五项免费检查、读写 `cache/runtime-checks.json`；依赖经 **`RuntimeStatusDeps` 注入**（`fs`、命令探测端口），以便用例断言零副作用（沿用 `media.test.ts:21` 注入 `MediaCommandRunner` 的既有约定） |
| `src/lib/runtime-checks.ts`（新） | 深检任务状态机、单飞与按渠道互斥、僵死恢复 |
| `src/lib/runtime-routes.ts`（新） | 三个端点 + **自带错误边界** |
| `src/lib/publishing-service.ts` | ① 写 `verified`：发布/预检（§3.3 第③条）、既有的 `verifyToutiaoLogin` / `verifyXhsLogin`（设置页「校验登录」）、扫码登录成功；② **发布入口读 runtime check 状态 → 同渠道 409**（§5.2 规则 2 / INV-4b），新错误码 `publish_blocked_by_runtime_check` + 中文文案 |
| `src/lib/media.ts` | 新增 ffmpeg 可用性检查（供 `runtime-status.ts` 调用） |
| `src/lib/sau-runner.ts` / `toutiao-browser.ts` / `xhs-browser.ts` | 各补一个 `*_GUIDANCE_LINES` 数组导出（既有字符串导出逐字不变，§4）；`sau-runner.ts` 另把 `CHECK_TIMEOUT_MS` 改成 `export`（§5.6、用例 #8） |
| `src/lib/xhs-runner.ts` | **无需接口改动**：归因直接用既有的 `result.code === "xhs_not_logged_in"`（§3.3 第③条） |
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
2. **Task 2 · 深检任务**：`runtime-checks.ts`（状态机、单飞、僵死恢复）+ `runtime-routes.ts`（含自带错误边界）+ **`publishing-service.ts` 发布入口的按渠道互斥 409** + 用例 6–9、11
3. **Task 3 · 发布判据回写**：抖音 / 头条的 precheck 两处接上；小红书按 `result.code` 归因（**无接口改动**）；设置页既有的「校验登录」与扫码登录成功一并写 `verified`（INV-2 ②③）+ 用例 10、14
4. **Task 4 · 渲染层**：`RuntimeStatusList` / `RuntimeStateBadge` / `utils/runtime.ts` + 前端用例 1–5
5. **Task 5 · 两个界面**：发布中心概览条 → 设置页「运行环境」→ `DouyinSection` 迁移 → 「去登录」锚点
6. **Task 6 · build tag 诊断区**：`dist/` 与 `dist-electron/` 构建时间（决策 ⑦）
7. **Task 7 · 收尾**：`npm run check`、编译两套产物、真机走一遍 AC-1…AC-9
