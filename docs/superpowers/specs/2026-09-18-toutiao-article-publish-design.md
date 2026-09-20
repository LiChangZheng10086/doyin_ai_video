# 抖创工坊 今日头条 AI 文章发布 设计规格

**状态：** DRAFT（待用户评审）
**日期：** 2026-09-18
**产品：** 抖创工坊
**范围：** 把已完成任务的产品（转录 + AI 洗稿）生成一篇头条文章，渲染成可粘贴的富文本 HTML，经**应用内扫码登录**的头条号会话，在 `mp.toutiao.com` 发布页**真实点击「发布」**；成功后只记「已提交」，最终由人工在头条后台核实后点既有「标记已发布」
**实施边界：** 只新增 `toutiao` 一条平台通路 + 一个自研浏览器执行器；复用既有**文章内核**（AI 成文 + `article` 包 + `previewRevision`）；**不新增任何 npm 依赖**、不引外部引擎、不做视频/微头条/数据/评论

**调研证据：** `docs/research/toutiao-ops-assessment.md`（clone 全仓逐文件核对 + npm 实装 + 真实站点只读探针）

---

## 1. 背景与结论

发布中心现在有三条通路：视频/图文的**人工交付**、**抖音图文自动发布**（外部 `sau` CLI）、**微信公众号草稿**（官方 API，WIP 已暂停）。本次接入第四条：**今日头条文章发布**。

### 1.1 参考项目 [mf-yang/toutiao-ops](https://github.com/mf-yang/toutiao-ops) 实测（2026-09-18，非读 README）

| 维度 | 实测结果 |
| --- | --- |
| HEAD | `de89bba5ec820d8709ca8feec0241423f3d2bede`（2026-04-08），最后一次提交正是「修改封面图片路径为必填项」 |
| 规模 | 全仓 **4089 行**；**与文章发布有关只有约 830 行**（`publish-article.js` 295 + `auth.js` 293 + `browser.js` 204 + `auth-guard.js` 39） |
| 许可证 | **MIT** —— 可借鉴流程与思路，唯一义务是保留版权声明 |
| 技术方案 | Playwright **持久化上下文**（`~/.toutiao-ops/accounts/<name>/browser-data`）+ `playwright-extra` + `puppeteer-extra-plugin-stealth` |
| 正文粘贴 | `marked.parse(markdown)` → 页面内构造 `ClipboardEvent('paste')` 派发 `text/html`（富文本） |
| npm 包 | `@openclaw-cn/toutiao-ops@1.1.4`：14 文件 / **unpackedSize 95,462 字节**；实测 `npm install --ignore-scripts` → 47 包 / 21MB / **3 秒**，`--help` 正常 |
| 硬约束 | 标题 **2~30 字**（超出按 UTF-16 码元截断）；**封面必填**；**正文不支持配图**（全文件只处理封面） |

**结论：它的「文章发布」本体只有约 830 行，比 `sau`（约 970MB、3 个安装坑）轻一个量级；而且我们不需要装它。** 详见 §1.3。

### 1.2 三个必须自己处理的问题（照抄会踩）

1. **🔴 静默失败**：`setCoverMode` / `addToCollection` / `uncheckWeitoutiao` / `clickLabel` / `setDeclarations` **全部**是 `try{…}catch{}` 空吞异常，函数最后**无条件** `return { success: true, action: 'published' }`。头条不允许无封面发布，所以「封面失败 + 仍点发布」的真实结局是**发失败却报成功**。
2. **🟠 发布结果不校验**：点「确认发布」是 `.catch(()=>{})`，返回的 `url` 只是 `page.url()`，**没有任何一处**去作品列表确认文章真的存在；`--draft` 分支更是什么都不点就报 `draft_saved`。
3. **🟠 依赖版本浮动**：`"playwright": "^1.50.0"` 实测解析到 **1.63.0**，要 `chromium_headless_shell-1243`；本机 ms-playwright 缓存里只有 `1208`（属 patchright/sau）→ **它必须自己再下约 500MB 浏览器**。

**这三条决定了本设计的两条纪律：① 每一步都要有可断言的落地证据，关不掉/传不上去就**不发布**；② 发布后必须独立校验结果，并把「未能确认」如实写进审计。**

### 1.3 我们这边的实测（决定架构的关键证据）

| 事实 | 证据 |
| --- | --- |
| 我们自己的 Playwright **没有可用浏览器** | `playwright@1.62.1` 要 `chromium_headless_shell-1234`；缓存里只有 `chromium-1208`/`chromium_headless_shell-1208`；`chromium.launch()` → `Executable doesn't exist at …-1234/…` |
| **打包资源里已有可用浏览器** | `vendor/package-assets/browser/chrome-headless-shell/mac_arm-152.0.7928.2/…/chrome-headless-shell`（196MB，由 `npm run prepare:package:mac` 产出，`vendor/package-assets/` 被 gitignore） |
| **它能驱动真实头条页** | `chromium.launch({ executablePath: <它> })` → `LAUNCH OK 152.0.7928.2`；`goto https://mp.toutiao.com/auth/page/login` → title「头条号 - 你创作的，就是头条」、正文 2084 字、含「扫码登录」 |
| **登录态有干净契约** | 未登录时 `https://mp.toutiao.com/` → `/auth/page/login?redirect_url=JTJGcHJvZmlsZV92NCUyRg==`；发布页 → `…redirect_url=JTJGcHJvZmlsZV92NCUyRmdyYXBoaWMlMkZwdWJsaXNo`。**判 URL 即可**，不用猜 DOM |
| **二维码可直接从 DOM 取** | 登录页的 `<img>` 就是 `data:image/png;base64,…` 的 **512×512** 头条二维码；落盘肉眼核对确认为真二维码（含中央「头条」logo） |

→ **架构结论：复用已打包的 chrome-headless-shell 写自研 runner。零新依赖、零额外下载、不需要有头窗口，登录二维码直接在应用内展示。**

### 1.4 本功能最大的未知数（必须在 Task 1 用一次只读侦察消灭）

| # | 未知数 | 为什么必须实测 |
| --- | --- | --- |
| 🔴 1 | **登录后的真实发布页 DOM**（标题框、编辑器、封面入口、发布按钮、「同时发布微头条」勾选框、声明选项） | 参考项目的选择器是「多候选属性包含」的启发式写法（如 `[class*="cover"] [class*="add"]`），**从未被任何人验证过**（它把失败吞掉了，坏了也没人发现）。我们不能照抄，必须看真页 |
| 🟠 2 | 头条富文本编辑器是否接受 `ClipboardEvent` 粘贴 HTML | 参考实现声称可以，但**未经我们实测**；不可用时退回「按段落逐段输入纯文本」 |
| 🟠 3 | 无头浏览器是否被风控（登录页能开 ≠ 发布能过） | 侦察阶段一并验证；备选：`channel:"chrome"`（本机已装系统 Chrome） |
| 🟠 4 | **发布成功的可观测判据**（无接口回执） | 成功提示文案 / 跳转后 URL / 作品列表出现该标题，侦察阶段确定哪一个可断言 |
| 🟡 5 | 「同时发布微头条」**默认已勾选** | 不处理就会在用户不知情时多发一条内容。见 §2 决策 |

