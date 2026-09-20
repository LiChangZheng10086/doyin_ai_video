# toutiao-ops 今日头条文章发布能力 调研评估

> 调研对象：https://github.com/mf-yang/toutiao-ops （npm: `@openclaw-cn/toutiao-ops`）
> 调研方式：`git clone --depth 1` 全仓逐文件核对 + npm 实装启动 + **真实站点只读探针**（打开登录页，不登录、不填表、不发布）
> 调研日期：2026-09-18
> 证据分级：**【事实】**= 直接读到的源码 / 命令输出 / 页面实际返回；**【推断】**= 基于事实的分析判断

---

## 0. 一句话结论

**难度：中（明显低于抖音图文那套）。**
它的「文章发布」本体只有约 **830 行 JS**，而**我们不需要装它**：实测我们**打包资源里已有的 chrome-headless-shell** 就能打开真实的 `mp.toutiao.com` 登录页，
而未登录时两个入口都稳定 302 到 `/auth/page/login`（登录态判定有干净契约）、**登录二维码可以直接从 DOM 取出来给用户扫**。
所以既不需要像 sau 那样花 970MB 装外部引擎，也不需要额外下 500MB 浏览器，更不需要有头浏览器窗口。

真正的风险不在编码，而在**一个硬未知数**：登录后的**真实发布页 DOM**（当前看不到），选择器必须靠一次只读侦察落地 ——
这正是 2026-09-17 sau 图文发布「标题选择器过时 → 稳定 120s 超时」那次事故的同一类风险。

---

## 1. 调研对象与规模

**【事实】** `git clone --depth 1 https://github.com/mf-yang/toutiao-ops.git`，HEAD：

```
de89bba5ec820d8709ca8feec0241423f3d2bede 2026-04-08 18:42:55 +0800
chore: 更新版本至 1.1.4，修改封面图片路径为必填项
```

**【事实】** 全仓文件与行数（`find … | xargs wc -l`，合计 **4089 行**）：

| 文件 | 行数 | 与本功能的关系 |
| --- | --- | --- |
| `cli/src/publish-article.js` | **295** | ⭐ 文章发布本体 |
| `cli/src/auth.js` | 293 | ⭐ 登录 / 账号 / 二维码截图 |
| `cli/src/browser.js` | 204 | ⭐ 浏览器启动、stealth、弹窗清理 |
| `cli/src/auth-guard.js` | 39 | ⭐ 登录态守卫 |
| `cli/index.js` | 224 | commander 命令入口 |
| `cli/src/publish-video.js` | 377 | 视频发布（**不做**） |
| `cli/src/publish-weitoutiao.js` | 179 | 微头条发布（**不做**，但文章发布默认会顺带勾上它） |
| `cli/src/analytics.js` / `comment-manage.js` / `content-manage.js` / `inspiration.js` / `update-check.js` | 335 / 333 / 76 / 137 / 108 | 数据、评论、灵感（**不做**） |
| `references/*.md`（10 个） | 约 1000 | 面向 Agent 的参数文档 |
| `SKILL.md` / `README.md` | 89 / 175 | Agent Skill 包装层 |

**【事实】** 定位是「AI Agent 技能包」（SKILL.md + references + cli），`cli/` 同时单独发 npm 包。技术方案自述：

| 操作 | 实现 |
| --- | --- |
| 内容发布 | Playwright 浏览器自动化（`playwright-extra` + `puppeteer-extra-plugin-stealth`） |
| 数据读取 | 浏览器内 `fetch()` / React Fiber 树提取 |
| 反检测 | stealth 插件 + **持久化上下文**（保留真实指纹）+ 随机延迟 + 逐字输入 |

---

## 2. 文章发布实现逐条核对（`cli/src/publish-article.js`）

**【事实】** 发布页 `https://mp.toutiao.com/profile_v4/graphic/publish`。流程与选择器：

