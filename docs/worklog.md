# 工作日志

> 规则：每次完成一轮操作后，只追加简短记录；下次开始新任务前，先看这份文件，再决定是否需要补充上下文。

## 当前状态

- 项目：抖音 AI 视频助手
- 当前形态：Electron + React + Express 的桌面应用
- 已有能力：本地存储、任务模型、抖音分享文本解析、视频下载、音频抽取、内置 whisper.cpp 结构化 ASR 转写、AI 洗稿、视频提示词生成、HyperFrames 本地视频生成、手动分步执行、步骤级 3 次自动重试、任务垃圾桶
- 当前接口：
  - `GET /health`
  - `POST /api/jobs`
  - `GET /api/jobs/:id`
  - `GET /api/jobs/:id/script`
  - `GET /api/jobs/:id/raw-share`
  - `GET /api/jobs/:id/raw-page`
  - `GET /api/jobs/:id/raw-transcript`
  - `POST /api/jobs/:id/steps/transcribe`
  - `POST /api/jobs/:id/steps/clean`
  - `POST /api/jobs/:id/steps/generate-video-prompts`
  - `POST /api/jobs/:id/steps/generate-video`
  - `GET /api/jobs/trash`
  - `POST /api/jobs/:id/restore`
  - `DELETE /api/jobs/:id/permanent`
  - `GET /api/jobs/:id/video-prompts`
  - `GET /api/jobs/:id/video-output`
  - `GET /api/jobs/:id/video/download`
- 本地存储目录：`storage/`
- 当前待办：Whisper 模型体积和速度优化、视频视觉样式优化、端到端样本回归测试
- 新增待办（2026-09-15）：合集封面 CDN 403、创作中心紫色滥用（P1）；`Unknown User`、`1970/1/1`、`0:00` 已于 2026-09-16 修复；详见 `docs/handoff-2026-09-15-ui-audit.md`

## 最近操作

- 2026-09-17：**修掉一个我自己造成的"改了没生效"事故，并把坑写进文档**。用户反馈"配了 `SAU_BINARY`/`SAU_BASE_DIR` 重启后仍报未配置"——根因是**我改了 `electron/server.ts` 加环境变量透传，但只跑了 `npm run build:backend`，没跑 `npm run build:electron`**：Electron 跑的是 `dist-electron/`（`package.json` 的 `main`），而 `build:backend` 不产出它。事后核实 `dist-electron/server.js` 是 Sep 16 的、`grep -c SAU_BINARY` 为 0，而 `electron/server.ts` 已是 Sep 17 —— 环境变量确实进了 Electron 进程，但旧产物里没人读它。`npm run build:electron` 后重启即通（`dist-electron/server.js` 第 66/67 行出现透传）。**验证方式**：用 `POST .../auto-publish/code`（该任务并非 `awaiting_code`）做**安全探针** —— `requireSauRunner()` 在方法最前面，未配置先抛 422，配置好则走到状态检查抛 409（实测得到 409），全程不起浏览器、不发布。文档改动：`AGENTS.md`+`CLAUDE.md` 的「后端改动生效需两步」扩写成**两套编译产物对照表**（`src/`→`dist/`、`electron/`→`dist-electron/`、`renderer/`→HMR），并点明"直接 `electron .` 会绕过 `dev:electron` 里的 `build:electron`"；故障排查新增第 0 条（含 `grep -c SAU_BINARY dist-electron/server.js` 与 `ps -Eww | grep -o "SAU_[A-Z_]*=[^ ]*"` 两条自查命令）。

- 2026-09-17：**② 抖音图文自动发布全部提交**（`a777fc6`，27 个文件 / +5354 −253），并同步 `AGENTS.md`、`CLAUDE.md`、`README.md`（架构清单、4 个新接口、`SAU_BINARY`/`SAU_BASE_DIR` 配置、新增「抖音图文自动发布（外部 sau 引擎）」注意事项与故障排查节；AGENTS 与 CLAUDE 仍逐字一致）。**提交前做了私密数据审计**：无 `sk-` 密钥、无真实密码/PIN 字段、未带 `storage/`、`cookies/`、`.env`（`storage/` 本就被 .gitignore 覆盖），并把**真实 cookie 的每一段值**逐个在暂存内容里比对 —— 唯一命中是真实 cookie 里那个畸形段 `=douyin.com` 的域名字面串（非凭据，在文档里自然出现 18 次），**58 个真实凭据值零泄露**。顺带解释了一个既有数字：59 段 → 账号文件 58 个 cookie，正是因为 `parseCookieHeader` 跳过了这个空名段。