**这五项全部落在 Task 1（只读侦察：登录 → 进发布页 → 落 DOM 快照，不填表、不点发布）。它不是「可选的准备工作」，而是本功能的可行性判据 —— 与公众号通路的账号自检探针同一地位。**

**实测结论（2026-09-20 收敛，其中第 4 项仍未完全收敛）：**

| # | 结论 |
| --- | --- |
| 🔴 1 | ✅ **已消灭**：真实 DOM 已落到选择器与离线 fixture（标题 `textarea[placeholder*="标题"]`、正文 `.ProseMirror`、封面 `.article-cover-add` + 抽屉内第一个文件框、`publish-btn-last`） |
| 🟠 2 | ✅ **富文本粘贴有效**（真机演练与真实发布都走 `bodyMode: "rich"`） |
| 🟠 3 | ✅ **无头未被风控**：`chrome-headless-shell` 下真实发布成功一次 |
| 🟠 4 | ⚠️ **部分收敛**：确认页的**确认按钮候选命中了**（真机步骤里有「点击发布并确认」，文章确实发出）；但**成功提示文案不在候选里** → 这条路仍是 `unconfirmed` + 「先去后台核实」。因此 `submitAndConfirm` 现在**每次都带回确认后证据**（URL / 是否离开发布页 / 可见文案头+尾摘要）写进 `autoPublish.message`，下一次真机跑即可校准 |
| 🟡 5 | ✅ **已按 fail closed 处理**：默认勾选 → 主动取消并读回；关不掉就不发布（真机首次发布时这一步也真的执行了：步骤里有「关闭「同时发布微头条」」） |

---

## 2. 已确认设计决策

| 决策 | 结果 | 依据 |
| --- | --- | --- |
| **引擎路线** | **自研 runner**（Playwright + 已打包 chrome-headless-shell），**不用外部 CLI** | 用户 2026-09-18 确认；§1.3 实测 |
| **发布语义** | **真实点击「发布」**；`succeeded` 的语义是**已提交**，绝不写 `published`；人工核实后点既有「标记已发布」 | 用户确认；与抖音通路同一条不变式 |
| **文章内核** | **与公众号特性共用一套**（AI 成文 + 结构化草稿 + 包内 `article.html`），按平台出不同渲染与封面比例 | 用户确认；避免两份成文逻辑漂移 |
| 平台建模 | `PublishPlatform` 新增 `"toutiao"` | 复用包/任务/审计/预览/垃圾桶 |
| 包内容类型 | **复用 `"article"`**（不新增第四种） | `createArticlePackageAssets` 已存在且有 8 个用例 |
| 正文配图 | **v1 不做** | 参考实现也不做；我们的场景静帧是 9:16 竖图，正文里的观感差；正文图要往编辑器插图，是本功能最大的不确定项 |
| 封面 | **必填**；服务端用 ffmpeg 裁成 **16:9（1280×720）** | 头条要求；静帧是 9:16，直接传会被系统乱裁 |
| 登录 | **应用内扫码**：后端取二维码 data URL → 前端展示 → 轮询登录状态；会话持久化到 `storage/toutiao/profile/` | §1.3 实测二维码可取 |
| **同时发布微头条** | **默认关闭**，且必须**校验关闭成功**；校验不通过则**不发布**（fail closed） | 参考实现默认让它保持勾选（= 用户不知情多发一条内容）；静默副作用不可接受 |
| 头条首发 / 作品声明 | 作为**文章包的可选项**存进包记录并**参与 `previewRevision`** | 它们改变「要发出去的内容」，不进指纹会让预览形同虚设 |
| 合集 | **v1 不做** | 依赖账号侧已存在的合集名，多一个必然的失败模式 |
| 失败重试 | 不自动重试（人工再次点击） | 与抖音通路一致 |
| 发布前预览 | 沿用服务端硬约束 `previewRevision`（缺失 400 / 不一致 409，不产生记录） | 既有不变式 |
| 分派方式 | `auto-publish` 按 **(平台 × 内容类型)** 分派，不再硬判 `contentType !== "note"` | 公众号恢复时按同一形状接上即可 |
| 新增依赖 | **零**（`playwright` 已是直接依赖；不引 `marked`，我们直接渲染 HTML） | 项目既有口径 |

---

## 3. 内容来源与成文链路（共用内核）

输入是任务既有产物（`GET /api/jobs/:id/cleaned`）：`title`、`summary`、`keyPoints[]`、`cleanScript`、`voiceoverScript`、`videoOutline[]`、`qualityNotes[]`、`tags[]`，以及结构化转录 `segments`。

### 3.1 抽出平台中立内核：`src/lib/article-draft.ts`（新增）

公众号 Task 3 已经写好了一份完整的「AI 成文 + 兜底」，但它把**限额与提示词**硬编码成了公众号口径。本次把**平台中立的部分**抽出来：

```ts
export interface ArticleSection { heading?: string; paragraphs: string[] }
export interface ArticleDraft { title: string; digest?: string; author?: string; sections: ArticleSection[]; tags?: string[] }
export interface ArticleSourceContext { /* 与既有 WechatArticleSourceContext 同形 */ }
export interface ArticleLimits { titleMin: number; titleMax: number; digestMax?: number; authorMax?: number; bodyChars: number }
export interface ArticleProfile {
  /** 用于提示词与错误文案的平台名，如「今日头条」。 */
  label: string;
  limits: ArticleLimits;
  /** 提示词里的角色行与体裁说明（按平台各写一份，限额数字由 limits 生成，不许另写）。 */
  roleLine: string;
  guidance: string[];
}
export async function planArticle(context, deps, profile): Promise<ArticlePlan>
export function validateArticleDraftAgainstProfile(draft, profile): ArticleValidationError[]
export function compressToLimit(value: string, limit: number): string
```

**`src/lib/wechat-article.ts` 变为薄封装**：`WechatArticleDraft`/`WechatArticleSection` 保留为类型别名，`planWechatArticle(ctx, deps) = planArticle(ctx, deps, WECHAT_PROFILE)`，`validateArticleDraft`/`compressToLimit` 原样再导出。**既有 44 个用例是逐字回归门禁 —— 行为必须完全不变，包括提示词里出现的 32/120/20000 三个数字。**

### 3.2 抽出平台中立渲染器：`src/lib/article-html.ts`（新增）

同一份「标签白名单 → 去属性 → 列表改写 → 注入内联样式 → 断言行长」的逻辑，wechat 需要 mmbiz 图片白名单与 `{{wechat-image-N}}` 占位符，头条不需要。抽出为：

```ts
export interface ArticleHtmlProfile {
  /** 段落/标题/列表/引用各自的内联样式。 */
  styles: Record<"root" | "section" | "heading" | "paragraph" | "listItem" | "quote" | "image" | "hr", string>;
  /** 外链策略：公众号保留 mp.weixin.qq.com、拆掉站外；头条**保留全部**（正文里的链接不构成风险）。 */
  anchorPolicy: (href: string) => "keep" | "unwrap";
  /** 图片 src 白名单；头条 v1 无正文图，传 `() => false`。 */
  allowImageSrc: (src: string) => boolean;
}
export function sanitizeArticleHtml(html: string, profile: ArticleHtmlProfile, allowBlocks?: boolean): string
export function renderArticleHtml(draft: ArticleDraft, profile: ArticleHtmlProfile, options?: { images?: ArticleImage[] }): string
```