| 步骤 | 选择器 / 做法 | 备注 |
| --- | --- | --- |
| 标题 | `textarea[placeholder*="标题"], input[placeholder*="标题"], [class*="title"] textarea, [class*="title"] input` | 先 `waitForSelector(15s)`；`page.click(force:true)` 后 `keyboard.type` **逐字**（随机 50–130ms） |
| 正文 | `[contenteditable="true"]` | markdown → `marked.parse` → 构造 `ClipboardEvent('paste')` 派发（`text/html`）实现**富文本粘贴**；`--format text` 时按 `\n` 分段逐段 `keyboard.type` |
| 封面 | 点 `[class*="cover"] [class*="add\|upload\|plus"]` → 侧边栏点「本地上传」→ `filechooser.setFiles` → 点 `.byte-drawer-wrapper button:has-text("确定")` | 封面模式 `single`/`triple`/`none`，默认 `single`，**`--cover` 是 requiredOption** |
| 头条首发 | `clickLabel('头条首发')` | 可选 |
| 合集 | `text=添加至合集` → 搜索框填名 → 选中 → 确定 | 可选 |
| 同时发微头条 | 勾选框**默认已勾选**，`--no-weitoutiao` 时点 `text=发布得更多收益` 取消 | ⚠️ 见 §3 |
| 作品声明 | `labelMap` 把 7 个短名映射成完整文案（如「个人观点」→「个人观点，仅供参考」）再点 `text=<完整文案>` | 可选 |
| 发布 | `button:has-text("预览并发布")` → 等 3–5s → `button:has-text("确认发布"), button:has-text("发布")` → 再兜一次 `确定/确认` | ⚠️ 见 §3 |
| 存草稿 | **什么都不点**，直接 `return {action:'draft_saved'}` | 源码注释：「页面底部没有独立草稿按钮，草稿已自动保存」 |

**【事实】** 硬约束（源码常量 + `references/publish-article.md`）：

- 标题 **`TITLE_MIN_LEN = 2` / `TITLE_MAX_LEN = 30`**；超过 30 时 `title.slice(0, 30)` 截断（**按 UTF-16 码元切**，emoji 有被切断的风险）。
- **封面必填**（`requiredOption('--cover')`，且 HEAD commit 就是「修改封面图片路径为必填项」）。
- 封面建议 **16:9、JPEG/PNG、不小于 400×200**。
- **正文不支持配图**：`publish-article.js` 全文件只处理封面，`marked` 只把 markdown 变 HTML；正文里没有插入图片的逻辑。
- 返回形状：`{success:true, action:"published"|"draft_saved", title, url}`。

---

## 3. 三个必须自己处理的问题（照抄会踩）

### 3.1 🔴 静默失败：封面上传失败也返回「发布成功」

**【事实】** 这些函数**全部**把异常吞掉后继续：

```js
async function setCoverMode(page, mode, coverPath) {
  try { /* 点单图 → 打开侧边栏 → 本地上传 → setFiles → 点确定 */ }
  catch { /* 关侧边栏、按 Escape */ }          // ← 不 rethrow、不记录
}
```

`addToCollection` / `uncheckWeitoutiao` / `clickLabel` / `setDeclarations` 同样是空 `catch`。
函数最后无条件：

```js
return { success: true, action: 'published', title, url: page.url() };
```

**【推断】** 头条**不允许无封面发布**，所以「封面失败 + 仍然点发布」的真实结局是**发布失败，但 CLI 报成功**。
这与本项目「绝不静默失败」（见 `docs/worklog.md` 2026-09-17「失败原因被截断丢掉」一条）直接冲突。

### 3.2 🟠 发布结果不做校验

**【事实】** 点击「确认发布」是 `.catch(() => {})`，返回的 `url` 只是 `page.url()`；
**没有任何一处**去作品列表确认这篇文章真的存在。`--draft` 分支更彻底：什么都不点就报 `draft_saved`。

### 3.3 🟠 依赖版本浮动，必然要自己再下一套浏览器

**【事实】** `cli/package.json`：

```json
"dependencies": { "commander": "^12.1.0", "marked": "^17.0.5", "playwright": "^1.50.0",
                  "playwright-extra": "^4.3.6", "puppeteer-extra-plugin-stealth": "^2.11.2" },
"postinstall": "npx playwright install chromium || true"
```

**【事实】** 实测（`/tmp/tt-cli-probe`）：