- 2026-09-17：开始 **② 抖音图文自动发布**。**Task 1 完成**（`abe9d9e`）：`PUBLISH_NOTE_POLICIES`（抖音图文 title ≤20 / note ≤1000）+ `validateNoteCopy`，与视频校验收敛到同一实现 `validateCopyAgainstPolicy`（视频 55 字口径一字未改，既有 6 条平台用例作为回归门禁保持通过）；`types.ts` 增 `contentType`/`imagePaths`/`noteCopy`/`autoPublish` 与 `missing_images`。
- 2026-09-17：**按用户要求装好了 `sau` 引擎，并完成 Task 7 Step 4（配置后只跑预检、未发布任何内容）**。安装位置 `~/social-auto-upload`（工作区之外，不污染仓库）：`git clone --depth 1`（HEAD `0012d2c`）→ `cp conf.example.py conf.py` → `uv venv --python 3.12`（本机 `python3` 是 3.13.12，确在 `>=3.10,<3.13` 之外，坑②实测成立）→ `uv pip install -e .` → **`uv pip install playwright`（坑①：pyproject 只声明 patchright）** → `uv run patchright install chromium`。**体积实测 442M + 520M ≈ 962M，与 spec §1.2 的"约 970MB"吻合**。完成后 `import playwright / patchright` 正常、`sau` CLI 能起。
- 2026-09-17：Step 4 的实测结果（**只做登录态校验，未发布任何内容**）：用**我们自己的 `SauRunner`**（Task 3 的实现）跑真引擎 —— `assertConfigured()` OK → `prepareAccountFile()` 产出 `~/social-auto-upload/cookies/douyin_mine.json`（58 段 cookie、域全为 `.douyin.com`、含 `sessionid`、权限 **600**）→ **`checkLogin()` 返回 `ok: true`、exitCode 0、输出 `valid`**。这同时证明了 Task 3 的 argv（`douyin check --account mine`）与 `valid/invalid` 判定在真实 CLI 上是对的。用户的原始 `~/.douyin-ai-video/douyin-cookie.txt` **只被读取、未被修改**（仍 5900 字节 / Aug 5 21:12）。
- 2026-09-17：两个沙箱事实（两者都不是安装或代码问题）：① 上游 `uploader/__init__.py` 在 **import 阶段**就 `mkdir BASE_DIR/cookies`，所以沙箱下连 `sau --help` 都会 `PermissionError`；② `prepareAccountFile` 要写 `~/social-auto-upload/cookies/`、预检要启动 patchright 浏览器（写 `~/Library/Caches`），都在工作区之外。因此本步骤与安装同样需要放宽沙箱。**另外我自己写错一处断言**：`(await stat(f)).mode & 0o777 === 0o600` —— JS 里 `&` 优先级低于 `===`，等于 `mode & 0`，于是把正确的 600 报成"非 600"；用括号/Python 复核确认文件确为 `-rw-------`。
- 2026-09-17：用户**第二次走查反馈**「这样会误导用户的，用户会找不到恢复按钮」—— 查证属实并已修（用户可见文案/可发现性）：① **「恢复任务 / 恢复发布包」原本被渲染成纯图标**（`RotateCcw`，只有 `title` 悬停提示），而它既不属于「复制 / 在 Finder 显示 / 打开平台 / 删除」这类有通用图标语义的动作，又是用户明确要找的操作 —— 改为**文字按钮**；② 包行「下一步」提示写着「恢复已取消任务或**创建新版本**」，但 `create-version` 只在任务 `published` 时进入动作列表（且动作是**逐任务**判定的），提示词指向一个不存在的按钮。改为按真实可用性分支：存在已发布任务时提「基于已发布版本创建新版本」，否则只说「恢复已取消的任务后可继续人工发布」。顺带把 `publishingNextStep` 从页面挪到 `utils/publishing.ts`（纯函数才好用断言守住用户可见文案），新增 2 个用例，全量 479 → **481**。浏览器实测 4/4：`恢复任务` 以文字显示、复制类仍是图标、提示不再提创建新版本。**顺带发现**：已取消的任务**不在默认的「待处理」筛选里**（要先切「全部」或「已取消」才看得到），这也是"找不到恢复入口"的一部分原因。
- 2026-09-17：用户走查**再抓到两个真问题**（都已修 + 补回归用例）：① **预览弹窗只显示了字数、没渲染文案内容** —— 文案区只有 `标题 25/55` 这类计数，标题/正文/话题的文字一个字都没摊出来，而 spec §14.1 的立项理由正是「此前项目里没有任何地方能**看见**将要发出去的内容」，等于预览没起到作用；现按 §14.2 渲染三段正文（超限的整段标红，空话题给「（无）」占位）。② **视频包预览播放器黑屏 0:00** —— `<video src="/api/jobs/:id/video/stream">` 是**相对路径**，在 Electron 里页面来源是 Vite（5173），相对路径会打到 Vite 开发代理 → 独立后端的**仓库 storage**，而不是 App 自己的内嵌后端（那个任务在 App storage 里）→ 实测 404、播放器黑屏。改为由页面用新增的 `apiClient.getJobVideoStreamUrl()` 解析成**绝对 URL** 再作为 prop 传给弹窗（弹窗保持纯展示），与既有 `getAssetRawUrl` 同一套写法；实测 `http://localhost:60946/...` Range 请求返回 **206 + video/mp4**。用例 10 个（新增 4），全量 476 → **479**。**教训**：媒体元素（`<img>`/`<video>`）不能用相对 URL，也不能带自定义头 —— 本项目里正确做法只有两条：走 apiClient 取 blob，或用 `getAssetRawUrl` 式的绝对 URL。
- 2026-09-17：用户走查时发现**漏做了一个 spec 要求的入口**：spec §13 的发布中心改动里写明要有「**「预览」入口**」，§14.2 也把「包/任务行『预览』按钮（随时查看，视频包走这个）」与「任务行『发布图文到抖音』（必经确认）」并列为两种进入方式；我在 Task 6 只接了后者。已补上：新增 `preview` 动作（只读、与任务状态无关、垃圾桶里不给），点它取包级预览并**只渲染「关闭」**（`onConfirm` 省略即无确认按钮，Task 5 的弹窗本来就支持）。浏览器实测 6/6：按钮出现、3 张图真正加载（`naturalWidth > 0`）、无「确认发布」、图文包不渲染播放器。全量 476 通过 / 1 既有失败。**教训**：Task 6 的计划正文只列了「动作 + 验证码 + 提示」，我照正文做而没有回去核对 spec §13 的影响面清单 —— 计划与 spec 不一致时应以 spec 为准（计划是 spec 的派生）。
- 2026-09-17：按用户要求**重启了 Electron**（原 PID 60658 → 托管后台作业 `bash-24`，`NODE_ENV=development node_modules/.bin/electron . --no-sandbox`）。启动日志确认 `Loading backend from: <repo>/dist/app.js`、内嵌后端 `http://localhost:58056`，四个新路由未认证均 401（已挂上）、`/health` 正常。**但发现一个操作层坑**：从 DSH 沙箱内启动的 Electron **读不到 macOS keychain**（`security` 查询报 `Module Directory Service error`，Electron 日志报 `Keychain lookup failed ... -67674`），而 `~/Library/Application Support/douyin-ai-video/config.json` 里的 API Key 是 `safeStorage` 加密存的 —— `decryptApiKey` 在解不开时会**静默退化成空串或密文本身**，表现为「AI 未配置」或 AI 调用 401。**要在 Electron 里正常用 AI，必须从用户自己的终端（沙箱外）启动**：`cd <repo> && NODE_ENV=development node_modules/.bin/electron . --no-sandbox`。另：本会话起的两个后台作业（后端 3100 与 Electron）**会话结束后可能被回收**。
- 2026-09-17：**② Task 7 Step 1–3 完成**。Step 1：`npm run check` 双端 0、全量 **475 通过 / 1 跳过 / 1 既有失败**（唯一失败仍是 `publishing-service.test.ts` 那条基线失败）。Step 2：`npm run build:backend` 后**重启了独立后端**（原 PID 60401 → 新的托管后台作业），新路由已挂上（`/preview`、`/images/:index`、`/auto-publish`、`/auto-publish/code` 未认证均 401 而非 404）；**Electron 未重启**（会打断用户会话，需人工重启才会带上新后端）。Step 3：造联调图文包 → 真机验证通过。**Step 4–6 未做**（需真实 `sau` 引擎，本机已不在）。
- 2026-09-17：Task 7 Step 3 **真机验证抓到两个单测抓不到的 bug**（都已修 + 补回归用例）：① **`parseApiError` 在真实链路上永远走兜底文案** —— `publishingRequest` 抛的是扁平化错误（code/message 直接挂在 error 上、没有 axios 的 `response`），而解析器只认 `response.data`，于是界面上**所有**发布错误都显示「发布请求失败，请稍后重试」，后端写的明确提示全被吞掉（历史遗留 bug，不止影响本特性）；② **图文预览图全是破图** —— `<img src>` 不会带 `X-Local-Session` 头，而 `GET /packages/:id/images/:index` 是 `authenticated` 的（401），改为与既有封面缩略图一样「带会话取 blob + createObjectURL」。顺带把「未配置 sau」的报错补全成 spec §1.2 的三个安装坑（此前只说「未配置」，等于把用户丢进 970MB 的坑里自己踩）。**教训记下**：界面断言必须落到 `img.naturalWidth > 0` —— 只断言元素数量时，破图也能「通过」。
- 2026-09-17：**② Task 6「发布中心 UI 与配置透传」完成**。发布中心任务行新增「发布图文到抖音」动作（先弹 Task 5 的预览弹窗，确认后才带 `previewRevision` 提交，落实 spec §14.2 的「必经确认」）、`awaiting_code` 时的「提交验证码」动作（沿用既有 prompt 弹窗模式）、以及 `succeeded` 后任务行显示「已提交，请在抖音后台确认后点「标记已发布」」。新增 `getPublishingAutoPublishBlocker` / `getPublishingAutoPublishHint` 与 `AUTO_PUBLISH_STALE_MS`；`api.ts` 加 `getPublishingPackagePreview` / `autoPublishPublishingTask` / `submitPublishingAutoPublishCode`；`SAU_BINARY` / `SAU_BASE_DIR` 从 env 透传到独立后端与 Electron 两条入口。用例 20/20（新增 6），全量 468 → **474**，`check` 双端 0，`build:backend` 通过。
- 2026-09-17：Task 6 里四处**比计划更严**的决定：① 动作可见性做成「返回原因」而非纯布尔，界面能说明禁用**为什么**（本项目在侧栏折叠上吃过一次「零变化导致找不到入口」的亏）；② `scheduled` 与 `cancelled` 任务**不给**自动发布（否则「立即发布」会绕过用户设的排期 / 复活已取消的任务），`failed` **给**（spec §9 明确「绝不自动重试，由人再次点击」）；③ 进行中时不展示「自动发布」而是「提交验证码」，避免必然 409；④ 渲染层复刻后端 30 分钟僵死阈值（注释指向 `publishing-store.ts` 的常量），否则被杀死的进程会让按钮**永久灰掉**。另外把弹窗载荷类型收敛成 `types/index.ts` 的 `PublishingPackagePreview`，前后端不再各写一份。
- 2026-09-17：**② Task 5.5「图文包创建入口」完成（计划外补齐）**。计划漏了一步：Task 2 的 `createNotePackageAssets` **没有任何调用方**，图文包在真实应用里根本无法创建（Task 4/5 的服务端用例都是把图文包直接种进索引来测的）—— 不补这一步，Task 6 的界面能写但 Task 7 的人工复核走不通。改动：`PublishingPreview` / `CreatePublishingPackageInput` 增图文字段；`previewNotePackage`（列出场景静帧 + 给出压缩到 20 字的 `noteCopy` 默认值 + `noteCopyTitleCompressed`）；`createNote`（按图文口径校验 + 核对含图片集合的 revision + 任务文案同步自 `noteCopy`）；`createNotePackage`；`sourceRevision` 支持图片集合。用例 6 个，全量 462 → **468**。
- 2026-09-17：Task 5.5 的关键实现决定：① **`sourceRevision` 只在图文时把图片集合纳入指纹**（视频路径不传该参数），因此 `publishing-service.test.ts` 里那条精确哈希断言**逐字节不变** —— 我把它当作本次重构的回归门禁；② 抽出 `commitNewPackage`（预留版本 → 建任务 → 打包 → 落库 → 失败回滚）供视频与图文共用，因为这段编排的回滚与一致性错误处理很微妙，漏一次 rollback 就留下孤儿包目录，与 assets 层「安全校验只允许有一个真源」同一原则；③ **图文只认包级 `noteCopy`**，平台任务文案由服务端同步生成，否则客户端传两份后会漂移成「预览看到的」≠「发出去的」（正是 spec §14.3 要防的）；④ note 包的 `video*` 字段用图片清单哈希 / 图片总字节 / `copy` 如实填充。**端到端用例**（以前不可能存在）：图文预览 → 创建图文包 → 包级预览取 revision → 提交 → `succeeded` 且任务仍为 `ready`。
- 2026-09-17：**② Task 5「发布前预览」完成**。新增 `GET /api/publishing/packages/:id/preview`（产出 `previewRevision`）与 `GET /api/publishing/packages/:id/images/:index`（0 基序号对应 `imagePaths`，越界/缺图 404、序号格式错 400），以及弹窗组件 `renderer/src/components/PublishPreviewDialog.tsx`（视频包出播放器、图文包出横滑图 + `1/N` 序号、字数/上限与超限标红、缺资产显眼且禁用确认）。用例 13 个（服务端 6 + 组件 7），全量 449 → **462**。**闭环用例**：先调预览取 `previewRevision`、再带它调 auto-publish → 200 且 `succeeded`（Task 5 产出 × Task 4 校验）。
- 2026-09-17：Task 5 的关键设计决定：**文案校验留在服务端**。渲染层是独立 TS 工程（`tsconfig.renderer.json` 只 include `renderer/src`，现有代码也无一处引用 `src/lib`），引用不到 Task 1 的 `validateNoteCopy`；若在渲染层复刻一份长度规则必然与后端漂移。因此预览接口直接下发 `copyChecks`（每字段 `actual/limit/over` + `violations`），弹窗只负责渲染。另外图文包的文案区显示**包级 `noteCopy`**（即 auto-publish 实际提交的内容），而不是任务文案 —— 否则会出现「预览看到的」与「发出去的」不一致。图片读取复用 `publishing-assets` 的 `resolveDeclaredImage`，归属校验仍是单一真源。
- 2026-09-17：**② Task 4「路由、并发互斥与验证码通路」完成**。新增 `POST /api/publishing/tasks/:id/auto-publish` 与 `.../auto-publish/code`；store 新增包级内容指纹 `previewRevision`（图文包覆盖**有序** `imagePaths` + `noteCopy`，视频包覆盖成片哈希，两者都覆盖各平台文案）与 `beginAutoPublish` / `updateAutoPublish` / `recordAutoPublishCode`。**「校验失败不留记录」是结构上成立的**：图文校验、revision 比对、并发互斥三件事在同一次 `mutate` 里完成，任何一项不满足都直接抛错且不写盘。用例 87/87 绿（store 45 + 路由 42），全量 431 → **449**。**`task.status` 全程不变**（`succeeded` 只表示已提交），这条用 store 与路由两层断言守住。
- 2026-09-17：Task 4 有三处**偏离计划的决定**，都记下来了：① 编排放在 `PublishingService` 而不是路由处理器 —— 本项目所有路由都是「校验 + 转调 service」的薄层，塞编排进去会破坏既有架构不变式，故文件清单比计划多 3 个；② 新增计划外的**僵死锁安全阀**：遗留 `running`/`awaiting_code` 超过 30 分钟视为「进程已死」允许重试 —— 发布请求是同步的，进程被杀会留下永远 `running` 的记录而界面没有入口能清掉，没有这个阈值任务会被永久锁死（阈值必须大于上传超时 900s）；③ 服务端也校验图片完好（`verifyPackageImages`），不依赖 Task 6 的 UI 禁用态 —— 与 spec §14.3「必经确认要做成服务端约束而非 UI 装饰」同一个道理。
- 2026-09-17：Task 4 的测试抓到两个真问题：① **配置检查排在了输入合法性之前** —— 对视频包调用时先报「未配置 sau」而不是「这不是图文包」，属于「配置压过输入」的错序，改为先判内容类型再判配置；② `previewRevision` 键缺失时 `requiredNonEmptyString` 会退回通用文案「请求参数无效」，导致「缺失 → 400」的提示不可执行，补了专门的 `requiredPreviewRevision`。
- 2026-09-17：**② Task 3「sau-runner.ts」完成**。新增 `src/lib/sau-runner.ts` + 17 个用例（全绿，**全程假 CLI**：临时目录里的 shell stub，`chmod +x` 后经 `sauBinary` 注入，绝不联网、绝不碰真实抖音）。实现 `checkLogin` / `prepareAccountFile` / `syncBackCookies` / `runUploadNote`，统一结果形状 `{ ok, exitCode, output, needsVerificationCode }`，注入点对齐既有 `AsrService.commandRunner` 写法，**复用 `douyin-cookie.ts` 的 `getCookiePath()`** 作为 cookie 路径唯一真源（有用例守住默认值，不新造第二条路径）。
- 2026-09-17：Task 3 的关键未知数**全部从上游源码取回实测，没有猜**（仓库已在本机被清掉，故按 `dreammis/social-auto-upload@main` 逐条核对）：① 验证码提示关键字 = `检测到短信验证码弹窗` / `等待验证码输入`；② 上游 `_read_verify_code()` **先读 `verify_code.txt`、再回退 stdin**，而 stdin 非 TTY 时直接返回空串 —— 所以以 `stdio[0]="ignore"` 启动不会卡在 `input()`，**写文件是唯一可靠投喂方式**（验证通过后上游自删该文件）；③ `<sauBaseDir>/cookies/douyin_<name>.json` 与 `<sauBaseDir>/verify_code.txt` 均由 `resolve_runtime_home()==Path(BASE_DIR)` 推出，spec §4 的路径契约成立；④ storage_state 字段默认值照抄上游 `export_douyin_cookie.sh`（`path="/"`、`expires=-1`、`secure=true`、`httpOnly=false`、`sameSite="Lax"`）；⑤ 上游上传后确实 `context.storage_state(path=account_file)` 回写 cookie。另把 runner 生成的 argv 喂给**上游 argparse 定义的复刻**（本机 python3）验证可解析，并实测出 `-要点` / `-abc` / 值本身为 `--note` 时朴素两 token 写法会被 argparse 拒 —— 故这类值改用 `--note=<值>` 单 token 形式。
- 2026-09-17：Task 3 里测试抓到两个真问题：① `checkLogin` 的 `ok` 若用朴素 `/valid/` 判定会被 `invalid` 的子串命中（`"invalid".includes("valid")` 为真），改用词边界 `\bvalid\b`，且退出码 0 但无 `valid` 也判失败（fail closed）；② `isDouyinDomain` 若用 `includes("douyin.com")` 会把 `iesdouyin.com`（另一个站点）误判为抖音域，导致同名 Cookie 去重时选错来源，改为「等于 `douyin.com` 或以 `.douyin.com` 结尾」。
- 2026-09-17：**② Task 2「图文打包」完成**。`publishing-assets.ts` 先把「暂存目录事务」（锁 → 临时目录 → 目录身份校验 → 原子提升 → 回滚闭包 → 错误清理）抽成共用私有 helper `withStagedPackage`，视频内容与新增的 `stageNoteContent` 各自调用 —— 安全校验保持单一真源，**没有**在 `createPackageAssets` 里塞 if/else，也**没有**复制第二份骨架；既有 30 个资产用例（含 `stageTextProjection` 的 CAS/回滚用例）作为重构门禁全程保持通过。新增 `createNotePackageAssets`（独立入口）与 `collectSceneSnapshots`：静帧按 `frame-NN` **数值场景序**入包为 `images/01.png…`，**排除同目录的 `contact-sheet-*.jpg`**（它们的字典序排在 `frame-*` 之前，`readdir().sort()` 会错位），图片清单哈希 = 各图 sha256 有序拼接后再哈希（调换顺序/改动任一张都会变），每张图做「源可读 → 复制 → 目标 sha256 与源一致」校验，>35 张在写盘前以 `publish_too_many_images` 拦掉。新增 7 个用例（37/37 绿），并用**应用真实产出的 11 张 1080×1920 静帧**（job `97db73e8`，5.40MB）实测：场景序正确、逐张字节一致、顺序调换改变哈希、越界路径被拒且无临时目录残留。
- 2026-09-17：② Task 2 里三个**需要记下来的口径决定**（都写进了代码注释）：① **缺图不抛错**（与文件内既有 `missing_cover` 同一口径）——包仍自包含地建出来，`assetHealth = "missing_images"` 且 `warnings` 报出 `publish_images_missing` 明确原因，Task 6 的「缺图禁用态+原因」因此直接可达；② note 包的 `video*` 字段「不适用」，记录层用 `videoSha256` 承载**图片清单哈希**作为等价完整性凭据（spec §5），`verifyPackageImages` 据此能查出缺图/篡改/调序；③ 显式传入 `sourceImagePaths` 时**按传入顺序**进包（素材库选图按选择顺序），省略时才按场景序自动收集静帧。顺带把 `scanAndRepair` 的健康判定按 `contentType` 分派（图文包没有 `video.mp4`，走视频分支会误判 `broken_video`），并给 `publishing-store.ts` 的 `isDeliveryPackage` 补上 `missing_images` —— 否则这个健康值落不了库。
- 2026-09-17：按用户要求把**「发布前预览」写进 ② 的 spec 与计划**（`67825ea`）。spec 新增 §14：通用预览（视频包成片播放器 / 图文包图片横滑 + 文案字数校验）、弹窗形态、图文自动发布**必经确认**。关键决定：**「必经确认」做成服务端约束**而非 UI 装饰 —— `auto-publish` 必须带 `previewRevision`（缺失 400 / 不一致 409 且不写 `autoPublish`），顺带拦住「预览之后内容被改」。计划新增 Task 5（预览），revision 的**校验**归 Task 4（路由归属）、**产出**归 Task 5，避免先实现路由再改同一路由的返工。
- 2026-09-17：**交接**。`Task 2 图文打包`未开始 —— 它要动 1484 行、安全加固过的 `publishing-assets.ts`（锁 → 临时目录 → 身份校验 → 原子提升 → 回滚），本会话上下文已很长，故留待新会话。交接文档：`docs/handoff-2026-09-17-note-auto-publish.md`（含硬约束、两个"不要做"、素材来源实测、环境事实与基线测试数）。计划里 Task 1 的 4 个 Step 已勾选。