**渲染类改动的纪律（沿用既有教训）：纯函数用例全绿 ≠ 产物读得通。Task 2 结束时必须把一份真实样例 render 出来打出来看一眼**（`<img>` 属性、`<li>` 边界、`<p>甲</p><p>乙</p>` 这三条都是上一轮被肉眼复核抓出来的）。

### 3.3 头条档案与渲染：`src/lib/toutiao-article.ts`（新增）

```ts
/** 头条的硬限额与自定守卫。**唯一真源**，服务端 / 预览接口 / 渲染层都从这里取。 */
export const TOUTIAO_ARTICLE_LIMITS = {
  /** 平台硬限制：标题 2~30 字（超 30 由平台截断，我们主动压并标注「已压缩」）。 */
  titleMin: 2,
  titleMax: 30,
  /** 我们自己的正文守卫（平台未公布字数上限）：防止一次粘进一坨异常长的内容。 */
  bodyChars: 20_000,
  /** 封面：16:9、JPEG，≥400×200（平台建议）。 */
  coverWidth: 1280,
  coverHeight: 720,
  coverBytes: 10 * 1024 * 1024,
} as const;

export function planToutiaoArticle(context: ArticleSourceContext, deps: ArticlePlanDeps): Promise<ArticlePlan>
export function validateToutiaoArticle(draft: ArticleDraft): ArticleValidationError[]   // 含 **标题 ≥2 字**
export function renderToutiaoArticleHtml(draft: ArticleDraft): string
/** 预览与「下载文章 HTML」用：把渲染结果摊成纯文本（正文段前 N 段）。 */
export function articleDraftToBodyText(draft: ArticleDraft): string
```

要点：

- **标题下限 2 字是本平台独有的校验**（既有公众号校验只判非空与上限）；兜底标题也必须过这一关（兜底链：任务标题 → 首个要点 → 大纲首项 → 「未命名文章」，全部 ≥2 字）。
- 提示词里的 2/30/20000 三个数字**由 `TOUTIAO_ARTICLE_LIMITS` 生成**，并有用例断言提示词里出现这些数字（防止提示词里另写一份而悄悄漂移）。
- 正文段落**按 `sections` 渲染成 `<h2>` + `<p>`**（与公众号同一套结构，样式另给）。
- `planToutiaoArticle` 的失败一律走兜底并带 `copySource: "fallback"` + 可读 `warning`，**绝不静默产出一份看起来正常、其实是原始口播稿的东西**。

### 3.4a 创建阶段的指纹**不绑定 AI 草稿**（否则「可编辑」＝「必然 409」）

`PublishingPreview.previewRevision`（文章通路）**只覆盖源内容 + 封面选择**，刻意不把 AI 草稿的
标题/正文算进去。原因（2026-09-18 代码评审实测确认）：草稿是**服务端**生成的，而创建时正文来自
**用户编辑过的文本** —— 一旦把草稿算进创建指纹，「界面允许编辑」就必然变成「一编辑就 409」，
报错还会说「源内容自预览后发生变化」，把用户自己的输入说成源变了。

真正防「预览之后内容被改」的是**包级**指纹 `packagePreviewRevision`（§6.3）：它覆盖
`articleCopy.title` + `articleCopy.htmlSha256`（渲染产物哈希）+ 封面 + 三个头条选项，
提交时缺/不一致一律 400/409。少绑一层不削弱那道闸门。

### 3.4b ⚠️ 已知限制：包级指纹绑定的是封面**存在性与文件名**，不是它的字节

文章包封面固定叫 `cover.jpg`，因此「换掉包内封面文件的字节」不会让 `previewRevision` 失效。
先接受的理由：包目录由打包层在文件锁内写入，威胁模型与「改写 `article.html`」同级，而后者已被
`articleCopy.htmlSha256` 覆盖。彻底收紧需要在包记录里加 `coverSha256`（打包时计算、指纹里比对），
会牵动存档校验与既有精确哈希 baseline。

### 3.4 ⚠️ 已接受的一条限制：文章包仍要求「已生成视频」

真机验证（2026-09-18，隔离实例 + curl）发现：文章预览走的仍是共用取数入口 `readSourceContext()`，
而它要求任务有**已渲染的成片**（`hyperframesVideo`），否则报 `publish_video_missing`。

- **为什么先接受**：发布中心其余通路（视频包/图文包）本来就要求成片，界面入口也统一按
  `isPublishingEligibleVideo` 把关，行为一致；改动 `readSourceContext` 会牵动
  `sourceContextHash`（各通路 `previewRevision` 的公共部分），风险不划算。
- **代价**：只想发文章、还没生成视频的任务，目前建不了文章包。
- **将来要改的话**（留准确的做法，避免重新推理）：给文章通路单独一条不依赖视频的取数
  （cleaned 产物 + 任务标题）与配套的 `sourceContextHash` 变体（只用 cleaned 的 mtime 与
  jobId），**不要**去改共用那条 —— 否则视频/图文两条既有通路的 `previewRevision` 会一起变，
  既有精确哈希 baseline 用例会立刻失败（那正是它的作用）。

### 3.5 封面：`src/lib/toutiao-media.ts`（新增）

```ts
export interface ToutiaoCoverResult { path: string; bytes: number; width: number; height: number }
export class ToutiaoMediaService {
  constructor(config: { ffmpegBinary?: string; commandRunner?: ToutiaoMediaCommandRunner; timeoutMs?: number })
  /** 等比放大到覆盖 1280×720 再居中裁切（不依赖平台随机裁）。源图只读。 */
  prepareCoverImage(srcPath: string, outDir: string): Promise<ToutiaoCoverResult>
}
```

- 走**项目已有的 `runCommand` + ffmpeg**，不引 sharp/jimp（与 `wechat-media.ts` 同一口径）。滤镜与 wechat 的封面同形，只换尺寸：`scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720`。
- 源图上限沿用 20MB 口径；**源文件只读**（前后 sha256 必须一致，有用例）。
- 失败或超限时**删掉产物再抛错**，绝不留半成品（同 `wechat-media` 的纪律）。
- **为什么另写一份而不是改 `wechat-media.ts`**：`wechat-media.ts` 是暂停中的公众号特性的已测模块，其错误码（`wechat_media_*`）与文案被 14 个用例逐字断言；为头条改它的错误码契约，风险大于收益。两者的 ffmpeg 管线只有约 80 行，且各自有自己的平台常量（2.35:1 vs 16:9）。**这条取舍写在这里，供复核时反驳。**

---

## 4. 执行器

### 4.1 `src/lib/toutiao-browser.ts`（新增）—— 浏览器从哪来 + 持久化会话目录