```
npm install --ignore-scripts @openclaw-cn/toutiao-ops   → added 47 packages in 3s，node_modules 21MB
node node_modules/@openclaw-cn/toutiao-ops/index.js --help  → 正常输出 Usage: toutiao [options] [command]
```

`playwright: ^1.50.0` 实际解析到 **1.63.0**，它要 `chromium_headless_shell-1243`；本机 `~/Library/Caches/ms-playwright/` 里只有
`chromium-1208` / `chromium_headless_shell-1208`（据 `.links/` 属于 `patchright`，即 sau 的）→ 因此 **CLI 必须自己再下约 500MB 浏览器**
（chromium 330M + headless shell 190M），这还没算它引入的 stealth 依赖链。

**【事实】** npm 元数据：`@openclaw-cn/toutiao-ops@1.1.4`，14 files，**unpackedSize 95,462 字节**，最后发布 **2026-05-19**，带 provenance 签名。

---

## 4. 我们这边的实测（决定架构的关键证据）

### 4.1 我们自己的 Playwright 目前**没有可用浏览器**

**【事实】**

```
node_modules/playwright = 1.62.1 → browsers.json 要求 chromium=1234 / chromium-headless-shell=1234
~/Library/Caches/ms-playwright/  = chromium-1208、chromium_headless_shell-1208（归 patchright/sau）
直接 chromium.launch({headless:true})
  → LAUNCH FAIL: Executable doesn't exist at …/chromium_headless_shell-1234/…
```

**【推断】** 也就是说「项目已经有 Playwright」这件事**不等于**「项目已经能驱动浏览器」；
抖音主页爬虫（`user-page-crawler.ts`）在本机同样是这个状态。**任何路线都必须先解决「浏览器从哪来」**。

### 4.2 但打包资源里已经有可用的浏览器，实测能打开真实头条登录页

**【事实】** `npm run prepare:package:mac` 产出的打包资源里已有 chrome-headless-shell（196MB，**`vendor/package-assets/` 被 `.gitignore` 忽略**，属构建机产物）：

```
vendor/package-assets/browser/chrome-headless-shell/mac_arm-152.0.7928.2/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

**【事实】** 用它做主程序的 Playwright 探针（只读）：

```
chromium.launch({ headless: true, executablePath: <上面的 shell> })
  → LAUNCH OK 152.0.7928.2
goto https://mp.toutiao.com/auth/page/login
  → title「头条号 - 你创作的，就是头条」；body text 2084 字；页面含「扫码登录 / 请使用今日头条App扫码登录」
```

**【推断】** Playwright 1.62.1 驱动 152.0.7928.2 的 headless shell 可用（走 CDP，版本偏斜不致命），
因此**「复用已打包浏览器 + 自研 runner」这条路技术上成立**，且**零额外下载**。

### 4.3 登录态有干净契约：未登录一律 302 到登录页

**【事实】** 未登录时：

| 访问 | 最终 URL |
| --- | --- |
| `https://mp.toutiao.com/` | `https://mp.toutiao.com/auth/page/login?redirect_url=JTJGcHJvZmlsZV92NCUyRg==` |
| `https://mp.toutiao.com/profile_v4/graphic/publish` | `https://mp.toutiao.com/auth/page/login?redirect_url=JTJGcHJvZmlsZV92NCUyRmdyYXBoaWMlMkZwdWJsaXNo` |

`redirect_url` 是目标路径的 base64。**【推断】** 登录态判定只需看 `location` 是否含 `/auth/page/login`，
与 toutiao-ops 的 `isOnLoginPage()` 同一判据，且比爬 DOM 稳。

### 4.4 二维码可以直接从 DOM 取（不需要截图、不需要有头窗口）

**【事实】** 登录页里那个 `img` 就是二维码本体，且是 `data:` URL：

```
img.src = "data:image/png;base64,iVBORw0KGgo…"   naturalWidth = 512  (512×512 PNG)
```

把 base64 落盘核对（`/tmp/tt-qr.png`，12,950 字节）—— **肉眼确认为真二维码**（黑底白色 + 中央「头条」红色 logo + 三个定位角）。
**【推断】** 因此「应用内扫码登录」可以做：后端把 data URL 交给前端展示，前端轮询登录状态即可；
toutiao-ops 的做法是截 `[class*="qrcode"]` 元素的图（`captureQrCode`），比我们这条还绕。

