# 交接：UI 走查 + 插件接入（2026-09-15）

> 给下一个会话读的。上一轮会话因为宿主重启、工具目录未重建，无法使用新装的插件，改用 Node 直驱 CDP 完成了走查。
> A handoff brief for the next session. Read this before touching anything.

## 0. 先做这三件事

1. **确认插件工具已挂载**：本会话应能看到 `cdp_status` / `cdp_open` / `cdp_eval` / `cdp_shot` / `cdp_assert` 与 `computer_*`。若看不到，说明这不是新会话——需要**真正新开一个会话**（刷新页面/resume 都不行）。
   > ⚠️ **2026-09-16 更正：上面这条判断已被证伪。** 在一个确实是全新创建的会话里（`session-bc263030`，创建于 09:57:09），两组工具**依然**看不到，而且原因和会话新旧无关。别再靠「再开一个新会话」碰运气，直接看第 9 节。
2. **用 computer-use 前必须先加载技能**：`computer_*` 执行工具**只在当前 agent 加载了 Computer Use Skill 之后才出现**（这是插件设计，不是 bug）。
3. **确认服务在跑**（上一轮的 background job 可能已随会话结束而消失）：
   - 后端 3100：`npm run build:backend && node dist/server.js`
   - 渲染器 5173：`npm run dev:renderer`
   - 浏览器（插件方式）：Chrome 需带 `--remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=<dir>`

## 1. 环境硬事实（踩过的坑，别再踩）

| 事实 | 细节 |
|---|---|
| **后端读哪个数据目录** | `src/server.ts:28` → `storagePath = path.join(rootDir, "storage")`，即**仓库内的 `storage/`**，**不是** App 的 `~/.douyin-ai-video/storage`，也不是 `~/Documents/抖音AI视频/`。走查时务必确认读的是哪份数据 |
| **Vite 只绑 IPv6** | 监听在 `[::1]:5173`。用 `localhost:5173`；写 `127.0.0.1:5173` 会 connect 失败 |
| **Vite 代理** | `vite.config.ts` 把 `/api` 代理到 `http://localhost:3100` |
| **纯浏览器模式可行** | `renderer/src/electron-bridge.ts` 会注入 polyfill，`getServerPort()` 返回 5173。所以 Chrome 直开 `:5173` 就是能拿真数据的完整界面，**不需要 Electron** |
| **应用被首次设置门挡住** | 本机 `storage/cache/local-users.json` = `{"schemaVersion":1,"users":{}}`（0 用户）→ 所有路由都渲染 `LocalUserSetup`（h1="创建本地管理员"）。门在 `renderer/src/App.tsx` 的 `needsBootstrap` 分支，在 `<BrowserRouter>` **之前** |
| **越过门的正确姿势** | **不要**创建账号（会改用户数据）。用 CDP `Fetch.enable` 拦截 `*/api/local-users` 与 `*/api/local-sessions/current` 并 `Fetch.fulfillRequest` 返回假用户（内存态，不落盘）。见 `tools/audit2.mjs` |
| **Chrome 从沙箱里起不来** | 直接启动会因 seatbelt 冲突崩溃（日志 `sandbox initialization failed: Operation not permitted`）。加 `--headless=new --no-sandbox --disable-gpu` 可跑通 |
| **`vision_html_screenshot` 拒绝 URL** | 只吃本地 `.html/.htm`。要打活页面必须用真浏览器 + CDP |
| **后端产物** | 改 `src/` 后必须 `npm run build:backend`（`check`/`test` 不产出 `dist/`）。注意：mtime 差异不等于内容差异——上一轮曾仅凭 mtime 判断"dist 过期"，重建后字节数完全相同，是误判 |

## 2. 已装插件与状态

`~/.dsh/profiles/web/package.json` 的依赖与 `dsh.profile.bundles` 均已包含：