```ts
export type ToutiaoBrowserTarget =
  | { kind: "executablePath"; path: string }
  | { kind: "playwright" }              // 交给 Playwright 自己的缓存
  | { kind: "channel"; channel: "chrome" };

/** 分层解析，返回第一个可用的目标；全都不行时返回 null（由 runner 抛可执行指引）。 */
export function resolveToutiaoBrowserTarget(config: { browserBinary?: string }): ToutiaoBrowserTarget | null;

/** 持久化会话目录：`<storageRoot>/toutiao/profile`（容器约束：必须落在 storage 内）。 */
export function resolveToutiaoProfileDir(storageRoot: string, override?: string): string;

export async function launchToutiaoContext(options): Promise<{ context: BrowserContext; page: Page }>;
```

解析顺序（**每一层都有用例**）：

1. 显式配置 `browserBinary`（env `TOUTIAO_BROWSER_BINARY`，Electron 侧由 `binaryPaths` 注入）；
2. Electron 打包后经 `binaryPaths` 注入的浏览器（复用既有 `hyperframesBrowser` 这一份资源，**不新增打包项**）；
3. 开发态：`<repo>/vendor/package-assets/browser/chrome-headless-shell/*/chrome-headless-shell-<platform>-<arch>/chrome-headless-shell`（`vendor/package-assets/` 是 `npm run prepare:package:*` 的产物）；
4. Playwright 自身缓存（`{ kind: "playwright" }`，即不传 `executablePath`）；
5. 系统 Chrome（`{ kind: "channel", channel: "chrome" }`）。

全部失败时的报错必须**可执行**（列出两条命令，与 `SAU_INSTALL_GUIDANCE` 同一口径）：
```
未找到可用于头条发布的浏览器。二选一：
① 运行 npm run prepare:package:mac（产出打包用的 chrome-headless-shell，约 196MB）；
② 运行 npx playwright install chromium（下载 Playwright 自己的 chromium，约 330MB）。
也可以用 TOUTIAO_BROWSER_BINARY 直接指定一个 Chromium 系可执行文件，然后重启后端。
```

会话目录**必须在 storage 内**（与 `video-output.ts` 的「根目录约束」同一纪律）；跨目录的 `profileDir` 覆盖一律拒绝。

### 4.2 `src/lib/toutiao-page.ts`（新增）—— 页面步骤与选择器（单文件，唯一真源）

所有选择器与步骤集中在这里，页面对象通过窄接口注入（便于用假页面单测 + 用**本地 fixture 页**跑真 Playwright 用例）：

```ts
export interface ToutiaoPageLike { /* 只声明用到的那几个 Playwright 方法 */ }
export const TOUTIAO_SELECTORS = { /* 标题框 / 编辑器 / 封面入口 / 本地上传 / 确定 / 发布 / 确认发布 / 首发 / 声明 / 微头条勾选框 */ };
export function isLoginUrl(url: string): boolean;                       // 含 "/auth/page/login" 或 "sso.toutiao.com"
export async function readQrCodeDataUrl(page): Promise<string | null>;
export async function fillTitle(page, title: string): Promise<void>;
export async function fillBodyHtml(page, html: string, plainText: string): Promise<"rich" | "plain">;
export async function uploadCover(page, coverPath: string): Promise<void>;      // 失败必须抛错
export async function setFirstPublish(page, enabled: boolean): Promise<void>;
export async function setDeclarations(page, declarations: string[]): Promise<void>;
export async function ensureWeitoutiaoUnchecked(page): Promise<void>;          // 关不掉必须抛错
export async function submitAndConfirm(page): Promise<{ url: string; signal: string }>;
```

**三条硬纪律（参考实现的反面）**：

1. **每一步都要有落地证据**：标题填完读回 `value` 断言非空；`ensureWeitoutiaoUnchecked` 读回勾选状态断言为未勾选；封面必须在 `filechooser` 事件真的收到文件且上传区出现图片之后才返回。**任何一步失败都抛错并中止 —— 绝不吞掉异常继续点发布。**
2. **粘贴优先、输入兜底**：先用 `ClipboardEvent('paste')` 试富文本；页面侧读回编辑器纯文本，若为空则退回「按段落逐段 `keyboard.type`」（返回 `"plain"` 让上层如实记录）。**两条路都必须有读回校验。**
3. **发布后独立校验**：`submitAndConfirm` 点「预览并发布」→「确认发布」后，按 Task 1 侦察确定的判据（提示文案 / 跳转 URL / 作品列表出现标题）返回 `signal`；**拿不到任何判据时不报成功**，返回 `signal: "unconfirmed"` 交给上层如实记录。

### 4.3 `src/lib/toutiao-runner.ts`（新增）—— 会话、登录与发布编排

```ts
export type ToutiaoRunnerErrorCode =
  | "toutiao_browser_unavailable" | "toutiao_profile_dir_unsafe"
  | "toutiao_login_in_progress"  | "toutiao_not_logged_in"
  | "toutiao_qr_unavailable"     | "toutiao_publish_failed"
  | "toutiao_weitoutiao_unchecked_failed" | "toutiao_cover_required";

export class ToutiaoRunnerError extends Error { readonly status = 422; constructor(readonly code, message) }

export interface ToutiaoLoginState { loggedIn: boolean; url: string; username?: string }
export interface ToutiaoPublishInput {
  title: string; articleHtml: string; articleText: string; coverPath: string;
  firstPublish: boolean; declarations: string[]; crossPostWeitoutiao: boolean;
}
export interface ToutiaoPublishResult {
  ok: boolean;
  /** 失败时给用户看的可执行原因（已截断、已脱敏）。 */
  message: string;
  /** 发布页最终 URL。 */
  url?: string;
  /** 独立校验的结论：`confirmed` = 拿到判据；`unconfirmed` = 点了发布但没拿到判据。 */
  verification: "confirmed" | "unconfirmed";
  /** 富文本粘贴是否生效（`plain` 表示退化成了纯文本输入）。 */
  bodyMode: "rich" | "plain";
  steps: string[];                       // 逐步记录，进 autoPublish.message
}

export class ToutiaoRunner {
  constructor(config: ToutiaoRunnerConfig);
  assertConfigured(): void;                                  // 浏览器解析失败即抛（在任何记录写入之前）
  async checkLogin(): Promise<ToutiaoLoginState>;            // 零副作用：只开首页判 URL + 取昵称
  async startLogin(): Promise<{ qrDataUrl: string; startedAt: string; expiresAt: string }>;
  async pollLogin(): Promise<{ status: "waiting" | "scanned" | "logged_in" | "expired"; username?: string }>;
  async cancelLogin(): Promise<void>;
  async publishArticle(input: ToutiaoPublishInput): Promise<ToutiaoPublishResult>;
}
```

**会话生命周期（必须有用例，本项目吃过「9 个孤儿无头浏览器」的亏）**：

- **同一时刻只允许一个登录会话**（重复 `startLogin` → 409 `toutiao_login_in_progress`）。
- 轮询超过 **10 分钟**无活动 → 自动关浏览器并置 `expired`（头条二维码本身约 50 秒刷新一次，所以过期后**重新 `startLogin`** 即可，不做页面内刷新）。
- `cancelLogin()`、`process.on("exit"|"SIGINT"|"SIGTERM")` 都尝试 `context.close()`（best-effort，不阻塞退出）。
- 发布通路**不复用**登录会话的页面：`publishArticle` 自建 context，`finally` 里必然关闭。