---

## 5. 与既有两条通路（sau / 公众号）的成本对比

| 维度 | 抖音图文（sau） | 公众号（官方 API） | **头条文章（本方案）** |
| --- | --- | --- | --- |
| 外部引擎 | 必须自装，**约 970MB**（仓库 440M + patchright chromium 520M），3 个已知坑 | 无 | **无**（复用已打包 chrome-headless-shell） |
| 额外浏览器下载 | 已含在上面 | 不适用 | **0**（打包资源里已有；dev 可用 `npx playwright install chromium` 补） |
| 登录方式 | 复用 `~/.douyin-ai-video/douyin-cookie.txt`（手工导入） | AppID/AppSecret + IP 白名单 | **应用内扫码**（二维码取自 DOM） |
| 自动化形态 | 外部 Python CLI 子进程 | 纯 HTTP | **自研 TS runner**（Playwright 已在依赖里） |
| 选择器归属 | 上游（我们已打 1 个补丁） | 官方接口，不涉及 | **我们自己**（成本：站点改版要跟） |
| 硬限额 | 标题 20 / 正文 1000 / 图 35 | 标题 32 / 正文 20000 / 封面 10MB | **标题 2–30 / 封面必填 / 正文无配图** |

**【推断】** 头条这条路线的「运维面」比 sau 小一个量级：没有 Python 3.12、没有补装 playwright、没有 970MB、
没有 cookie 格式互转；代价是**选择器与反爬由我们承担**。

---

## 6. 结论与风险清单

### 6.1 难度判定：中

- **可复用的**：文章成文（AI 洗稿 → 结构化草稿）、`article` 包模型与打包事务、封面处理（ffmpeg）、
  平台枚举/清单、发布中心的任务/审计/预览/垃圾桶、`previewRevision` 服务端硬约束 —— 全部已有。
- **新增的**：一个自研 runner（登录会话 + 表单填充 + 发布 + **结果校验**）、应用内扫码登录 UI、头条渲染与封面比例。
- **估算**：后端约 1200–1600 行 TS（含测试），渲染层约 400–600 行 —— 与抖音图文那套同量级，但**外部依赖成本为 0**。

### 6.2 硬未知数（必须在写选择器之前用一次只读侦察消灭）

| # | 未知数 | 处理 |
| --- | --- | --- |
| 🔴 1 | **登录后的真实发布页 DOM**（标题框/编辑器/封面入口/发布按钮/「同时发微头条」勾选框的真实选择器） | 一次性**只读侦察**：登录 → 进发布页 → 落盘 DOM 快照（**不填表、不点发布**），据此定选择器 |
| 🟠 2 | 头条富文本编辑器是否接受 `ClipboardEvent` 粘 HTML（参考实现声称可以，**我们尚未实测**） | 侦察阶段同时验证；不可用时退回「按段落逐段输入纯文本」 |
| 🟠 3 | 无头模式是否被风控（登录页能开 ≠ 发布能过） | 侦察阶段验证；备选：`channel:"chrome"`（用系统 Chrome，本机已装） |
| 🟠 4 | 发布成功的**可观测判据**（无接口回执） | 侦察阶段确定：成功提示文案 / 跳转后的 URL / 作品列表出现该标题，三者至少一个可断言 |
| 🟡 5 | 「同时发布微头条」默认**已勾选** | 我们必须把它**纳入填写结果校验**，否则会在用户不知情时多发一条微头条（见 spec 决策） |

### 6.3 【推断】参考实现可直接借鉴的部分

选择器**不要**照抄：它的选择器是「多候选 + 属性包含」的启发式写法（如 `[class*="cover"] [class*="add"]`），
在真实的头条发布页上是否命中**未经任何人验证**（作者自己也把失败吞掉了，所以坏了也不会有人发现）。
可借鉴的是**流程顺序与参数语义**（标题→正文→封面→首发→合集→声明→发布→二次确认），以及 **markdown→富文本粘贴** 这个思路。