- 2026-09-17：**文档同步**（`AGENTS.md` / `CLAUDE.md` / `README.md`）。三件事：① 补上会话内新增能力的说明（素材库、原视频播放、本机操作者无登录界面、可折叠侧栏）与对应 API；② 按实测更正两处**过时/错误**描述 —— storage 根目录随运行方式不同（桌面端是 `~/Library/Application Support/douyin-ai-video/storage`，独立后端是仓库 `storage/`），以及 Electron 读的配置文件在 `app.getPath('userData')` 而**不是** `~/.douyin-ai-video/config.json`；③ `README` 里描述「发布者无需 PIN / 管理员切换需 PIN / 重置本地用户」的那一节已随界面移除而重写为「本机操作者与权限」。顺带把 `AGENTS.md` 与 `CLAUDE.md` **同步为完全一致**（此前 AGENTS 落后一轮，缺 reclean 与 `dist` 警告）。
- 2026-09-17：实现**素材库**（③ 的 Task 1/2/4，提交 `90d6895`、`dfd9aa6`）：后端 `assets-store`（索引/落盘/白名单/限额/路径归属校验）+ `assets-routes`（multer 上传、列表、Range 预览、删除），前端 `/assets` 页面与主导航入口。新增 16 个用例；实时验证（真实后端上传真实封面 → 201、中文名正确、Range 206、删除后磁盘零残留）。测试抓到两个真 bug：类型校验里的死逻辑（`asset_kind_mismatch` 永远抛不出）、**busboy 按 latin1 解码文件名导致中文名乱码**。顺带把 Range 逻辑抽成 `range-response.ts` 供成片与素材共用（以既有 14 个 video-output 用例为回归门禁）。Task 3（图片接入图文）依赖 ② 的图文打包，已按用户决定推迟到做 ② 时合并。
- 2026-09-17：实现**侧栏可折叠**（①，4 个 Task）：`railPreference` 持久化、`AppShell` 声明 CSS 变量 `--rail-w` 作为宽度唯一真源（消除四处硬编码偏移）、`PrimaryRail` 展开态显示导航文字。新增 12 个用例。**复核反馈修正**：初版把折叠开关做成「整个 logo 行」，收起态与此前长得一模一样，用户找不到入口；改为底部常驻按钮并把 logo 行恢复原样（提交 `1b94fcb`）。教训记在 spec 第 5 节：视觉零变化与新增功能可发现性冲突时，应先问用户而不是自己按洁癖选。
- 2026-09-17：顺带修了一个**既有隐患**：`ApiKeyStatusIndicator` / `CookieStatusIndicator` 缺 `import React`，在 Node 下静态渲染会 `ReferenceError` —— 根因是根 `tsconfig.json` 没有 `jsx` 设置（tsx 走经典转换），而 `tsconfig.renderer.json` 是 `react-jsx`。25 个组件里有 7 个缺该 import，现有渲染层测试能过纯属运气（被测组件恰好都 import 了）。