---

## 5. 登录、会话与自检（界面契约）

| 接口 | 行为 |
| --- | --- |
| `POST /api/publishing/toutiao/login` | 启动登录会话，返回 `{ qrDataUrl, expiresAt }`；已有会话 → 409 |
| `GET /api/publishing/toutiao/login` | 轮询：`{ status: "idle" \| "waiting" \| "logged_in" \| "expired" \| "failed", username? }` |
| `DELETE /api/publishing/toutiao/login` | 取消并关闭浏览器 |
| `POST /api/publishing/toutiao/verify` | **零副作用自检**：开首页判登录态 + 取昵称，返回 `{ loggedIn, username?, message }`（不解锁发布、不填任何表单） |

- **凭据就是浏览器会话**：没有 AppID/Secret，也没有可供手工粘贴的 Cookie 格式（头条是 `storage_state` + IndexedDB 的复合指纹）。所以**扫码是唯一入口**，会话落在 `storage/toutiao/profile/`。
- 三种失败文案必须彼此可区分（本项目吃过「所有错误都退化成一句兜底文案」的亏）：**没装浏览器**（给两条命令）/ **装了解析不到**（给 `TOUTIAO_BROWSER_BINARY`）/ **登录态失效**（引导重新扫码，并提示「重新扫码不需要重启应用」）。
- 日志与审计**不出现**任何 cookie/session 值（沿用公众号通路的脱敏口径）。

---

## 6. 平台接入与包模型

### 6.1 平台清单：新增一个平台要动 **7 处**（实测逐处读过源码）

| # | 位置 | 兜底情况 |
| --- | --- | --- |
| ① | `src/types.ts:24` `PublishPlatform` | —— 源头 |
| ② | `src/lib/publishing-platforms.ts:22` `PUBLISH_PLATFORMS: Record<PublishPlatform, …>` | ✅ **编译器兜住**（漏键必编译失败） |
| ③ | `src/lib/publishing-assets.ts:42` `APPROVED_PLATFORMS` | ❌ **静默**（守卫用例断言） |
| ④ | `src/lib/publishing-routes.ts:29` `PLATFORMS` | ❌ **静默**（守卫用例断言） |
| ⑤ | `src/lib/publishing-store.ts:1245` `isPlatform()` | ❌ **静默，且后果最严重**：读回索引时该平台的任务被悄悄丢掉 |
| ⑥ | `renderer/src/types/index.ts:28` 渲染层联合类型 | ❌ 独立 TS 工程，编译器兜不住 |
| ⑦ | `src/lib/publishing-routes.ts:330-334` `contentType()` 白名单 | ❌ **当前明确拒绝 `"article"`**，不加则文章包根本建不出来 |

`SUPPORTED_PLATFORMS`（service）与 `publishing-copy.ts` 的清单是**派生**的，无需改（**不许改成字面量**）。

```ts
toutiao: {
  label: "今日头条",
  titleMax: 30,          // 头条文章标题硬限制（2~30）；下限由 TOUTIAO_ARTICLE_LIMITS.titleMin 管
  descriptionMax: 20_000, // 头条语境里 description = 正文文本；数字来自 TOUTIAO_ARTICLE_LIMITS.bodyChars
  hashtagMax: 10,        // 文章编辑器没有话题字段 → 与公众号同一口径：保留但不提交
  hashtagLengthMax: 20,
  creatorUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
}
```

`validateCopyAgainstPolicy` 目前**是模块私有**，头条要按自己的口径校验包级文案 → **导出它**（只是加一个 `export`，成本为零），并由 `validateToutiaoArticle` 复用。

### 6.2 包模型：复用 `article` + 两个新字段

`createArticlePackageAssets` 已存在且有 8 个用例，**包目录形状正好可用**：`article.html` + `cover.jpg` + `images/` + `platforms/` + `manifest.json`。本次只补两件事：

```ts
/** 与公众号共用同一形状（标题 + 可选摘要/作者 + 正文 HTML 的 sha256）。 */
export interface ArticleCopy { title: string; digest?: string; author?: string; htmlSha256: string }
/** 公众号旧名保留为别名，避免改动已完成的那一层。 */
export type WechatArticleCopy = ArticleCopy;

export interface DeliveryPackage {
  // …既有字段…
  /** 仅文章包：头条侧的发布选项。**参与 `previewRevision`**（它们改变要发出去的内容）。 */
  toutiaoOptions?: {
    firstPublish: boolean;
    declarations: string[];
    crossPostWeitoutiao: boolean;
  };
}
```

- `articleCopy` 落库的**编排**目前不存在（打包层只返回 `htmlSha256`，入参收 `title/digest/author`）——本次在 service 侧拼好写入包记录（公众号恢复时同一处可复用）。
- article 包的 `video*` 字段按 note 包既有口径承载**等价凭据**：`videoSha256 = imageManifestSha256`、`videoSize = imageSize`、`videoMethod = "copy"`。**不要**把 `htmlSha256` 塞进 `videoSha256` —— 那会让既有 `verifyPackageImages`（比对图片清单哈希）对 article 包判定为 `missing_images`，而 v1 的 article 包本来就可能一张图都没有。
- `DELIVERY` 健康值：article 包的 `assetHealth` 由打包层按「有没有封面」给（`healthy` / `missing_cover`）。**头条封面必填，所以缺封面时界面与接口都要拒绝发布**（与 wechat 通路一致）。

### 6.3 内容指纹：`packagePreviewRevision` 缺 article 分支（**必须补**）

实测现状（`publishing-store.ts:1026`）是 **if note / else** 二分支，**`article` 落进 else**，只哈希 `videoSha256` + `videoSize` —— 也就是说 **`article.html` 与封面被改了，指纹不变，「预览后内容被改」拦不住**。这正是「必经预览」这条不变式的漏洞。本次新增分支：

```ts
if (contentType === "note") { …既有，一字不改… }
else if (contentType === "article") {
  hash.update(`articleTitle:${articleCopy?.title ?? ""}\0`);
  hash.update(`articleHtml:${articleCopy?.htmlSha256 ?? ""}\0`);
  for (const imagePath of packageRecord.imagePaths ?? []) hash.update(`image:${imagePath}\0`);
  hash.update(`cover:${coverPath ? path.basename(coverPath) : ""}\0`);
  hash.update(`firstPublish:${options.firstPublish ? 1 : 0}\0`);
  hash.update(`declarations:${[...options.declarations].sort().join(",")}\0`);
  hash.update(`weitoutiao:${options.crossPostWeitoutiao ? 1 : 0}\0`);
} else { …既有 video 分支，一字不改… }
```

**`video` 与 `note` 两个分支逐字不变**，因此既有那条「精确哈希 baseline」用例（`publishing-service.test.ts`）保持字节一致 —— 它是本次重构的回归门禁。