| 插件 | 版本/固定点 | 用途 |
|---|---|---|
| `@anionex/dsh-computer-use` | `0.3.2` | macOS AX 操作 Electron 窗口 / 原生弹窗；不抢前台、不动系统鼠标。**前置：系统设置授予「辅助功能」**（截图另需「屏幕录制」） |
| `dsh-cdp-browser` | `github:zaiwenJ/dsh-cdp-browser#caecd3bded2e` | 连已运行的 Chrome/Edge（CDP）：`cdp_shot` 截图、`cdp_assert` 像素/css/dom/js 断言、`cdp_eval` 执行 JS、`cdp_open` 开页 |
| `@anionex/dsh-vision-toolkit` | 早已安装 | `vision_*` 十个工具（截图/取色/像素对比/OCR/元素定位）。**宿主重启后需要重新激活**（调用一次激活入口即可） |
| 已有 | `dshmarket`、`dsh-find-plugin`、`dsh-explorer`、`dsh-filetree-bridge`、`dsh-launcher` | — |

未装（有意）：`dsh-annotate`（需加载 Chrome unpacked 扩展）、`dsh-code-check`（覆盖范围未验证是否含 `tsconfig.renderer.json`）、`dsh-design-qa`、`superdesign-dsh`、项目记忆、通知类。

CDP 启动参数注意：`--user-data-dir` 指向新目录 ⇒ **没有抖音登录态**。UI 走查不需要；测爬取/发布链路才需要（那时用默认 profile 退出后带参数重启，或复制 profile）。

## 3. 本轮走查怎么复现

```bash
# 1) 起后端与渲染器
npm run build:backend && node dist/server.js &      # 3100
npm run dev:renderer &                              # 5173（用 localhost）

# 2) 起带 CDP 的无头浏览器
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu --disable-crash-reporter \
  --remote-debugging-port=9222 --remote-allow-origins=* \
  --user-data-dir=/tmp/dsh-cdp2 --no-first-run "http://localhost:5173/"

# 3) 跑走查（8 路由 × 3 视口 = 24 张图 + 计算样式/网络/溢出探针）
node output/ui-audit-2026-09-15/tools/audit2.mjs   # 主走查 → report2.json
node output/ui-audit-2026-09-15/tools/audit3.mjs   # 定点核实 → report3.json
```

产物：`output/ui-audit-2026-09-15/`（`report2.json`、`report3.json`、24 张 PNG、`tools/`）。
⚠️ `output/ui-audit-2026-09-15/` 与 `.dsh-vision-toolkit/` **未被 gitignore**，会出现在 `git status`。用 `rm -rf` 清理或加进 `.gitignore`。

## 4. 已验证的真问题（带证据）

**P0 — `Unknown User` 泄漏到界面标题**
合集详情页 H1 直接显示英文 `Unknown User`。
证据链：`src/lib/user-page-crawler.ts` **6 处**硬编码 `nickname: "Unknown User"` 兜底 → 已持久化进 `storage/cache/collections-index.json`（被走查合集 `95848fe5-…` 的 `nickname` 就是它）→ 渲染成 H1。
违反规格「默认简体中文」；且创作者身份是合集页核心视觉。

**P0 — 爬虫数据管道系统性部分失败（同一条数据三连）**
被走查合集第一条（`awemeId 7670181536511533691`）：
```
createTime = 0        → 界面显示 1970/1/1
duration   = 0.119    → 界面显示 0:00
videoUrl   = ''        coverUrl 为 douyinpic 直链 → CDN 403 → 显示摄像机占位图标
statistics = {diggCount:4055, commentCount:0, shareCount:0}
hashtags   = []        （但 desc 里含 #pimmiesdilemma #戴上耳机）
```
前两项是**爬虫没抓到/抓错**，渲染层只是忠实显示；但 UI 也该兜底（日期应显示"未知时间"而非 `1970/1/1`）。403 是抖音 CDN 防盗链，封面需代理或本地缓存。

**P1 — 创作中心紫色滥用（量化）**
计算样式计数（桌面 1440）：

| 页面 | 蓝 `#2563EB`（主操作） | 紫 `#7C3AED`（AI/Skill） |
|---|---|---|
| **创作中心** | 125 | **702** |
| 作品详情 | 32 | 12 |
| 合集列表 | 31 | 9 |
| 设置 | 29 | 8 |
| 发布中心 / 垃圾桶 | 23 / 19 | 0 / 0 |