- 2026-09-17：完成「接入 social-auto-upload 自动发布」的**最小可行性验证**（结论：可行，但有三处成本）。验证方式：把 `~/.douyin-ai-video/douyin-cookie.txt` 的 **Cookie 头字符串（59 段）机械转换成 Playwright `storage_state` JSON**（域 `.douyin.com`，字段形状照抄它的 `export_douyin_cookie.sh:183-196`），放进 `<repo>/cookies/douyin_mine.json`，跑 `sau douyin check --account mine` → 输出 **`valid`**（退出码 0）。**阴性对照**：同一流程把 sessionid/sid_*/ttwid 换成伪造值 → **`invalid`**（退出码 1），证明校验器有真实判别力、我们的登录态确实可复用（登录这半我们已有，不需要重登）。验证用的凭据副本已删除，用户的原始 cookie 文件未被改动（仍 5900 字节 / Aug 5 21:12）；全程**未发布任何内容**。
- 2026-09-17：验证中发现它的**官方安装步骤装完起不来**——`pyproject.toml` 只声明 `patchright`，但 `uploader/` 下 7 个 uploader（tk/alipay/hupu/weibo/xhs/baijiahao）与 `myUtils/auth.py`、`myUtils/login.py` 仍在 `import playwright`，而 `sau_cli.py` 在 import 阶段就加载全部平台 → `ModuleNotFoundError: No module named 'playwright'`。需手动 `uv pip install playwright` 才能启动 CLI。另外 `requires-python = ">=3.10,<3.13"`，本机 Python 3.13.12 **不在范围内**，必须用 uv 拉一个 3.12（本次用了 `uv venv --python 3.12` → CPython 3.12.10）。成本实测：仓库+venv 444MB、patchright chromium 525MB（≈ 970MB）。
- 2026-09-17：沙箱注意：`uv` 默认缓存 `~/.cache/uv` 会报 `Operation not permitted`，需 `UV_CACHE_DIR=/tmp/uv-cache`（同理 `UV_PYTHON_INSTALL_DIR`）。另 `patchright install chromium` 装的是 **headless shell**，运行时需带同一个 `PLAYWRIGHT_BROWSERS_PATH`。