### 6.4 两处硬闸：从「只认 note」改成「(平台 × 内容类型) 路由表」

实测两道闸都硬判 `(contentType ?? "video") !== "note"` → `publish_not_a_note_package`：
`publishing-store.ts:399`（写记录前）与 `publishing-service.ts:836`（编排前）。

新增唯一真源（放在 `publishing-platforms.ts`，与平台表同处）：

```ts
/** 允许自动发布的 (内容类型, 平台) 组合 → 执行通路。 */
export const AUTO_PUBLISH_ROUTES: ReadonlyArray<{ contentType: PackageContentType; platform: PublishPlatform; engine: "sau" | "toutiao" }> = [
  { contentType: "note",    platform: "douyin",  engine: "sau" },
  { contentType: "article", platform: "toutiao", engine: "toutiao" },
];
export function resolveAutoPublishEngine(contentType, platform): "sau" | "toutiao" | null;
```

- **不在表里的组合仍然报错，但错误码要说清是哪一种不支持**：视频包保持既有 `publish_not_a_note_package`（既有用例逐字断言它），其它组合给新的 `publish_auto_publish_unsupported` 并带上 `{ contentType, platform }`。
- **「先判输入类别、再判配置」这条错序纪律必须保住**（抖音 Task 4 被测试抓到过一次）：**未配置 toutiao 浏览器时，对 note 包调用仍应得到该通路原本的错误**，而不是「未找到浏览器」。有用例。

### 6.5 服务层的 5 个 `contentType` 分派点

实测有 5 处 `if note / else`，`article` 会**静默落到视频分支**：`preview():311`、`create():358`、`packagePreview():771`、`readPackageImage():808`、`autoPublish():836`。逐处处理：

| 位置 | 处理 |
| --- | --- |
| `preview()` | 新增 `contentType === "article"` → `previewArticlePackage()`（AI 成文 + 封面候选 + 限额 + `previewRevision`） |
| `create()` | 新增 → `createArticle()`（校验 + revision 比对）→ `createToutiaoArticlePackage()`（打包 + 落库） |
| `packagePreview()` | 新增 article 分支：标题、**正文纯文本**（从包内 `article.html` 提取，供弹窗渲染）、封面可用性、头条选项、`copyChecks` |
| `readPackageImage()` | 保持只服务图文包（v1 article 无正文图）；**封面走既有 `/cover` 路由**（`readPackageCover` 对任何有封面的包都可用） |
| `autoPublish()` | 按 §6.4 的路由表分派；`autoPublishToutiaoArticle()` 编排：读包内 `article.html` → **校验 sha256 与 `articleCopy.htmlSha256` 一致** → 读封面 → `runner.publishArticle()` → 写 `autoPublish` |

**编排一律留在 `PublishingService`，路由保持「校验 + 转调」的薄层**（本项目既有架构不变式，抖音 Task 4 已确立）。

### 6.6 新增/复用接口

| 接口 | 说明 |
| --- | --- |
| `POST /api/jobs/:id/publishing/preview`（**既有，扩展**） | `contentType: "article"`（+ 封面选择走 `imageSource`/`imageAssetIds`）→ 文章预览 |
| `POST /api/publishing/packages`（**既有，扩展**） | `contentType: "article"` + `articleCopy: { title, body }` + 封面选择（复用 `imageSource`/`imageAssetIds`，文章语境下恰好一张）+ `toutiaoOptions` → 建文章包 |
| `POST /api/publishing/tasks/:id/auto-publish`（**既有，复用**） | 仍是唯一提交入口，按 (平台 × 内容类型) 分派；**仍必须带 `previewRevision`** |
| `GET /api/publishing/packages/:id/article`（**新增，降级通路**） | 取包内 `article.html`（authenticated）。它让「不能自动发布」时功能仍有价值：用户可以把 HTML 复制进头条编辑器，或点「下载文章 HTML」 |
| `POST/GET/DELETE /api/publishing/toutiao/login`、`POST /api/publishing/toutiao/verify`（**新增**） | §5 |

**不新增提交路由**，与公众号 spec §14 同一决定。

---

## 7. 状态表达与不变式

**不新增 `PublishTaskStatus`。** 复用 `PublishTask.autoPublish`：

- article 通路**不使用 `awaiting_code`**（头条没有短信验证码投喂通路）→ 类型不变，只是这条通路只会出现 `running`/`succeeded`/`failed`。
- **四条不变式（各有用例）**：
  1. **`task.status` 全程不变**：机器动作只写子记录，任务仍停在 `ready`，直到人工点既有「标记已发布」。**这是本功能最关键的一条。**
  2. **`succeeded` 的语义是「已提交」**，不是「已发布」；`verification: "unconfirmed"` 时 message 必须写明「已点击发布，但未能在作品列表确认，请到头条后台核实」。
  3. **失败不自动重试**，必须人工再次点击（重试前必须先确认上一次是否已发出 —— 重复发布是本功能最大的风险，与抖音图文同一判断）。
  4. **同一任务同时只允许一个 `autoPublish` 在跑**（运行中 409），并沿用既有 **30 分钟僵死阈值**（`publishing-store.ts:32`），否则被杀死的进程会让按钮永久灰掉。

**与抖音通路的差异（有意为之）**：抖音靠「短信验证码 + 用户已确认未发出」兜重复发布；头条没有验证码通路，所以**我们把「结果校验」当成主要补偿手段**（`verification` 字段 + 明确文案），并在界面上把「重复发布风险」直接写进提示。

---

## 8. 界面与入口

| 入口 | 行为 |
| --- | --- |
| 设置页新增「今日头条」区（`settingsSections` 加一项） | **应用内扫码登录**：显示二维码（`<img src={qrDataUrl}>`）、状态轮询、取消按钮、「校验登录」按钮（调 `/verify`）。文案必须说明「扫码用的是应用内置浏览器，不会弹出窗口」 |
| 作品详情页成果画布「创建头条文章包」 | 独立向导（组件 `CreateToutiaoArticleDialog`，与视频/图文向导互不干扰）：封面（静帧/素材库，**单选**）+ AI 成文结果（标题可编辑、正文可编辑）+ 头条选项（首发 / 作品声明 / 同步微头条，默认全关） |
| 发布中心任务行「预览」 | 复用 `PublishPreviewDialog`，新增 `article` 分支：封面缩略图（blob，带会话取）+ 标题字数 + **正文纯文本** + 头条选项 + 缺封面/正文异常的显眼提示 |
| 发布中心任务行「提交到头条号」 | 先弹预览（**必经**）→ 确认后带 `previewRevision` 提交 |
| 发布中心任务行「下载文章 HTML」 | 任何时候可用、零依赖（降级通路，见 §6.6） |
| 发布中心任务行「已提交…」提示 | `succeeded` → 「已提交到头条号，请到头条后台核实后点『标记已发布』」；`unconfirmed` → 追加「未能自动确认，请务必先核实再重试」 |