规格写「蓝=主操作、紫=AI/Skill，减少无意义渐变」，而创作中心页紫色是蓝色的 5.6 倍（被当成封面占位底色铺开），语义分配被反转。

**P1 — 发布中心命名不一致**：顶栏上下文写「发布工作台」，页面 H1 写「发布中心」。规格决策表定的是「发布中心」。

**P1 — 标题层级缺 h1**：作品列表页、设置页 **0 个 h1**，标题从 h2 起步（作品详情页正常有 h1）。

**P2 — 移动端第 4 步默认不可见**：作品详情页步骤条在 390px 下容器 356px、内容 552px（4×130 最小宽）。父容器是 `overflow-x-auto`（**有意滚动，不是破版**），但「视频成片」在首屏外，需横滑才发现。

**P2 — 列表密度**：创作中心整页高 **8841px（移动）/ 3910px（桌面）**、DOM 节点 1147、38 条全量渲染无虚拟化；移动端首屏被导航+标题+大按钮+当前创作卡+搜索筛选卡挤占，作品列表几乎不见。

## 5. 已证伪的误报（**不要"修"这些**）

| 疑似 | 查证结论 |
|---|---|
| 「创作中心」标题重复出现 | **误报**：第二个是响应式隐藏副本，`visible:false`、0×0 |
| 设置页两个可见「设置」 | **不是 bug**：一个是 Shell 头部（规格要求顶部只显示当前页面上下文），一个是页面标题 |
| 作品详情页 5 个元素横向越界 | **不是破版**：父容器 `overflow-x-auto`（scrollW 552 > clientW 356），是有意滚动条 |
| `dist/app.js` 比 `src/app.ts` 旧 = 在跑旧后端 | **误判**：重建后字节数完全相同（81599），仅 mtime 差异 |
| 设置页「GPT-5.2 - 中转」卡内模型写 `gpt-5.5` | **不是 bug**：用户自己的自定义命名 |

实测通过项：三档视口（390/768/1440）`overflowX` **全为 0**，无整页横向破版；`#F6F8FB`/`#172033`/`#667085`/`#DCE3EC` 四个 token 全部命中；**无未捕获的 console 报错**（仅 1 条封面图 403、1 条未生成转录时 `/raw-transcript` 的 404）。

## 6. 设计层评价（来自 vision 分析，供参考）

- **设置页**：IDE 式左分组 + 右单一内容区，**达标**，是层级最清楚的页面。
- **作品详情页**：「当前步骤」卡 +「主链路」四卡 + 底部 Tab + 进度条 **四处重复回答同一件事**（「下一步：视频转录」出现三次、等待状态四重）——正是规格第 1 节点名要治的病；真正的价值区「成果画布」视觉存在感最弱。
- **空状态**：Skill 管理**优秀**（有 CTA 引导）、垃圾桶**良好**（虚线框+图标+规则）、发布中心**偏弱**（大面积留白、缺图标）。
- **整体观感**：偏标准 B 端后台模板，创作工具的"内容感"不足（封面占比小、像图标而非多媒体预览）。

## 7. 建议的下一步（优先级）

1. **修 P0**：`Unknown User` 本地化 + 日期兜底（`1970/1/1` → 「未知时间」）+ 合集封面 403 处理。
2. **写回归门禁**：用 `cdp_assert` 把设计规则变成可执行断言，例如
   `{ type:'css', selector:'…', property:'background-color', equals:'rgb(37, 99, 235)' }`（`#2563EB` 蓝=主操作）、紫色只允许出现在 AI/Skill 元素上。
3. **深挖爬虫**：`createTime`/`duration`/`statistics`/`hashtags` 四项同时失败，查是否同一处解析分支挂了。
4. **规格对照清单**：按 `docs/superpowers/specs/2026-08-11-creative-canvas-ui-redesign.md` 的决策表逐条核对（导航、详情页核心、合集核心、发布中心、设置、垃圾桶、视觉语言、图标、文案语言）。