- 2026-09-16：修 **P1 紫色滥用**（提交 `a4bb61c`）。元凶是一行：`ContentPreview.tsx` 的封面容器无条件铺 `from-tech-blue via-tech-purple to-tech-purple-dark`，被列表行/卡片/当前创作条三处复用 → 每张封面都是一块紫色。改为中性底（`bg-tech-bg`+`tech-border`，无图时标题 `tech-muted`），同类占位一并中性化（合集头像、Skill 头像、合集空状态图标）；`JobListView:59`/`JobCardView:45` 的 `Wand2` 与 AI 徽章等正当紫色用途保留；两处「处理进度」进度条有意保留。新增回归断言：封面占位不得出现任何 `purple` 类名且必须用中性 token。实测封面盒紫色 39/39 → **0/39**。
- 2026-09-16：更正交接文档里两条判断。①「封面 403 是防盗链」**错**：实测 4 种请求头组合（含 `Referer: douyin.com`）全部 403，URL 是带 `x-expires`+`x-signature` 的**签名链接**，仓库数据 23/23 已过期、App 真实数据仅 5/162 过期（其余签名到 2036）；故**代理无用**，只有有效期内落本地才可靠。②交接文档里的「紫/蓝比例」**不是**可用的验收口径：剩下的 351/352 个紫色元素是同一个 AI `wand-sparkles` 图标（39 行 × 每图标 8 个 `<path>`），SVG 内部路径把计数放大了 8 倍。
- 2026-09-16：修好两个插件故障并记录重放步骤（提交 `cf6722a`，改动在 `~/.dsh/profiles/web/node_modules/` 不在本仓库）：`dsh-cdp-browser` 5 个工具补 `output.schema`（只能用「任意属性对象」——运行期会用 schema 校验返回值且不支持 type 数组）；`dsh-computer-use` 的 Skill 名改为 `dsh-computer-use` 以消除与 `~/.agents/skills/computer-use` 的同名遮蔽。**需宿主重启 + 新会话才生效**。