- 动作可见性一律**返回原因**而不是纯布尔（`getPublishingAutoPublishBlocker` 既有形状）：本项目在侧栏折叠上吃过「入口零变化导致用户找不到」的亏。
- **`edit-content` 对 article 任务不提供**：文章正文是**包级** `article.html` 的渲染结果，改任务文案会让「预览看到的」与「发出去的」漂移（正是 §6.3 要防的）。禁用原因写明「文章正文请重新创建文章包」。
- `missing_cover` 必须显眼：头条封面必填，缺封面时禁用提交并说明「请重新创建文章包并选择封面」。

---

## 9. 明确不做

- 头条**视频**、**微头条**（独立体裁）发布
- 数据分析、评论管理、创作灵感（参考项目里占 900+ 行的部分）
- **正文配图**（往编辑器插图）、**合集**、定时发布、多账号
- 外部 CLI（`@openclaw-cn/toutiao-ops`）与**任何新增 npm 依赖**
- 有头浏览器窗口（默认无头；仅在 Task 1 证明无头被风控时才启用 `channel:"chrome"` 兜底）
- 在预览弹窗里直接编辑文章正文（编辑走创建向导，避免第二套编辑状态）
- 账号密码/短信登录（只做扫码）

---

## 10. 测试与验证

| 类别 | 内容 |
| --- | --- |
| 文章内核（共享） | `article-draft` 的中立行为 + **既有 `wechat-article.test.ts` 44 个用例逐字通过**（本次重构的回归门禁，含提示词里出现 32/120/20000 的断言） |
| 头条成文 | 标题 2 字下限（1 字被拒、2 字通过）、31 字被压到 30 并标注、AI 六种坏输出（合法/超限/缺字段/空段落/坏 JSON/抛异常）**一律仍产出能通过校验并渲染成功的草稿**且带 `copySource:"fallback"`；提示词含由限额生成的数字 |
| 头条渲染 | 纯函数：`<style>/<script>/<svg>/on*` 被去掉、`class/id/data-*` 被去掉、`div→section`、列表改写、段落边界不粘连、渲染结果 <20000 字符且超限给出段号 |
| 封面 | **假 ffmpeg stub**：滤镜参数为 `scale=1280:720…crop=1280:720`、产物路径正确、失败时删产物、源文件前后 sha256 一致、空白 `ffmpegBinary` → 明确安装指引 |
| 浏览器解析 | 5 层解析顺序各一条用例 + 全都不可用时**可执行**的报错文案（含两条命令）；`profileDir` 越界被拒 |
| 页面步骤（**真实 Playwright + 本地 fixture 页**） | 用 Task 1 侦察快照做的**离线 fixture 复刻页**（`file://`，不联网）：标题填入并读回、富文本粘贴生效、封面经 `<input type=file>` 真的送达、微头条勾选框关掉并**读回校验**（构造「关不掉」的 fixture → 必须抛错且**不点发布**）、发布按钮点击顺序正确。**没有可用浏览器时跳过（`skip`）并在输出里说明**，与既有 `RUN_HYPERFRAMES_INTEGRATION` 同一惯例 |
| 执行器（假 automation，不启浏览器） | 登录态映射（302 → 未登录）、会话生命周期（单飞 409、TTL 过期、取消、退出清理）、发布结果映射、`verification: unconfirmed` 如实上报、错误分类与脱敏 |
| 路由与服务 | **(平台 × 内容类型) 分派**：article+toutiao 走头条且**不触碰 sau**；note+douyin 走 sau 且**不触碰头条**；**未配置头条浏览器时对 note 包仍返回该通路原本的错误**（分派顺序用例）；article 包缺 `previewRevision` → 400 且不产生记录；预览后改内容 → 409 且不产生记录；运行中重复触发 → 409 |
| 不变式 | 成功只写 `autoPublish.status = succeeded`，**`task.status` 仍为 `ready`**（最关键的一条）；`awaiting_code` 在头条通路不可达 |
| 指纹 | article 分支：改 `article.html`、改标题、改封面、改头条选项（含声明顺序无关、集合敏感）都会改变 `previewRevision`；**video/note 两分支的哈希逐字节不变** |
| 平台枚举 | §6.1 那 7 处各一条断言（`toutiao` 在清单里，且既有 5 个平台一个没少） |
| 存量兼容 | `contentType` 缺省仍为 `video`；既有 publishing 用例（store/assets/service/routes）**全部保持通过**，其中 `previewRevision` 的精确哈希断言**逐字节不变** |
| 渲染层 | 平台表守卫用例（`publishing.test.ts` 的 `deepEqual` 数组）更新；`article` 分支的禁用原因文案；预览弹窗 article 分支 `renderToStaticMarkup`；二维码登录区的静态渲染（**必须断言 `<img>` 存在且 `src` 是 data URL**，不能只断言元素数量 —— 本项目吃过「元素存在 ≠ 图上屏」的亏） |

**验证命令**：`npm run check`（双端）、`npm test`、`npm run build:backend`。
**基线（2026-09-18 实测）**：`npm test` **608 项 / 606 通过 / 1 跳过 / 1 既有失败**（`src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge`）。
**生效条件**：`src/` 改动要 `npm run build:backend` 并重启；`electron/` 改动要 `npm run build:electron`（**两套产物互不覆盖**，见 `AGENTS.md`）；渲染层走 HMR。

---

## 11. 风险

| 风险 | 说明与处理 |
| --- | --- |
| **🔴 真实发布页 DOM 未知** | §1.4 一号未知数。**处理**：Task 1 只读侦察落到选择器与 fixture；Task 4 的选择器**只能来自侦察证据**，不许照抄参考项目的启发式选择器 |
| **🔴 选择器与站点改版的维护成本** | 站点改版我们没有上游可等（参考项目也没人维护选择器）。**处理**：选择器集中在 `toutiao-page.ts` 一个文件、每步都有读回校验 → 坏了会**明确报错并停在发布前**（而不是像参考实现那样报成功）；**把「选择器过时」写进故障排查文档**，并把「先跑只读侦察脚本」作为排查第一步 |
| **🔴 重复发布（最大业务风险）** | 头条文章发出即公开。**处理**：不自动重试；失败后界面明确「重试前先去头条后台确认上一次是否已发出」；`verification` 字段如实上报；发布前必经预览 |
| **🟠 无头模式被风控** | 登录页能开不等于发布能过。**处理**：Task 1 一并验证；不行就用 `channel:"chrome"`（系统 Chrome），再不行才考虑有头窗口（并重新评估桌面端体验） |
| **🟠 富文本粘贴不生效** | §1.4 二号未知数。**处理**：退回逐段纯文本输入并在 `autoPublish.message` 里如实记录 `bodyMode: "plain"`（**不静默**） |
| **🟠 微头条被连带发布** | 平台默认勾选。**处理**：默认关闭 + 读回校验 + 关不掉就不发布（fail closed，见 §4.2） |
| **🟡 「未能确认发布结果」** | 没有接口回执。**处理**：`verification: "unconfirmed"` + 界面明确文案；绝不因此写 `published` |
| **🟡 共用内核的回归风险** | `wechat-article.ts` 是暂停中的公众号特性的已测模块。**处理**：抽出内核时**只移动、不改行为**；44 个既有用例是门禁；公众号恢复时的 Task 6 仍在原处，接上即可 |
| **🟡 指纹分支写错会静默放过** | §6.3。**处理**：article 分支专门用例（改正文/标题/封面/选项都变指纹），并且 video/note 的精确哈希 baseline 逐字节不变 |
| **🟢 本地无浏览器** | 开发机实测就没有（§1.3）。**处理**：解析链 5 层 + 可执行报错文案；不把它变成「功能不可用」而是「一条命令的事」 |