## 8. 待确认

- 本轮数据来自**仓库 `storage/`**（开发数据：38 任务 / 4 合集）。数据类结论（`Unknown User`、`createTime`、`duration`、403）**需在 App 真实数据上复验**；代码级证据（`user-page-crawler.ts` 硬编码）不受影响。
- `docs/worklog.md` 与 `AGENTS.md`/`CLAUDE.md` 已明显落后于代码：发布中心、创作画布、本地用户与权限、Skill 蒸馏这四块都没写进架构描述。

## 9. 插件工具挂不上的真实原因（2026-09-16 查明）

第 0 节的「看不到 = 不是新会话」是**误判**。在全新会话里两组工具仍然缺席，逐个查证后是两个**独立且与会话无关**的故障：

### 9.1 `dsh-cdp-browser`：工具声明缺 `output.schema`，注册被静默吞掉

插件 `dsh/index.js` 里 5 个工具全部只声明 `output: { render: renderText }`，**整个文件没有任何 `schema`**（`grep -c schema` = 0）。而 DSH 的 `tools.register()`（`@deepseek-ai/dsh-tools/lib/index.js:2777`）是强校验：

```js
if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || ...)
  throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
assertSupportedJsonSchema(output.schema);
```

实测复现：`assertSupportedJsonSchema(undefined)` → `JsonSchemaError: unsupported JSON schema: schema must be a schema object`。

而插件的 `apply()` 对每个工具都 `try { register } catch { console.error(...) }`——**异常只进宿主 stderr，模型侧完全不可见**。结论：只要这个 DSH 版本不变，**任何会话、任何重启都挂不上**；上一轮记的「工具目录未重建」是同一个症状的错误归因。修法：给 5 个工具补 `output.schema`（或改用 `defineTool`）。注意插件是 `github:zaiwenJ/dsh-cdp-browser#caecd3bded2e` 固定点，改上游或换 fork 后要更新 `package.json` 的固定 commit。

### 9.2 `@anionex/dsh-computer-use`：同名 Skill 遮蔽导致内容指纹门永不匹配

插件的渐进暴露门 `hasLoadedComputerUseSkill()`（`lib/exposure.js`）要求会话历史里出现**内容指纹匹配**的 Skill 调用：`containsSkillContent(...)` 必须命中插件自带的 `COMPUTER_USE_SKILL_CONTENT`（以 `# DSH Computer Use` 开头）。

但 `~/.agents/skills/computer-use/SKILL.md`（Hermes/Open Design 版，`version: 2.0.0`）**同名**，`skill {name:"computer-use"}` 拿到的是它（内容以 `# Computer Use (universal, any-model, cross-platform)` 开头）→ 指纹不匹配 → 11 个 `computer_*` 工具永不暴露。实测：加载该 Skill 后再调 `computer_use_activate`，报错 `computer_use_activate: load the computer-use Skill first`（`ctx.skills.register()` 注册的插件 Skill 被 `.agents` 那份遮蔽）。

修法：删掉/改名 `~/.agents/skills/computer-use`（让插件自带的 Skill 生效），或改插件 `COMPUTER_USE_SKILL_NAME`。

### 9.3 对走查方式的影响

本轮**没有可用的 `cdp_*` / `computer_*`**，所以第 3 节的走查脚本仍是唯一可复现路径。要复跑，可用插件自带引擎 `~/.dsh/profiles/web/node_modules/dsh-cdp-browser/dsh/cdp.js`（零依赖、纯 HTTP+WebSocket，**不 spawn 子进程**），从 Node 直接 import 即可截图/取样式/断言，不必等工具挂上。

### 9.4 顺带确认的环境事实（2026-09-16 09:57）

- 仓库内后端 3100 在跑（`/health` 返回 `ok`，`publishing.readOnly=false`），Vite 5173 返回 200；**9222 上没有浏览器在跑**。
- 运行中的 3100 加载的是我改 `src/` **之前**编译的 `dist/`，所以它仍然返回 `Unknown User`（实测 `/api/collections` 3 条为英文）。改了后端要生效必须 `npm run build:backend` **并重启后端进程**——`npm run check`/`npm test` 都不产出 `dist/`。
- 全量测试基线：376 tests / 374 pass / 1 skipped / **1 个既有失败** `src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge`。已用 `git stash` 在原始源码上复现同一失败，与本轮改动无关。