- 2026-09-16：去除登录/切换入口，改为单一「本机操作者」（提交 `f0d1c70`）。先纠正了一个事实：桌面端**本来就没有登录这一步** —— `operator.ts` 会自动从 localStorage 恢复上次的**发布者**（不需要 PIN），只有切到管理员才要 PIN；真正的摩擦点是「0 用户时整个应用被建管理员门顶掉」+ 顶部操作者 chip + 设置页用户管理。改动：新增 `POST /api/local-sessions/auto`（复用已有管理员，无管理员时创建无 PIN 的「本机用户」）；`openLocalOperator()` 独立承担无 PIN 分支，**`open()` 的管理员 PIN 契约一字未改**（实测无 PIN 仍 401「管理员 PIN 为必填项」、错误 PIN 仍 401「PIN 不正确」）；前端启动即自动会话，卸载三处 UI 与随之失效的 `utils/localUsers.ts`。全量 385 → 372 项（删 21 个 UI 专属用例、新增 11、store 重写 -3），仅剩 1 个既有失败。
- 2026-09-16：全新安装场景已实测。空数据目录下 `POST /api/local-sessions/auto` 直接自举出「本机用户」（无 pinSalt/pinHash）；并用 `--user-data-dir=/tmp` 起了一个全新 profile 的 Electron —— 那条例用户记录**由渲染层自己写出**，说明它直接进了主界面而没有停在「创建本地管理员」门上（门若还在，自动会话请求根本不会发出，用户表会是空的）。附带确认：换成 `/tmp` 后 `workspace-write` 权限就够，之前两次 Electron 需要 `danger-full-access` 完全是因为数据目录在 `~/Library/Application Support` 下。
- 2026-09-16：发现仓库开发数据 `storage/` 里 16 条任务的 `videoPath` 全部指向另一个检出 `/Users/mac/workspace/ai/codex/douyin`，原视频路由对它们正确返回 422（安全校验按预期生效）。要在仓库数据上验证该路由需先修正这些历史路径。