---

## 12. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/lib/article-draft.ts`（**新增**） | 平台中立内核：源上下文、草稿、限额/档案、AI 成文 + 兜底、校验、压缩 |
| `src/lib/article-html.ts`（**新增**） | 平台中立 sanitizer + 渲染器（样式/锚点策略/图片白名单由档案注入） |
| `src/lib/wechat-article.ts` | **改为薄封装**（委托到上面两个模块），既有导出名与行为逐字不变 |
| `src/lib/toutiao-article.ts`（**新增**） | `TOUTIAO_ARTICLE_LIMITS`、`planToutiaoArticle`、`validateToutiaoArticle`、`renderToutiaoArticleHtml`、`articleDraftToBodyText` |
| `src/lib/toutiao-media.ts`（**新增**） | 16:9 封面裁剪（ffmpeg，源图只读） |
| `src/lib/toutiao-browser.ts`（**新增**） | 浏览器 5 层解析、profile 目录约束、context 启动 |
| `src/lib/toutiao-page.ts`（**新增**） | 选择器与页面步骤（每步读回校验） |
| `src/lib/toutiao-runner.ts`（**新增**） | 登录会话生命周期、零副作用自检、发布编排与结果形状 |
| `src/types.ts` | `PublishPlatform` 加 `toutiao`；`ArticleCopy`（`WechatArticleCopy` 变别名）；`DeliveryPackage.toutiaoOptions`；`PublishingPreview` / `CreatePublishingPackageInput` 增 article 字段 |
| `src/lib/publishing-platforms.ts` | `PUBLISH_PLATFORMS.toutiao`；**导出** `validateCopyAgainstPolicy`；`AUTO_PUBLISH_ROUTES` + `resolveAutoPublishEngine` |
| `src/lib/publishing-assets.ts` | `APPROVED_PLATFORMS` 加 `toutiao`；article 打包接线（`articleCopy`/封面来源为素材库时的 `resolveFile` 归属校验沿用既有真源） |
| `src/lib/publishing-store.ts` | `isPlatform` 加分支；`packagePreviewRevision` 加 article 分支；`beginAutoPublish` 的硬闸改成路由表 |
| `src/lib/publishing-service.ts` | 5 个分派点补 article；`previewArticlePackage` / `createArticle` / `createToutiaoArticlePackage` / `autoPublishToutiaoArticle` / `verifyToutiaoLogin`；`Assets` Pick 加 `createArticlePackageAssets` |
| `src/lib/publishing-routes.ts` | `PLATFORMS` 加 `toutiao`；`contentType()` 接受 `article`；article 预览/创建的入参解析；4 个头条登录/自检路由；`GET /packages/:id/article` |
| `src/app.ts`、`src/server.ts`、`electron/server.ts` | `toutiaoBrowserBinary` / `toutiaoProfileDir` 配置注入与 env 透传（`TOUTIAO_*`，**两条入口都要改**；Electron 侧注意 `dist-electron/` 是另一套产物） |
| `renderer/src/types/index.ts` | 平台联合类型加 `toutiao`；`PackageContentType` 加 `'article'`；article 预览/创建载荷类型 |
| `renderer/src/utils/publishing.ts` | 平台表加行；`getPublishingAutoPublishBlocker` 支持 (平台 × 内容类型)；article 任务的 `edit-content` 收紧 |
| `renderer/src/utils/toutiaoArticle.ts`（**新增**） | 纯逻辑：标题字数/上限、封面选择阻塞原因、创建请求体组装（含「预览未完成就抛错」） |
| `renderer/src/components/CreateToutiaoArticleDialog.tsx`（**新增**） | 创建向导（封面单选 + 成文编辑 + 头条选项） |
| `renderer/src/components/PublishPreviewDialog.tsx` | 加 `article` 分支（封面 + 标题字数 + 正文纯文本 + 选项） |
| `renderer/src/components/ToutiaoLoginPanel.tsx`（**新增**） | 二维码展示 + 轮询 + 取消 + 校验登录 |
| `renderer/src/pages/SettingsPage.tsx` + `utils/settingsSections.ts` | 新增「今日头条」区 |
| `renderer/src/pages/PublishingPage.tsx` | 「提交到头条号」「下载文章 HTML」动作与提示文案 |
| `renderer/src/services/api.ts` | 4 个头条接口 + `getPublishingArticleHtml` |
| `scripts/probe-toutiao-publish-page.ts`（**新增**） | **只读侦察探针**：登录 → 进发布页 → 落 DOM 快照 + 选择器候选（不填表、不发布） |
| 测试 | 见 §10；`renderer/src/utils/publishing.test.ts` 的平台表守卫数组必须更新 |
| 文档 | `AGENTS.md`、`CLAUDE.md`、`README.md`（架构清单、新接口、`TOUTIAO_*` 配置、注意事项与故障排查）、`docs/research/toutiao-ops-assessment.md`（已写） |

---

## 13. Task 1：只读侦察（**可行性判据**，需要用户配合扫码一次）

**这是本设计的第一步，也是唯一需要人手参与的账号侧动作。**

```
cd <repo> && node --import tsx scripts/probe-toutiao-publish-page.ts
```

脚本行为（**全程零副作用**）：

1. 用 §4.1 的解析链启动无头浏览器，持久化 profile 落 `storage/toutiao/profile/`；
2. 进登录页取二维码 → **把二维码 PNG 落盘并在终端打印路径**（用户扫码）；
3. 轮询登录成功 → 记录昵称与 URL；
4. 进 `profile_v4/graphic/publish`，**只读取**：落盘完整 DOM 快照（`storage/toutiao/recon/publish-page.html`）、打印候选选择器命中数（标题框/编辑器/封面入口/本地上传/发布按钮/首发/声明/微头条勾选框各命中几个、各自的 `tagName` + `placeholder`/`textContent` 摘要）；
5. 探针富文本粘贴能力：在编辑器里派发一次 `ClipboardEvent` 并**读回纯文本**判断是否生效（随后 `page.goto` 离开，不保存）；
6. 打印「发布成功判据」的候选（页面上的成功提示选择器 / 可能的作品列表 URL）—— 只做读探测，**不点发布**；
7. 结束时关闭浏览器。

**四种结论都有对应路径**：全绿 → 按计划实现；**无头被风控** → 改用 `channel:"chrome"` 复测；**粘贴不生效** → 正文走纯文本输入（`bodyMode: "plain"`）；**发布页结构与参考项目差异大** → 以侦察结果为准重写选择器（计划里 Task 4 的选择器本来就要等这一步的产物）。

侦察产物同时是 **Task 4 fixture 用例的输入**（把真实 DOM 结构复刻成离线 fixture，让选择器有真实 Playwright 覆盖而不需要联网）。