## 10. 插件故障已修（2026-09-16），及如何重放

9.1 / 9.2 两处已按下面的方式修好，**改动只落在 `~/.dsh/profiles/web/node_modules/` 里（不在本仓库）**，因此重装/升级这两个插件会丢失，需要按本节重放。

### 10.1 `dsh-cdp-browser`：补 `output.schema`

文件 `~/.dsh/profiles/web/node_modules/dsh-cdp-browser/dsh/index.js`，两处改动：

1. 在 `renderText` 定义之后新增常量：
   ```js
   const ARBITRARY_OBJECT_OUTPUT = { type: 'object', additionalProperties: true }
   ```
2. 5 个工具的 `output: { render: renderText }` 全部改为 `output: { schema: ARBITRARY_OBJECT_OUTPUT, render: renderText }`。

**为什么用「任意属性的对象」而不是精确字段类型**：DSH 不只在校验 schema，运行期还会用它校验返回值（`createSuccessResult` → `validateJsonSchemaValue` → 违规即抛 `ToolOutputError`，`dsh-tools/lib/index.js:3418`）。这些工具的返回里存在 `null` 字段（如 `cdp_status.browser`、`cdp_assert.screenshotPath`），而校验器**不支持 `type` 数组**（实测「schema.properties.x.type must be a single type string」），把类型写窄会让工具从「挂不上」变成「一调用就报错」。另外 `additionalProperties` 只接受布尔值，不能写 schema。

已用 DSH 真实校验器验证：**5/5 注册成功**（修复前 5/5 被拒，报 `schema must be a schema object`），且对 9 组真实返回形状（含 `browser: null` / `screenshotPath: null` / `value: null`）的运行期校验违规数为 **0**。

### 10.2 `@anionex/dsh-computer-use`：改插件自带 Skill 名

文件 `~/.dsh/profiles/web/node_modules/@anionex/dsh-computer-use/lib/skill.js:3`：

```js
export const COMPUTER_USE_SKILL_NAME = 'dsh-computer-use';   // 原为 'computer-use'
```

选这个方向而不是改 `~/.agents/skills/computer-use`：后者是用户全局技能库、可能被其他 harness 使用，改插件名的影响面只限于本 DSH profile。注意**不要**顺手改 `client.js` 的 `NS = 'computer-use'`（UI 组件 id）与 `config.js` 的 `COMPUTER_USE_SETTINGS_NAMESPACE`（对应 `cordis.patch.yml` 里的 `id: computer-use` 行），那两处与 Skill 名无关。

已验证：`COMPUTER_USE_SKILL.name` 与新常量一致；模拟会话跑插件自己的 `hasLoadedComputerUseSkill()`，`tool/result` 与 `user/message` 两条路径均返回 `true`。**对照断言**：名字对但内容是他人的 Skill 内容时仍返回 `false` —— 证明只是消除了同名冲突，内容指纹门本身没有被放宽。

### 10.3 生效条件与遗留

- **两处都要宿主重启 + 新开会话**才会挂载（插件在启动时加载，Skill 目录按会话生成）；当前会话内看不到 `cdp_*` / `computer_*` 是预期的。
- 顺带发现：`~/.agents/skills/computer-use`（Hermes/Open Design 版）教的是 `computer_use(action=...)` 这套 **Hermes/cua-driver 工具词汇**，在 DSH 里并不存在——它改名后仍会出现在技能目录里，加载它会得到对 DSH 无效的指令。是否清理这条全局技能由用户决定（本次未动）。
- 想彻底不怕重装，可把这两个包按本 profile 已有的 `file:` 本地插件模式（参考 `dsh-filetree-bridge`）vendored 到 `~/.dsh/local-plugins/`；本次未做，以免改动依赖管理方式。