- 2026-09-16：实现「详情页能看原视频」。起因是用户反馈点进详情看不到视频：实测任务 `97db73e8`（马尾辫）`transcribe`/`clean` 已 succeeded、原视频已存在，但详情页只能播成片，**原视频只有一行文件路径文本**。改动：`video-output.ts` 抽出 `resolveContainedMp4`，让成片与原视频共用同一份根目录/扩展名/inode 校验（`job.videoPath` 是持久化绝对路径，校验若各写一份等于开放任意文件读取）；新增 `GET /api/jobs/:id/raw-video/stream`，复用既有 `sendResolvedVideo` 的 Range 实现；新增 `SourceVideoArtifact`（播放器 / 未下载引导 / 不可读三态）与详情页「原视频 | 成片」分段切换，默认侧为「有成片看成片，否则看原视频」。规格与计划见 `docs/superpowers/specs/2026-09-16-raw-video-playback-design.md`、`docs/superpowers/plans/2026-09-16-raw-video-playback.md`，提交 `f0a1846`。
- 2026-09-16：实现过程中发现**仓库开发数据 `storage/` 里 16 条任务的 `videoPath` 全部指向另一个检出 `/Users/mac/workspace/ai/codex/douyin`**，文件在那边存在但不在本次 storage 根内，因此新路由对它们正确地返回 422 `source_video_unreadable`。这是安全校验按预期生效，不是 bug；要在仓库数据上验证该路由，需要先把这些历史路径修正或改用 App 真实数据（`~/Library/Application Support/douyin-ai-video/storage`，其 62 条任务路径均在自己的根内）。

- 2026-09-16：修复走查发现的 P0 泄漏。创作者昵称兜底从英文 `Unknown User` 改为简体中文「未知用户」（新增 `src/lib/nickname.ts`，`user-page-crawler.ts` 5 处兜底收敛到该常量/normalizeNickname，注意其中 1 处在生成的 Playwright 子进程脚本里、无法 import）；`CollectionStore.readIndex()` 在读取边界归一化历史落盘值，**只治内存、不重写用户数据文件**（`storage/cache/collections-index.json` 里 3 条 `Unknown User` 原样保留）。渲染层新增 `renderer/src/utils/display.ts`：昵称、日期、时长三处兜底，`createTime=0` 显示「未知时间」而不再是 `1970/1/1`，`duration=0.119` 显示「未知时长」而不再是 `0:00`。已用仓库真实脏数据（awemeId `7670181536511533691`）与 `dist/` 产物双重验证。
- 2026-09-16：查明交接文档第 0 节「看不到 `cdp_*` 就是没新开会话」的判断**不成立**，两个插件的真实原因都不是会话新旧：`dsh-cdp-browser` 的 5 个工具声明的是 `output: { render }`，缺少 DSH 强制的 `output.schema`，`tools.register()` 直接抛 `JsonSchemaError`，而插件 `apply()` 把每个注册异常 `console.error` 吞掉 → 任何会话都永远挂不上；`@anionex/dsh-computer-use` 的渐进暴露门按**内容指纹**校验，而 `~/.agents/skills/computer-use`（Hermes 版同名 Skill）遮蔽了插件自带的 `computer-use` Skill，导致 `containsSkillContent()` 永不匹配、11 个 `computer_*` 工具不暴露，`computer_use_activate` 也拒绝执行（实测报错「load the computer-use Skill first」）。详见交接文档第 9 节。

- 2026-09-15：完成一轮前端 UI 走查（8 路由 × 3 视口），发现 `Unknown User` 硬编码兜底泄漏进合集页 H1、爬虫 `createTime=0`/`duration=0.119` 导致界面显示 1970/1/1 与 0:00、创作中心紫色实测 702 次 vs 蓝色 125 次（违背规格「紫=AI/Skill」）。**完整交接与新会话须知见 `docs/handoff-2026-09-15-ui-audit.md`。**
- 2026-09-15：为走查装入 `@anionex/dsh-computer-use@0.3.2` 与 `dsh-cdp-browser`（commit `caecd3bded2e`）；两者写入 `~/.dsh/profiles/web`，需宿主重启**且新开会话**才会挂载工具。
- 2026-09-15：确认 `src/server.ts` 的后端读仓库内 `storage/`，与 App 的 `~/.douyin-ai-video/storage` 不是同一份数据；Vite 只监听 IPv6 `[::1]:5173`；纯浏览器模式经 `electron-bridge.ts` polyfill 可用。

- 2026-07-10：桌面主线 ASR 收敛为内置 whisper.cpp + ggml-small；音频提取改为 16kHz 单声道 WAV，设置页移除 ASR provider/API Key 输入。
- 2026-07-10：`backend/` 与 `frontend/` Docker 栈标记为历史实现；当前维护主线是 Electron + Node 后端。
- 2026-07-10：主链路移除 PPT，改为“视频转录 → AI 洗稿 → 生成视频提示词 → HyperFrames 生成视频”；删除主后端 PPT 生成器、PPT 步骤/API/前端入口，并更新 README/AGENTS/CLAUDE/PROJECT_PLAN。
- 2026-07-02：接入本地 FunASR 作为第三种 ASR provider，设置页新增“本地 FunASR（中文推荐，无需 API Key）”；缺依赖时会在转录步骤返回明确安装提示。
- 2026-07-02：更新 README、AGENTS、CLAUDE 和工作日志，将项目文档同步到“手动分步执行 → 视频转录 → AI 洗稿 → PPT”主链路。
- 2026-06-29：集成 video-master 和 ppt-generator-skill，实现双路输出：AI 清洗后并行生成视频场景提示词和 PPT 内容；新增 `video-enhancer.ts`、`ppt-generator.ts` 模块；扩展 `ScriptAsset` 类型支持 `videoPrompts`、`enhancedScenes`、`pptContent`、`pptPath` 字段；新增 3 个 API 接口；前端工作台新增「视频提示词」和「PPT预览」标签页。
- 2026-05-28：修复前端打开后服务崩溃的问题，缺失的历史任务 JSON 现在返回 404，不再导致 Express 进程退出；服务已改用 `screen` 后台会话 `douyin-dev` 启动并验证首页 200。
- 2026-05-28：排查前端页面无法打开，确认原因是 `localhost:3100` 服务已停止；已重新执行 `npm run dev` 启动，`/health` 和首页 `/` 均验证通过。
- 2026-05-28：用抖音样本 `xKR5ata208I` 完成端到端测试，视频下载、音频抽取、DeepSeek 清洗和脚本生成均成功；当前未配置 ASR key，因此未生成转写。
- 2026-05-28：修正 AI 清洗产物的 `cleaningMode` 命名，DeepSeek 调用会记录为 `deepseek`，避免误显示为 `openai`。
- 2026-05-28：新增本地 `.env` 并配置 DeepSeek provider/key（不记录密钥内容）；服务入口已支持启动时加载 `.env`，`npm run check` 和 `/health` 验证通过。
- 2026-05-28：完成 DeepSeek/API key 安全检查，当前项目未发现真实 `sk-*` 密钥；`.env.example` 仅保留占位符，运行中的本项目开发服务也未检测到相关 key 环境变量。
- 2026-05-28：检查本机浏览器和自动化进程，未发现内部打开的抖音窗口；Chrome 中也没有 `douyin.com` / `iesdouyin.com` 标签页需要关闭。
- 2026-05-28：排查前端 `Failed to fetch` 报错，确认根因是本地后端当时未在 `http://localhost:3100` 监听；重新启动后 `POST /api/jobs` 已可正常返回 201。
- 2026-05-28：完成本地网页工作台验证，主页可直接返回 200，并能作为任务控制台使用。
- 2026-05-28：新增本地网页工作台，主页可直接创建任务并查看脚本、清洗、分享文案、页面信息和转写结果。
- 2026-05-28：自测确认在未配置 ASR key 的情况下，音频抽取后会跳过转写但不阻塞，任务仍能完成到 `scripted`。
- 2026-05-28：补齐 ASR 转写层，新增 `raw/transcripts`、任务转写字段和 `raw-transcript` 接口；无 ASR key 时会跳过转写，不阻塞后续流程。
- 2026-05-28：接入 `yt-dlp` 视频下载与 `ffmpeg` 音频抽取基础设施，新增媒体路径和失败提示字段，后续可直接接 ASR。
- 2026-05-28：把下载策略改成和 `douyin_ppt` 一致的“页面直链优先 + `yt-dlp` 兜底”，并修正了页面元数据的落盘路径。
- 2026-05-28：用同一条抖音样本重新自测，页面直链下载成功，`raw/videos/*.page.json` 也正常落盘。
- 2026-05-28：用你提供的抖音样本做了自测，确认在缺少 cookies 时会返回明确的下载提示，但任务仍可按分享文本 fallback 完成并记录 `downloadErrorMessage`。
- 2026-05-28：新增本地工作日志文件，作为后续任务的优先上下文入口。
- 2026-05-28：完成分享文本解析层，支持从抖音分享文案中提取链接、简介、标签和内容类型。
- 2026-05-28：完成脚本草稿生成层，能把解析结果整理成口播稿、封面标题和分镜结构。
- 2026-05-28：完成 AI 清洗层，先接入 OpenAI 兼容接口，后改为支持 DeepSeek provider；未配置 key 时自动回退规则版生成。
- 2026-05-28：将 AI 清洗层改为可配置 provider，默认支持 DeepSeek OpenAI-compatible 接口，缺少 key 时自动回退规则版生成。
- 2026-05-28：将 AI provider 默认切到 DeepSeek，并补充了 `.env.example`，方便直接填 key 调试。
- 2026-05-28：新增抖音网页提取层，记录重定向链、视频 ID 和页面挑战状态，并写入 `raw/page`；后续会让位给“视频下载 + ASR”主链路。
- 2026-05-28：搭建项目骨架，包含本地存储、任务模型、基础接口和 README 使用说明。

## 记录方式

- 只写结果，不写长过程。
- 每次新增一条或两条即可，优先写“改了什么”和“影响什么”。
- 如果某一步有风险或未完成，单独补一条“待确认”。
