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
- 已完成（2026-09-20）：**今日头条文章发布**端到端跑通 —— 只读侦察校准选择器 ✅、真机演练（填完不发布）✅、**真实发布成功一次**（用户核实「已成功发送到今日头条平台」）✅。可见的遗留只有一件：成功提示文案仍未录进 `successTexts`（因此「点到了但读不到判据」仍是常态，会如实记 `unconfirmed` 并提示去后台核实；下一次真机跑的 `autoPublish.message` 里会带上确认后的 URL 与可见文案，据此校准即可）
- 新增待办（2026-09-15）：合集封面 CDN 403、创作中心紫色滥用（P1）；`Unknown User`、`1970/1/1`、`0:00` 已于 2026-09-16 修复；详见 `docs/handoff-2026-09-15-ui-audit.md`

## 最近操作

- 2026-09-20：**🎉 真机首次成功发布到今日头条（用户确认「已成功发送到今日头条平台」）—— 这条通路端到端跑通了。**
  - 记录里看到的事实：`autoPublish.status = succeeded`；步骤含「进入发布页 → 填标题（28 字） → 粘正文（富文本） → 上传封面 → 关闭「同时发布微头条」 → **点击发布并确认**」；`verification = unconfirmed`（页面没有我们认识的 `successTexts`）；用户到头条后台核实确实已发出，随后点了「标记已发布」（任务状态才变 `published` + `publishedAt`）。**「机器只记已提交、是否真发出由人工核实」这条不变式在真机上完整走了一遍。**
  - 由此确认了两件事：① 确认页的**候选按钮文案命中了**（此前完全未知，属最大的未知项）；② 成功提示文案**不在**我们的候选里 → 「点到了但读不到判据」会成为常态，所以必须让这条路径**自带侦察证据**。
  - 改动（测试先行，+4 条）：
    ① `submitAndConfirm()` 现在**每次都带回 `postConfirm` 证据**（确认后的 URL、是否已离开发布页、页面可见文案的**头+尾**摘要——只留开头会把挂在 body 末尾的 toast 正好截掉，fixture 用例当场抓到这一点）；并写进 `autoPublish.message`。
    ② 新增纯函数 `hasLeftPublishPage(url)` 并明确它只是**旁证**：会话失效也会跳到登录页，**绝不拿它冒充 confirmed**。
    ③ fixture 新增 `?silent=1`（确认按钮存在、点了不给成功提示）——**精确复刻真机那一次**，让这条路径从此有回归用例。
    ④ 修掉服务层的双「但」：未确认时不再给 runner 的文案加「已提交，但」前缀（真机记录里是「已提交，但已点击发布，但…」）。
  - 真机遗留（已知即可）：成功提示文案仍未拿到 → 下次真机跑一次，`autoPublish.message` 里就会带上当时的 URL 与可见文案，照着补 `successTexts` 即可；在那之前 `unconfirmed` + 「先去后台核实」是**正确**行为，不是缺陷。

- 2026-09-20：**用户第二次真机提交又推进了一大步：标题 28 字 ✓、正文富文本 ✓、封面 ✓ 都过了，卡在「头条首发」**。
  - 报错原文：「「头条首发」在页面上是勾选状态，但本次并不需要勾选（可能是残留草稿）：已停在点「发布」之前」。
  - **拦住是对的**（绝不能带着用户没选的声明发出去），但**只检查不取消**不够：持久化 profile 会把上次草稿的勾选状态带回来，而取消勾选只是一次普通的、可逆的点击。修法照 `ensureWeitoutiaoUnchecked` 的范式：**已是未勾选就不点任何东西 → 是勾选就点一下取消 → 读回确认 → 取消不掉才 fail closed**（新错误码 `toutiao_page_first_publish_uncheck_failed`）。
  - 用例（+3，fixture 加了 `?firstPublishChecked=1`（预置勾选＝模拟残留草稿）与 `?lockFirstPublish=1`（点了没反应）两个开关）：预置勾选 → 必须取消并读回；取消不掉 → 报错且**一个按钮都没被点过**；本来就未勾选 → **不点任何东西**。
  - 顺带把「测试包不在待处理里」的惊魂查清：是我一条命令里 session 变量用错导致的误报，接口本身正常（`status=action` 有、`status=failed` 没有 —— 因为任务状态仍是 `ready`，这正是「机器绝不写 published/failed 到任务上」那条不变式的体现）。
  - 验证：`npm run check` 双端 0；`toutiao-page` + `toutiao-runner` 共 42 项全通过；`build:backend` + `build:electron` 已重编译并重启应用；登录态 ✅ 已登录（今天不学习明天就完蛋）。

- 2026-09-18：**给头条建了测试文章包 + 抓到第三处真机问题：`checkLogin` 假阴性（首次自检报「未登录」，几秒后再查同一份 profile 就是「已登录」）**。
  - 测试包：用唯一有已渲染成片的作品（`97db73e8…`「马尾辫」）走**创建向导的真实链路** —— AI 成文（`deepseek-v4-flash`，883 字、无兜底）+ 封面裁成 1280×720 + `article.html`（sha256 入包），包标题「头条发布测试包（可删除）」，文章标题「Ponytail：专治 AI 过度设计的开源 Skill」（28 字 ≤ 30）。包级预览接口 200、文案检查无违规、任务 `ready`、资产 `healthy`。
  - **假阴性**：应用刚启动时第一次 `POST /publishing/toutiao/verify` 返回 `loggedIn:false`，同一份 profile 几秒后再查就是 `已登录（今天不学习明天就完蛋）`。根因是 `checkLogin` 只读一次 URL 就下结论，而首页那次跳转还没落地。代价：发布会**被自己拦在**「头条号登录态已失效：请重新扫码」上，用户会去重扫一个其实好好的码。修法：`LOGIN_CHECK_ATTEMPTS = 2` —— 停在登录页要**再确认一次**才作数（重试只是给页面落地的机会，不放松判定）。用例先红后绿。
  - 顺带确认：包与登录态都就绪后，用户可以在发布中心「今日头条文章」渠道里直接提交。

- 2026-09-18：**用户真机首次提交头条，被我们自己拦下：「标题框里读回的内容与要发的标题不一致（读到 27 字、期望 28 字）」→ 查出并修掉两个问题（其中一个是既有 bug）**。
  - **① 既有 bug：`clearInput()` 的按键序列在 macOS 上根本清不掉输入框**。它同时按 `Meta+A` 与 `Control+A`：macOS 上 `Cmd+A` 是全选，而 **`Ctrl+A` 是 Emacs 的「移到行首」，会把选区塌缩掉**，紧随其后的 Backspace 于是什么也删不掉 —— 也就是说「先清空」一直形同虚设。真机探针三步确证：`Meta+A→Backspace` 读回 `""`；`Meta+A→Ctrl+A→Backspace` 读回原文 `"ABCDEFGHIJ"`；选中后 `insertText` 是**替换**选区。后果：头条恢复上次草稿时标题会变成「旧标题+新标题」的拼接（正是那段注释当初要防的事）；我给标题加「多次尝试」之后更直接变成**越写越长**（一次调用写 3 回 → 读回 112 字 = 28×4）。修法：按 `process.platform` 只按一个全选键 + **读回确认** + 三轮重试 + 原生 setter/`input` 事件兜底。
  - **② 标题写入会概率性丢一个字符**。真机探针连测 4 轮，旧的「纯逐字 `type`」有时 28/28、有时丢一个空格；换句话说用户那次不是必然失败，而是**竞态/输入法组合**这类偶发。修法：`fillTitle` 改成**尝试阶梯** —— 「整体插入（`keyboard.insertText`，单次事件、不走逐键竞态）→ 再来一次 → 逐字输入兜底」，每次写入后**先等 250ms 再读回**（受控输入可能稍后才把模型值写回 `.value`）。真机复测：`fillTitle` 4/4 通过。
  - **③ 报错升级为字符级差异**：以后读回不一致时会写「第 N 个字符起不同：读到“…”、期望“…”」或「第 N 个字符起少了/多了内容：…」，不再只报字数（那次只有字数，只能靠猜）。
  - 用例（+4，共 22 项页面用例全绿）：假页面按**症状**建模（不假装知道机制）——「写入丢一个空格一次」（真机那次）→ 必须重试后成功；「两种写法都丢」→ 必须报字符级差异；「标题框里已有旧草稿」→ 必须真清空、不拼接；「写入全无效」→ 失败且框里不堆叠。
  - 资料：探针脚本用完即删（`scripts/.tmp-probe-*.ts`），因为它会往真页填标题（会留下草稿）。

- 2026-09-18：**用户反馈「发布这一块不太喜欢，应该区分出抖音发布和今日头条发布」→ 发布中心加一级「渠道」分栏**（按惯例先写 spec/计划再测试先行）。
  - **渠道 = 内容类型的界面投影**：抖音图文 = `note`、今日头条文章 = `article`、视频人工交付 = `video`（三者本来就互斥，所以后端只加一个 `contentType` 过滤字段，不引入复合查询）。**状态语义仍只有服务端一份**，前端只传 `status`，不复刻「待处理/资产异常」的判定。
  - **顺手修掉一个既有毛病**：状态页签的数字原本是在**已按状态筛过**的列表上再数一遍 —— 于是「失败」在「待处理」视图里永远显示 0，数字看着像真的其实是局部量。现在计数来自**同一次加载里那次 `status=all`（不带渠道）**的请求：渠道页签得包数、状态页签得当前渠道内的完整计数。
  - 界面：三个渠道页签（带计数，选中态走 `aria-selected` 而不是只靠颜色）+ 每个渠道一行说明（抖音说 sau 引擎、头条说先去设置扫码登录、**视频明确写「不会自动上传」**）；单平台渠道**不显示平台下拉**（避免「选了头条却把列表筛空」）；空态按渠道给可照抄入口；渠道与状态两个页签都写进 URL（`?channel=`），互不冲掉。
  - 用例（先红后绿，+11）：store 的 `contentType` 过滤（含「不传时三种都回」的回归保护、垃圾桶在渠道内）；路由 `?contentType=article` 只回文章包、非法值 400；渲染层渠道归属/计数/垃圾桶口径/单平台下拉/空态入口；渠道页签组件的三个静态渲染用例。
  - 修掉的两处**我自己写错的断言**（如实记录）：`packageDetail` 助手默认没有 `contentType` → 按口径属视频渠道，我一开始按图文断言；被标资产异常的包其任务仍是 `ready`，按任务计数应为 2 而非 1。两处都是断言错、不是实现错。
  - 验证：`npm run check` 双端 0；真浏览器核对（见计划 Task 4 执行记录）。

- 2026-09-18：**用户截图反馈「设置 → 今日头条」点扫码登录/校验登录只报「发布服务暂时不可用」→ 挖出两处真问题（都是「把原因和指引一起吞掉」这一类）**。
  - **① 路由层错误边界漏登记头条错误类**：`publishing-routes.ts` 的错误边界只认 `Publishing*Error` / `SauRunnerError` / `VideoOutputError`，**一个头条错误类都没认**。于是「未找到浏览器」这类**带可照抄指引的 422**、以及登录态失效的 422 全部落进兜底 500「发布服务暂时不可用，请稍后重试」——用户手上只剩一句无从下手的话。更糟的是兜底分支当时**什么都不打**，所以真原因连日志都没有。已登记 `ToutiaoRunnerError` / `ToutiaoBrowserError` / `ToutiaoPageError` / `ToutiaoArticleError` / `ToutiaoMediaError`（各自带 `status` + `code`），并给兜底分支加一行 `console.error("[publishing] 未预期的错误:", error)`。
  - **② Playwright 启动失败没被包装**：`openToutiaoSession()` 只包了「浏览器解析」与「会话目录越界」，真正的 `launch()` 调用没包 → 原始异常（`launchPersistentContext: EPERM: operation not permitted, mkdir '<profileDir>'`）直接冒到路由层。现在任意启动异常都被包成 `ToutiaoRunnerError("toutiao_browser_unavailable", "头条浏览器启动失败：<原始原因>。可照抄的动作：…")`；`defaultLaunch()` 改为**自己 `mkdir(profileDir)`**，失败时报 `toutiao_profile_dir_unsafe` 并写出「是哪个目录、什么原因」。
  - **③ 顺手补上发布通路的最后一条缝**：`publishArticle()` 的第一行 `openSession()` 在它自己的 `try` 之外，而服务层只把 `ToutiaoRunnerError` 记成失败、其余原样抛出 → 那会变成 **500 + `autoPublish` 停在 `running`**（界面只显示「正在进行中」、按钮灰掉，直到 30 分钟僵死阈值）——正是文档里警告过的形态。现在服务层把**任何**异常都落成 `failed` 记录（非执行器错误带「头条发布过程中出现意外错误：<原因>」）。
  - **真原因（用户环境无关，是我这边的执行沙箱）**：日志显示 `EPERM: operation not permitted, mkdir '~/Library/Application Support/douyin-ai-video/storage/toutiao'` —— 我启动 Electron 的沙箱只允许写工作区，连我自己的 shell 建那个目录都是 `Operation not permitted`（已实测）。**用户自己跑 `npm run dev` 不受影响**；同一个代码路径在仓库 `storage/`（可写）下是真的通的：真浏览器里点「校验登录」返回 **已登录（今天不学习明天就完蛋）**。
  - **用例（全部先红后绿，共 +7）**：`toutiao runner errors surface with their own status, code and guidance`（422 + 错误码 + 指引原文）、`toutiao runner errors keep their per-code status (409 …)`、`toutiao publish: a launch failure is recorded as failed, never a 500 and never stuck running`、`toutiao publish: even an unexpected raw error becomes a failed record with its cause`、跑测试内的 3 条（启动异常被包装 / 头条错误不被二次包装 / 会话目录建不出来时报「不可写」并指出路径）。
  - 验证：`npm run check` 双端 0；`npm test` **738 项 / 736 通过 / 1 跳过 / 1 个既有失败**（`publishing-service.test.ts` 的 startup recovery，与本轮无关）；`build:backend` + `build:electron` 均已重编译（18:34）；应用内实测三个接口现在返回 **422 + 真原因 + 可照抄动作**（不再是「稍后重试」）。
  - 文档：`AGENTS.md` / `CLAUDE.md`（逐字节一致）新增三条 ⚠️（错误边界必须登记头条错误类 / 启动失败要带原因带动作 / 发布路径任何异常都要落成 failed）与故障排查第 8 条。

- 2026-09-18：**真浏览器里验收界面时抓到一个「界面根本走不通」的 bug：文章包的包级预览 500**。
  - 症状：发布中心里文章任务的动作按钮都在（提交到头条号 / 下载文章 HTML / 预览），但点「提交到头条号」时预览接口 `GET /api/publishing/packages/:id/preview` 返回 500，界面只显示「发布服务暂时不可用」。因为 `auto-publish` 的 `previewRevision` **只能由这个接口产出**（服务端约束），所以整个头条通路在界面上等于不可达。
  - 根因：`copyCheck()` 的第 5 个参数是个布尔值（原叫 `noteScope`），文章分支照着图文包传了 `true` → 走 `validateNoteCopy("toutiao")` → 抛「平台 toutiao 尚未接入图文发布」（`PUBLISH_NOTE_POLICIES` 里本来就只有抖音）。而 `PUBLISH_PLATFORMS.toutiao` **本身就是文章口径**（titleMax 30 / 正文 20000）。
  - 修法：参数改成 `copyPolicy: "platform" | "note"`（名字直说「用哪份政策」，不再像作用域），文章与视频走 `"platform"`、图文走 `"note"`；包级预览的正文改用新增的 `articleHtmlToBodyText()`（**带 `## ` 小标题标记**，与创建向导里看到的形态逐字一致）。
  - **测试为什么没拦住**：当时的文章用例直接读 store 里的 revision，把这条接口整个绕过去了。已补用例（先红后绿）：`article package preview returns the toutiao article checks instead of failing`，断言 200 + 文案检查用头条文章口径 + `preview.previewRevision` 等于 store 里那个（即 auto-publish 认的那个）。
  - 另记一条 dev-only 噪声（**不是 bug、也不改**）：打开预览弹窗时 React 19 **development** 构建会报 `Internal React error: Expected static flag was missing.`——同一子槽位在两次渲染里换成另一种节点（图文包的 span→img、文章包的封面 p→img）就会报，**图文包预览同样会报**，与头条改动无关；生产构建没有这段检查。顺手把弹窗早退的 `return ''` 改成 `null`（空串是文本节点，语义不对），并在代码里注明它**不负责**消掉那条告警，免得后人误判。
  - 验证：`npm run check` 双端 0；`npm test` 731 项 / 729 通过 / 1 跳过 / 1 个既有失败（`publishing-service.test.ts` 的 startup recovery，非本轮引入）；`build:backend` 与 `build:electron` 均已重编译（17:56）。真浏览器逐项核对：文章任务卡四个动作、publish 模式预览弹窗（封面 naturalWidth>0、正文带 `##`、首发否 / 声明 / 微头条否、确认按钮「确认发布到今日头条」**只断言不点击**）、设置页「校验登录」返回真实结果 **已登录（今天不学习明天就完蛋）**。
  - 已停掉临时隔离实例（3100），并按用户要求把应用重新起来：`npm run dev`（Vite 5173 + Electron）。
  - **临时联调数据（只在开发后端可见，不进 Electron 应用）**：仓库 `storage/` 里有两条我造的假发布包 ——
    `ttarticlev1`（头条文章包，目录 `storage/output/publishing/dev-note-demo/v1-ttarticlev1/`）与
    `devnotev1`（图文包）。它们的用途是「不依赖真实成片也能在界面上看到文章卡片与预览弹窗」
    （文章包仍要求作品有已渲染成片，所以真机上建第一个包必须挑一个有视频的作品）。不要了直接在发布中心删掉即可。
  - **Electron 的登录态是独立的**：应用用 `~/Library/Application Support/douyin-ai-video/storage`，
    而侦察/演练用的扫码会话在仓库 `storage/toutiao/profile`。因此应用里第一次发文章需要重新扫一次码
    （设置 → 今日头条），这是设计如此（头条登录态就是那份 profile）。
  - 文档同步：`AGENTS.md` / `CLAUDE.md`（`cmp` 校验逐字节一致）、`README.md`（功能特性、发布中心说明、
    `TOUTIAO_*` 与浏览器依赖、设置页、故障排查、路线图）、本文件与计划文件的执行记录。
  - 收尾全量验证（18:11）：`npm run check` 双端 0；`npm test` 731 / 729 通过 / 1 跳过 / 1 个既有失败；
    `build:backend` 与 `build:electron` 均成功；应用仍健康（Vite 5173、Electron 35824、内嵌后端 64781
    自动会话返回管理员 `lcz`）、隔离端口 3100/3198 已释放、0 个孤儿浏览器。

- 2026-09-18：**为「最后一下真实发布」做准备（用户选择自己执行那一步）**。
  - **让失败信息自带侦察能力**：确认页的真实按钮文案无法用只读手段拿到（点进去就等于发布），所以 `submitAndConfirm` 在**找不到确认按钮**时，会把**当时页面上所有可见按钮的文案**（最多 12 个）带进失败信息。于是用户跑一次真实发布的结果是二选一：要么成功；要么把真实文案带回来，我照着补进 `confirmButtons` 与用例 —— **不必再靠猜**。用例断言了这一点（`可见按钮是：` + 页面上的按钮文案）。
  - **写了人工发布的执行清单**（计划 Task 8 Step 5）：发布前检查、三种结果（`confirmed` / `unconfirmed` / 「没有找到确认按钮」）各自该做什么、发布后必须一起核对的三个字段（`task.status` 仍为 `ready`、`publishedAt` 为空、`autoPublish.status`），以及「任何重试前先确认上一次是否已发出」。
  - **给暂停中的公众号计划加了「恢复前必读」对照表**（8 条既成事实：`AUTO_PUBLISH_ROUTES` 怎么加、service 的 article 分支目前只接受 toutiao 要怎么抽层、`verifyPackageHealth` 别回退、创建阶段指纹不绑 AI 草稿、渲染层文案不许写死平台…），避免它恢复时与头条这轮撞车或重复造轮子。
  - 验证：`npm run check` 双端 0；相关用例（真浏览器）逐条通过。

- 2026-09-18：**给暂停中的「微信公众号 AI 文章发布」计划加了一段「恢复前必读」**。原因：那一轮暂停时 `article` 内容类型只有类型与打包层、**没有任何调用方**；而头条这一轮把它做成了真实通路，两边会撞车。已把 8 条既成事实写成对照表（路由表 `AUTO_PUBLISH_ROUTES` 怎么加、service 的 article 分支目前只接受 toutiao 要怎么抽层、`verifyPackageHealth` 别回退、创建阶段指纹不绑 AI 草稿、渲染层文案不许写死平台…），恢复时照表接上即可，不必重新推理。

- 2026-09-18：**真机「填完但不发布」演练（用户授权）→ 又抓到 3 个只有真页才会暴露的 bug**。为此给执行器加了 `dryRun` 模式与脚本 `--dry-run`：真实页面上把每一步都做完、**绝不点「发布」**，唯一副作用是头条自动存一条草稿（已获用户同意）。
  - **第 1 次演练结果**：进入发布页 ✅、填标题（26 字，含「读回必须等于要发的标题」）✅、粘正文（富文本，含首尾段落落地校验）✅、**上传封面 ❌** —— 安全失败（停在点发布之前，并写清已完成到哪一步），但功能不可用。
  - **只用只读手段定位到两个真 bug**：① 点封面加号用了 `force: true`，而**加号常在折叠线以下**（实测 rect y=881、视口 900），force 跳过「滚动进视口/确认未被遮挡」→ 点击落在别处、抽屉压根不开；不加 force 就能正常打开（`elementFromPoint` 还返回 null，说明它确实在视口外）。② 点开抽屉后全页有**两个** `input[type=file]`（本地上传 + 扫码上传），裸选择器在严格模式下多匹配直接抛错。顺带拿到抽屉的真实结构：`byte-drawer primary-drawer mp-ic-img-drawer`，页签「上传图片 / 免费正版图片 / 热点图库 / 我的素材 / **本地上传** / 扫码上传」，底部「确定」。
  - **修法**：加号改用普通 `click`（点不动就明确报错，不许假装点过）；上传走「点『本地上传』→ 接原生 `filechooser` 事件 → 拿不到再退回**抽屉内限定**的文件框（`>> nth=0`）」；传完**关掉抽屉**（否则挡住发布按钮）。fixture 也按真实抽屉结构重建（含两个文件框）。
  - **第 3 个 bug（由修好后的用例立刻抓到）**：`confirmButtons` 里的泛化「**确定**」命中了**封面抽屉的确定按钮** → 把「点到了别处的确定」误判成「已确认发布」（评审早就预判过这条风险）。已把「确定」从确认候选里删掉，只留「确认发布/发布」。
  - **第 2 次演练结果**：**全流程通过** —— 进入发布页 → 填标题 → 粘正文（富文本）→ 上传封面 → 设置作品声明（1 条）→ 关闭「同时发布微头条」→ 停在点「发布」之前（未提交）。**至此除了最后那一下「确认发布」，整条真机链路都验证过了。**
  - 验证：`npm run check` 双端 0；`npm test` **728 项 / 726 通过 / 1 跳过 / 1 既有失败**；真机演练两次（第一次暴露 bug、第二次全绿）。

- 2026-09-18：**独立代码评审（两个子代理，只读）→ 按严重度修掉 4 个 HIGH + 多个 MEDIUM/LOW**。这一轮价值很高：评审抓到了几个**我自己测出来也发现不了**的问题。
  - **H1 会让发布中心整页崩**：`PublishPreviewDialog` 里我把新 hook `useArticleCover` 放在了 early return **之后**，而该弹窗在发布中心是**常驻挂载**的（先 open=false 渲染、再 open=true）→ React 直接抛「Rendered more hooks than during the previous render」，本项目又没有 ErrorBoundary。已把 hook 提到所有 return 之前（并写明原因）。**静态渲染用例抓不到这类问题**，因为每次都是新 dispatcher。
  - **H2 「标记已发布」对文章包永远做不了**：`markPublished` 用 `verifyPackageVideo` 体检，文章包没有 `video.mp4` → 一律 `broken_video` → 写坏健康值并抛 422；而坏健康值还会让「提交到头条号」动作一起消失（要重启才自愈）。已改用按内容类型分派的 `verifyPackageHealth`（`verifyPackage` 同样修正）。
  - **H3 界面允许编辑，但一编辑必然 409**：创建阶段的 `previewRevision` 把**服务端 AI 草稿**绑进了指纹，而创建时正文是**用户编辑过的文本** → 永远对不上，报错还说「源内容自预览后发生变化」（把自己的输入说成源变了）。已把创建指纹收敛成「源 + 封面选择」；真正防「预览后内容被改」的是**包级** `packagePreviewRevision`（覆盖 `articleCopy.title` + `htmlSha256` + 封面 + 三个选项），那道闸门没动。补了「预览 → 编辑 → 创建成功」的回归用例。
  - **H4 打包后假 ffmpeg 会找不到**：封面裁剪默认走 PATH 里的 `ffmpeg`，而安装包里的 ffmpeg 在 `resources/bin`（不在 PATH）→ 只有开发机能用。已在 `app.ts` 注入 `config.ffmpegBinary`（正是 AGENTS.md 里那类「两套产物/两种环境」事故）。
  - **M1/M7 缺浏览器时的失败路径是坏体验**：Playwright 缓存层**无条件**报 ok → `assertConfigured()` 通过 → 真失败发生在 launch（原始错误 → 500），且 `autoPublish` 卡在 `running` 到 30 分钟僵死阈值。已改为**真的探测**缓存 + 发布流程里任何异常都收敛成 `ok:false`（记录一定落到 `failed`）。
  - **安全/诚实性**：① 「确认发布」点击必须读回 —— 只点「预览并发布」而没点到确认，事实上什么都没发，以前的实现照样写「已点击发布」+ `succeeded`（评审用仓库自己的 fixture 就复现了）；现在 `confirmClicked=false` 时返回 `ok:false` 并明说没提交任何内容，两种形态各有一条真浏览器用例。② 勾选框读回只看**拥有 checkbox 的元素**（「同时发布微头条」的说明 div 没有 checkbox，误判成命中会得出「已勾选否」而带着平台默认勾选发出去——评审实测复现）。③ 标题先清空再输入并断言**读回等于要发的标题**（持久化 profile 会恢复草稿，直接 type 会拼成「旧标题+新标题」）。④ 声明/首发/封面模式都补了读回。⑤ 退出清理（`installExitCleanup`）、`startLogin` 的并发竞态、`article.html` 加 `nosniff`、空正文在创建阶段就拒、正文长度守卫改按**文本**计数（以前按 HTML 计，100 段会被误判超限）、`isLoginUrl` 收敛成一份（页面模块以前漏 SSO 分支）、`toutiaoOptions` 补存档形状校验、删掉两份「文档里有、代码里没人读」的死字段。
  - **如实记录两条限制**（写进 spec §3.4a/§3.4b）：① 创建阶段指纹刻意不绑 AI 草稿（否则「可编辑」=「必然 409」）；② 包级指纹绑定的是封面的**存在性与文件名**，不是字节（换封面文件不会让 revision 失效；彻底收紧要在包记录里加 `coverSha256`）。
  - **又踩两次同一类坑**（都是我自己的注释/变量名）：页面侧代码是模板字符串下发的，注释里写**反引号**会把字符串截断；`pageExpression` 的参数就叫 `input`，页面代码里再 `const input` 是 SyntaxError。两条都写进了文件头与 helper 的注释。
  - 验证：`npm run check` 双端 0；`npm test` **723 → 728 项 / 726 通过 / 1 跳过 / 1 既有失败**；`build:backend` + **`build:electron`** 都通过（顺带修掉评审指出的 `dist-electron` 陈旧：现在 `grep -c TOUTIAO dist-electron/server.js` 为 2）。

- 2026-09-18：**补课两处：`publishArticle` 编排用例（计划 Task 4 Step 4 漏项）+ 封面文件框的真机形态**。
  - 先查覆盖率发现 **`publishArticle` 零用例**（13 条 runner 用例全是登录/窗口登录）。补了 5 条，用**真浏览器 + fixture**（而不是字符串匹配的假页面 —— 页面侧代码是字符串下发的，假页面只能猜字符串，那种测试会掩盖真问题）：正常路径（步骤逐条记录、`bodyMode: "rich"`、拿不到判据 → `unconfirmed` 且文案要求去后台核实）、登录态失效（一步都不做）、关不掉微头条（**一个按钮都没点**）、封面文件缺失（停在发布前）、勾选首发+声明后仍关掉微头条。fixture 补了 `?lockWeitoutiao=1`：runner 流程里会再 `goto` 一次，靠在 DOM 上打标记会被重载清掉（第一次就是这么失败的）。
  - **本轮最要紧的一处真机形态差异**：新增 `--cover-drawer` 只读探针（只点开加号看一眼，**不选文件、不上传**），实测**点完加号后 `input[type=file]` 计数仍然是 0、也没有任何抽屉节点** —— 真页是「临时造一个 input → 触发原生文件选择框 → 随即移除」。我原来的 `uploadCover()` 只等 DOM 里的文件框，**在真机上必然失败**（报「没等到文件框」并停在发布前：不会发错内容，但功能不可用）。已改为**优先接 Playwright 的 `filechooser` 事件**、拿不到再退回 `setInputFiles`；fixture 增加 `?cover=chooser` 复刻该形态，两条路各有一条真浏览器用例。
  - 验证：`npm run check` 双端 0；`npm test` **717 → 722 项 / 720 通过 / 1 跳过 / 1 既有失败**；`build:backend` 通过。

- 2026-09-18：**只读侦察完成 + 选择器按真实页面校准 + 页面步骤真浏览器用例全绿（11/11）**。用户扫码登录后我立刻跑了侦察，拿到铁证并据此重写了 `toutiao-page.ts`。
  - **实测证据**（`storage/toutiao/recon/publish-page.html` 874KB + `selectors.json`）：标题框 `textarea[placeholder*="标题"]`，placeholder 原文就是「**请输入文章标题（2～30个字）**」（平台自己写明 2~30 字）；正文编辑器是 **`.ProseMirror`**；**富文本粘贴实测有效**（探针派发 `ClipboardEvent` 后读回有内容）→ spec 风险表里的 ② 消除；「头条首发」默认**未**勾选；而「**发布得更多收益**」那只 `LABEL.byte-checkbox` 默认**带 `byte-checkbox-checked`** → **平台默认确实会连带发微头条**，fail-closed 设计站得住；作品声明的 7 个文案与页面上**逐字一致**；发布按钮是 `publish-btn publish-btn-last`「预览并发布」，页面上**没有**「发布」按钮（确认在预览页里）。
  - **封面真相**：真页初始**没有** `input[type=file]`（`type="file"` 全页 0 处），必须点 `.article-cover-add`（那个加号）才现造出来；模式是 `单图(默认 checked)/三图/无封面`；上传成功后出现 `.article-cover-img-wrap img`。`uploadCover()` 已按这个顺序重写。
  - **离线 fixture 从快照逐段抠出来**（`src/lib/fixtures/toutiao-publish-page.html`），页面步骤用**真浏览器**跑 11 项用例：标题读写回、富文本粘贴→rich、编辑器吃不下粘贴→逐段输入→plain、封面（点加号→文件框出现→文件送达→读回到图）、封面加号缺失→明确报错、微头条默认勾选→关掉并读回、**关不掉→抛错且一个按钮都没被点过**（fail closed）、首发勾选读回、声明逐条点选+文案对不上报错、提交后拿不到判据→`signal` 为空串（**绝不谎报 confirmed**）。
  - **这轮用例抓到 3 个真问题**：① **点外层 div 不会切换复选框** —— `div.exclusive-checkbox-wraper` 的文本也是「头条首发」且在文档序里排在 LABEL 前面，「按第一个文案命中」会点到它；新增 `clickCheckboxByText()` **优先点拥有 checkbox 的 LABEL**（真页同一结构，这个坑在真机上会表现为「以为勾上了其实没勾」）。② **「头条首发」勾完缺读回确认**，已补（勾不上就停在发布前）。③ tsx 的 `__name` 助手会让 `page.evaluate(内联函数)` 在页面里直接 `ReferenceError`（实测 `collect()` 报错）→ 页面侧代码一律改用**字符串**下发（`dist/` 由 tsc 编译不受影响，所以这个坑只在 tsx 下出现，脚本与测试都跑 tsx）。顺带把 `readQrDataUrl`/`readUsername` 一起字符串化。
  - 验证：`npm run check` 双端 0；`npm test` **706 → 717 项 / 715 通过 / 1 跳过 / 1 既有失败**；`build:backend` 通过。
  - **仍未验证的一处（刻意）**：点「预览并发布」之后的确认页与成功提示文案 —— 点进去就等于发布，只读侦察不做。`submitAndConfirm()` 因此给候选文案 + 结果读回，拿不到判据就记 `unconfirmed` 并提示去后台核实。这只剩「第一次真实发布」能验，且那一步按设计由人工执行。

- 2026-09-18：**编译产物真机隔离验证**（计划 Task 8 Step 3）：用 `dist/server.js` 在 3198 起隔离实例（**没碰用户的 3100 与 Electron**），6 个新路由**未认证全部 401（而不是 404，说明真的挂上了）**、`/health` 正常；建真会话后打文章预览接口，发现并如实记录一条限制：**文章预览仍走共用取数入口 `readSourceContext()`，因此要求任务有已渲染的成片**（否则 `publish_video_missing`）。发布中心其余通路本来就要求成片、界面入口也统一把关，所以 v1 先接受这条限制；将来要解耦的正确做法（单独取数 + 独立的 `sourceContextHash` 变体，**别动共用那条**，否则既有精确哈希 baseline 会立刻失败）已写进 spec §3.4。验证完已停掉隔离实例。
  - 另：`scripts/probe-toutiao-publish-page.ts` 的函数体在这一轮被我手工搬移时搬重了，已整段重写干净（`--login` 分支提前到无头诊断之前，避免打印误导人的解析链）。

- 2026-09-18：**按用户建议补上「打开浏览器窗口扫码登录」**（复用抖音 `/api/douyin/qr-login` 那套交互），并把侦察脚本做成 `--login` 一步到位。
  - 起因：我原来只做了「无头取二维码 → 让人扫终端里的图」，用户指出不如直接照抖音那样开个浏览器窗口扫码。**照做之后确实更顺**：登录一次，`storage/toutiao/profile` 里就有会话，之后的只读侦察与发布都不用再扫。
  - 实现：`toutiao-browser.ts` 新增**有头解析链**（显式配置 → env → **系统 Chrome** → Playwright 完整 chromium），**刻意跳过打包的 `chrome-headless-shell`**（无头专用构建，开不了窗口）；`ToutiaoRunner.loginInWindow()` 同步等待扫码（默认 180 秒，poll 2 秒），`finally` 必关窗口；服务/路由 `POST /api/publishing/toutiao/login/window`（先取消应用内会话，避免同时开两个浏览器）；界面加「打开浏览器扫码登录」按钮与「等待扫码中…」状态。
  - **测试又抓到两个真 bug**：① **资产锁重入死锁** —— 我在 `verifyPackageHealthUnlocked`（已持锁）里调了会再次取同一把进程锁的 `readPackageCover`，表现是**整条请求挂住**（不是报错）；已拆出 `readPackageCoverUnlocked` 并写进注释。② `article` 包的体检此前只能靠 `verifyPackageVideo`（名字是历史遗留）才走到分派分支，公开入口没有分派版；已补 `verifyPackageHealth()`。两个 bug 都是「新增分支」带出来的，各补了用例。
  - 另一个测试侧的坑：同一个临时 storage 里用固定 `packageId` 建两次包会撞目录（`COPYFILE_EXCL`）→ 拆成独立夹具。
  - 验证：`npm run check` 双端 0；`npm test` **683 → 706 项 / 704 通过 / 1 跳过 / 1 既有失败**；`build:backend` 通过。

- 2026-09-18：**新业务「今日头条 AI 文章发布」立项并完成主体实现（后端全链路 + 渲染层关键部分）**。先给难度结论，再按惯例写 spec/计划，然后测试先行实现。**唯一卡住的一步需要你配合**：登录后的真实发布页 DOM 侦察（`scripts/probe-toutiao-publish-page.ts`，只读、不发布）—— 我起了两次扫码窗口都过期了，选择器必须靠那次的证据才能定。
  - **难度结论：中（明显低于抖音图文那套）**。参考项目 `mf-yang/toutiao-ops` 全仓 4089 行，**与文章发布有关的只有约 830 行**；它的三个坑是 ① 封面/声明/合集/微头条全部 `try{}catch{}` 吞异常，**封面上传失败也返回「发布成功」**；② 点「确认发布」是 `.catch(()=>{})`，**不校验作品是否真的存在**；③ `playwright: ^1.50.0` 实测浮到 1.63.0，要自己再下约 500MB 浏览器。证据与实测命令全部记在 `docs/research/toutiao-ops-assessment.md`。
  - **关键实测（决定架构，全是自己跑出来的）**：我们自己的 `playwright@1.62.1` **本机没有可用浏览器**（要 `chromium_headless_shell-1234`，缓存里只有 patchright 的 1208），但**打包资源里已有 `chrome-headless-shell 152.0.7928.2`**，实测 `launch({ executablePath })` **成功打开真实头条登录页**；未登录时首页与发布页**都 302 到 `/auth/page/login?redirect_url=…`**（登录态有干净契约）；**二维码直接从 DOM 取**（`data:image/png;base64,…` 512×512，已落盘肉眼核对）。→ 结论：**自研 runner + 复用已打包浏览器，零新依赖、零额外下载、不需要有头窗口**（用户确认走这条路线）。
  - **已完成（测试先行，全绿）**：`npm run check` 双端 0；`npm test` 基线 **608 → 677 项 / 675 通过 / 1 跳过 / 1 既有失败**（+69，无新增失败）。新增模块：`article-draft.ts`（平台中立文章内核）、`toutiao-article.ts`、`toutiao-media.ts`、`toutiao-browser.ts`、`toutiao-page.ts`、`toutiao-runner.ts`、`scripts/probe-toutiao-publish-page.ts`；平台接入：`PublishPlatform` 加 `toutiao`、**7 处清单**（含路由 `contentType()` 此前明确拒绝 `article`）、`packagePreviewRevision` 补 **article 分支**（此前 article 落 else、只哈希 `videoSha256`，**正文/封面/选项改了指纹不变** —— 那是「必经预览」的漏洞）、两处 note 硬闸收敛成 `AUTO_PUBLISH_ROUTES` **(内容类型 × 平台) 路由表**；服务/路由：文章预览与建包、`GET /packages/:id/article` 降级通路、4 个头条登录/自检路由、提交前比对包内 HTML 的 sha256；渲染层：平台表新行、article 预览分支（标题/正文纯文本/选项）、「下载文章 HTML」动作、设置页**应用内扫码登录面板**。
  - **共用内核的取舍**：`wechat-article.ts` 改成薄封装（委托 `article-draft.ts`），**既有 50 个用例逐字通过**（含提示词里 32/120/20000 的断言）—— 这是本次重构的回归门禁。**但计划里的 `article-html.ts` 没有抽**：头条正文由**结构化草稿**渲染、根本不接收任意 HTML，所以不需要 wechat 那套 sanitizer；共享它只会把一个不需要的锚点/图片白名单策略搬进来。这条偏离与理由已写进计划 Task 2。
  - **真实 ffmpeg 实测（stub 证明不了滤镜语法）**：真实 1080×1920 静帧 539KB → **mjpeg 1280×720、47.7KB**，源文件 sha256 前后一致。
  - **写测试时踩到并修掉的一个真坑（值得记）**：夹具把执行器注入到了**错误的配置键**（写成 `toutiao`，`ServerConfig` 里叫 `toutiaoRunner`），于是测试里构造的是**真执行器**：它**真的启动了一个无头浏览器**去开头条登录页，并让那条用例挂到超时；事后 `pgrep` 抓到 5 个残留进程（正是本项目记过的「孤儿浏览器」）。已按 profile 目录特征清理干净，并在测试里补了注释说明注入键必须与 `ServerConfig` 一致。**教训：「测试没联网」这件事要靠注入键正确来保证，光看测试名不算。**
  - **未完成 / 待办**：① **只读侦察**（需要你扫码一次）→ 拿到真实发布页 DOM 后才校准 `toutiao-page.ts` 的选择器并写 fixture 用例（当前选择器来自参考流程 + 字节系编辑器常见写法，**未经真实页面验证**，猜错会明确报错并停在点发布之前）；② 渲染层已完成（含创建向导与详情页入口）；③ 真实发布一次（人工执行，且重试前必须先核实上一次是否已发出）。
  - **未提交**：工作区里仍有上一轮（素材库 Task 3 / 公众号）未提交的改动；本次同样**没有做任何 git 提交**。

- 2026-09-18：**⏸ 暂停「微信公众号 AI 文章发布」—— 用户要先去完成公众号认证，认证成功后再继续**。停在 **Task 5b 完成之后**、Task 6（服务编排与路由）**尚未开始**（本轮只做了只读排查，**没有留下半成品改动**）。
  - **已完成且已验证**：Task 1（客户端 + 账号自检探针）、Task 2（微信兼容 HTML 渲染）、Task 3（AI 成文 + 兜底）、Task 4（图片处理）、Task 5a（平台接入与清单守卫）、Task 5b（`article` 包模型与打包）。最后一次全量验证：`npm run check` 双端 0，`npm test` **608 项 / 606 通过 / 1 跳过 / 1 既有失败**（唯一失败是 `publishing-service.test.ts` 那条既有基线，与本次改动无关）；另有真实 ffmpeg 实测（封面 900×383、竖屏限长边 608×1080）与假微信 API 四模式探针实测（四种失败文案互不相同、无凭据泄露）。
  - **剩下的**：**Task 6**（服务编排与路由：`POST /api/publishing/wechat/verify`、按 `contentType` 分派既有 `auto-publish`、`GET /api/publishing/packages/:id/article` 降级通路、`wechatMp` 配置注入与 env 透传）、**Task 7**（渲染层：设置页配置 + 校验连接 + 创建文章包向导 + 发布中心动作）、**Task 8**（全量验证、编译、人工复核）。计划文件里 25 个 step 已勾选、19 个待做。
  - **恢复时的第一步（用户侧，零副作用）**：认证通过后跑一次账号自检探针，确认草稿箱接口真的可用 —— 它只换一次 token 并调 `draft/count`，**不建草稿、不上传任何东西**：
    ```bash
    cd <repo> && WECHAT_MP_APP_ID=... WECHAT_MP_APP_SECRET=... \
      node --import tsx scripts/verify-wechat-mp.ts
    ```
    三种结论都已有对应路径：全绿 → 按计划继续；`48001`（无权限）→ §15 降级通路成为主通路，其余照做；`40164`/`61004` → 脚本会回显公网 IP，照抄进「微信开发者平台 → 我的业务 → 公众号 → 开发密钥 → API IP 白名单」。
  - **认证后的预期**（写在这里免得恢复时重新推理）：认证会让 `freepublish/*`（真发布/群发）**变得可用**，但**本设计刻意不用它** —— spec §2/§11 明确「只建草稿，绝不调用发布接口」，最终发布由人工在公众号后台点。所以认证**不会改变架构**，只是让草稿箱权限更确定。
  - **没有做过任何 git 提交**：工作区里同时存在**上一个会话（素材库 Task 3）未提交的改动**（`src/app.ts`、`src/app.test.ts`、`renderer/src/components/CreateNotePackageDialog.*` 等）与本次公众号特性的新增文件，两者都还没提交 —— 提交与否仍待用户决定（`docs/superpowers/plans/2026-09-17-asset-library.md` 里记的「Step 4（提交）待用户决定」仍然有效）。

- 2026-09-18：**「微信公众号 AI 文章发布」Task 5b 完成 —— `article` 包模型与打包（`createArticlePackageAssets` / `stageArticleContent`）**。新增 6 个占位符用例 + 7 个打包用例，全绿；`npm run check` 双端 0；全量 `npm test` **595 → 608 项 / 606 通过 / 1 跳过 / 1 既有失败**（+13，无新增失败）。
  - **存量兼容门禁如期通过**：`publishing-assets.test.ts` 里那条**逐字节固定视频包 manifest**（含精确哈希基线）的用例**本来就存在**，不需要新写 —— 它就是「图文/文章打包不得改动视频包」的现成闸门，本次改动后仍通过。
  - **🔴 补上计划漏掉的一环：正文图片占位符机制**。计划只在 Task 6 写了「替换 HTML 内 src」，没说替换什么；而**微信正文图只能是 `uploadimg` 返回的 mmbiz URL，该 URL 只有提交时才拿得到**，所以包里的 `article.html` 必须先存占位符。定下的契约：`WechatArticleImage` 变成联合类型 `{url}`（已知最终地址）与 `{slot:n}`（打包阶段，渲染成 `src="{{wechat-image-N}}"`）；`substituteWechatImageSlots(html, urlBySlot)` 在提交时替换，三条硬要求各有用例：**① 占位符一个都不许剩**（漏替换＝全裂图且接口不报错）、**② 只接受 mmbiz 托管地址**、**③ 替换后仍要满足 2 万字符上限**。
  - **新用例抓到 1 个真 bug**：`stageArticleContent` 把封面的**暂存目录路径**当结果返回，而提升后该路径已不存在 —— 改为「暂存只带 `stagedCoverPath` 标志、对外用 `path.join(staged.packagePath, "cover.jpg")` 换算」，与视频封面同一口径。
  - **一处消重重构**：`copyNoteImages` 提取成共用的 `copyOrderedImages`，图文包与文章包共用（按序复制 + 逐张 sha256 校验 + 顺序敏感清单哈希完全一致），避免把「复制后必须校验」这条纪律拆成两处。
  - **计划外加一条守卫**：`assertArticleImageCoverage()` —— 正文有 `{{wechat-image-N}}` 却没对应图片时**在打包阶段拦掉**（`publish_images_missing`），否则该包**永远提交不了**、只会在提交那刻失败。**注意「一张图都没有」本身合法**（文章内容是文字），故文章包 0 图不报错也不标 `missing_images`（与图文包刻意不同：图文包的图片就是内容本身）。
  - **打包层不转码**：正文图/封面必须是 `wechat-media` 已处理过的产物（jpg、<1MB、2.35:1），打包只做复制+哈希+校验 —— ffmpeg 不该出现在这个安全加固过的复制事务里（打包用例注入的 `runCommand` 会直接抛错，专门守住这点）。

- 2026-09-18：**「微信公众号 AI 文章发布」Task 5a 完成 —— 平台接入（`PublishPlatform` 加 `wechat_mp`）与「静默点」守卫**。新增 5 个后端用例 + 2 个渲染层用例，全绿；`npm run check` 双端 0；全量 `npm test` **588 → 595 项 / 593 通过 / 1 跳过 / 1 既有失败**（+7，无新增失败）。
  - **原 Task 5 太大，执行时拆成两半**：5a 只碰枚举与清单（编译器 + 守卫用例能兜住），5b 才动 1957 行、安全加固过的 `publishing-assets.ts` 打包事务 —— 两者风险等级完全不同，混在一次改动里出问题不好定位。
  - **守卫写法比原计划更省更狠**：原计划是「5 个静默点各写一条断言」，实际改成**断言所有清单彼此一致** —— 以 `PUBLISH_PLATFORMS` 的键（`Record<PublishPlatform, …>`，编译器唯一能兜住的真源）为基准，要求 `APPROVED_PLATFORMS`、路由 `PLATFORMS`、`SUPPORTED_PLATFORMS` 与之**集合完全相等**。**将来再加平台时，漏掉任何一份清单都会自动被抓到**，不必再补断言。为此把这几份集合导出（只是数据，成本为零），每处注释都写明「为什么导出」。
  - `NOTE_PLATFORMS` 单列一条：**严格子集且断言不含 `wechat_mp`** —— 公众号走 article 通路，塞进图文闸门会拿「标题 20 / 正文 1000」的口径去校验公众号文章。`isPlatform`（存档校验）也逐个平台断言：**漏一个的后果是静默的**（该平台任务读回索引时被悄悄丢掉，而不是报错）。
  - 渲染层是独立 TS 工程（`tsconfig.renderer.json` 只 include `renderer/src`），`src` 测试覆盖不到它的平台表，故在 `renderer/src/utils/publishing.test.ts` 补 2 条（清单一一对应 + 口径与后端一致）。
  - 既有那条**穷尽式**断言 `assert.deepEqual(PUBLISH_PLATFORMS, {…4 个平台})` 如期被打破 —— 这正是它存在的意义；已补入 `wechat_mp`（标题 32 / 摘要 120 / hashtag 保留但**不提交给微信**，因为 `draft/add` 没有话题字段），其余 4 个平台条目**逐字未改**。

- 2026-09-18：**「微信公众号 AI 文章发布」Task 4 完成 —— 封面/正文图处理（`src/lib/wechat-media.ts`，走既有 ffmpeg，不引图像库）**。14 个用例全绿，`npm run check` 双端 0，全量 `npm test` **574 → 588 项 / 586 通过 / 1 跳过 / 1 既有失败**（+14，无新增失败）。
  - **计划外加做的一步，价值最大**：**stub 会接受任何 argv，所以假 ffmpeg 根本无法证明我的滤镜语法是对的** —— 于是用**真实 ffmpeg 9.0.1 + ffprobe** 实测：① 真实 `1080×1920` 静帧 → 封面 **`mjpeg 900×383`**（正是官方唯一支持的 `2.35_1`）；② 竖屏静帧正文图 `1080×1920` → **`608×1080`、39KB**，证明「限长边」滤镜对竖图**限的是高**（若写成朴素的 `scale=1080:-2` 只限宽，输出仍高 1920，等于没压）；③ 16.2MB 的 `2400×2400` 噪声 PNG → **`900×900`、557KB**，降质阶梯用到**第 3 档**才进 1MB（纯噪声几乎不可压 → 「两轴都动」是对的）；④ 源文件 sha256 前后一致、产物目录无残留。
  - 实现口径：产物**直接写目标名**、失败或超限时**删掉再抛错**（不用「临时名 + rename」，因为 stub 的契约是「最后一个参数是输出路径」）；清理断言把 stub 改成**先写出产物再失败**，否则那条「不留半成品」的断言等于没测。
  - `MAX_SOURCE_IMAGE_BYTES = 20MB` 是本模块**自己的**处理前兜底上限，**没有**去复用 `assets-store.ts` 的上传限额（理由不同，注释里互相点到）；另补一个分支：`ffmpegBinary` 传空白字符串 → `wechat_media_ffmpeg_unavailable` + 安装指引（缺省仍回退 PATH 的 `ffmpeg`，与 `media.ts` 同口径）。
  - 已记进计划：本任务**没有**去测「PATH 里没有 ffmpeg」，因为那会真的启动进程，违反「全程 stub」的约束。

- 2026-09-18：**「微信公众号 AI 文章发布」Task 3 完成 —— AI 成文与本地兜底（`planWechatArticle`）**。新增 12 个用例（`wechat-article.test.ts` 合计 44 个全绿），`npm run check` 双端 0，全量 `npm test` **562 → 574 项 / 572 通过 / 1 跳过 / 1 既有失败**（+12，无新增失败），并跑 `publishing-copy.test.ts` 作为文案链路回归 PASS。
  - **不变式（有用例守住）**：**无论 AI 返回什么**（合法 / 超限 / 缺字段 / 空段落 / 坏 JSON / 抛异常 / 无 AI 配置 / 甚至 `null` 与数字），产出的草稿**必定能通过 `validateArticleDraft` 并渲染成功**，且失败一定带 `copySource: "fallback"` + 用户可读的 `warning`。**绝不静默**产出一份看起来正常、其实是原始口播稿的东西（沿用 `publishing-copy.ts` 的既有兜底口径）。
  - **一处口径定死**：AI 给的标题/摘要/作者**超限时压缩而不是抛错**（保留前 `limit-1` 个码点再补「…」，按码点计数）—— 让用户看得出被截断过，配合界面的「已压缩，可编辑」闭环；抛错只会给用户一句「标题超长」而没有任何动作。
  - **兜底三决定**：① 标题优先任务标题 → 第一个要点 → 大纲首项；② 正文优先 `keyPoints` 逐条成段，无要点时退回 `cleanScript`/`summary` 按句切分；③ **一条素材都没有时给一句可执行占位说明**（提示先去完成 AI 洗稿或手动补写），绝不产出空文章让用户以为成功了。
  - **限额只有一个真源**：提示词里的 32/120/20000 全部由 `WECHAT_ARTICLE_LIMITS` 生成，有用例断言提示词里出现这些数字（防止提示词里另写一份而悄悄漂移）；`response_format: { type: "json_object" }` 与既有文案服务同一形状，AI 输出过一道 `toSimplifiedChinese`。
  - **如实记录一个不复现的抖动**：5 次全量运行中有 **1 次**报 `fail 2`，其余 4 次均 `fail 1`（+ 3 次连续稳定运行复核）。单独把 `publishing-service.test.ts` 连跑 4 次都是稳定 `29 项 / 1 失败`（既有基线那条），且本次新增的测试文件不共享状态、只写自己的临时目录 —— 判断是该既有失败所在文件的跨文件并行抖动，**与本次改动无关**；若再出现应单独排查那条基线用例。

- 2026-09-18：**「微信公众号 AI 文章发布」Task 2 完成 —— 微信兼容 HTML 渲染与文章结构校验（`src/lib/wechat-article.ts`，纯函数）**。32 个用例全绿，`npm run check` 双端 0，全量 `npm test` **530 → 562 项 / 560 通过 / 1 跳过 / 1 既有失败**（+32，无新增失败）。
  - **抓到 1 个真 bug（用例抓的）**：`ensureStyle` 早期写成「标签没有 style 就整个重建标签」，于是 `<img src="…">` 被重建成 `<img style="…">` —— **图片 src 被静默抹掉**，表现是草稿里一张图都没有而接口不报任何错（同类风险还波及 `<a href>`）。已改为「保留原属性再补 style」。
  - **抓到 1 个真 bug（肉眼复核渲染样例抓的）**：段内文本里的块级标签被直接解开，`<li>钩子要具体</li><li>别用「大家好」开场</li>` 变成「钩子要具体别用「大家好」开场」—— 两条要点粘成一句。已改为「段内块级边界换成 `<br>`」（同时修掉 `<p>甲</p><p>乙</p>` 变「甲乙」）。**教训：纯函数测试全绿 ≠ 产物读得通，渲染类改动必须把真实样例打出来看一眼。**
  - **一处比计划更严的偏离**：计划的行内白名单没有 `a`，实现改为锚点**成对**处理 —— `mp.weixin.qq.com` 的文章链接**保留**（官方明说正文支持插入公众号已群发文章链接），**站外链接整对拆掉只留文字**（公众号正文里站外链接本就点不动，留个假的可点样式是误导；它的正规位置是 `content_source_url`「阅读原文」）。
  - **三处口径定死**：① **正文长度断言放在渲染里**而非 `validateArticleDraft`（正文是渲染产物，只有渲染完才知道长度），超限抛 `wechat_article_too_long` 并**指出是第几段超的**；② **配图位置**：第 k 张图放第 k 个 section 之后，图多于 section 时余下的按顺序附在文末（**宁可多插一张也不静默丢图**）；③ `sanitizeWechatHtml(html, allowBlocks)` 用一个开关覆盖「整篇正文」与「段内文本」两种场景（段内若允许块级会产出 `<p><p>` 非法嵌套）。
  - `WECHAT_ARTICLE_LIMITS`（title 32 / author 16 / digest 120 / content 20000 字符 / 封面 10MB / 正文图 1MB）是**全项目唯一一份数字**，界面只渲染不复制。外链图与「看起来像但其实不是」的域名（`mmbiz.qpic.cn.evil.com`）都靠**域名后缀**匹配拦掉，不用 `includes`（本项目在 Cookie 域判断上踩过同类坑）。

- 2026-09-18：**新业务「微信公众号 AI 文章发布」立项 —— 难度评估、spec、计划，并完成 Task 1（客户端 + 账号自检探针）**。用户确认走**路线 A**（复用现有交付包体系，`PublishPlatform` 加 `wechat_mp`）且账号是**个人订阅号（未认证）**。
  - **参考项目 `liyown/ai-trend-publish`（MIT）实测结论**（clone 到 `/tmp/aitp-probe` 逐文件核对，非读 README）：**Deno v2 项目**（有 `deno.json`、无 `package.json`），357 文件 / `*.ts`+`*.tsx` **55,139 行**；**但真正与公众号有关的只有约 520 行**（`weixin-publisher.ts` 355 + `weixin-api-client.ts` 163），只有 **4 个端点**（`token`、`draft/add`、`material/add_material`、`media/uploadimg`），**零浏览器自动化**，且**它从不调用 `freepublish`** —— 它的「发布」就是**建草稿**（`status: "draft"`）。其余 5.5 万行是内容生产流水线（11 个抓取源、选题聚类、审稿、Dashboard、向量去重），**与我们的定位不重合，本次不搬**。两个必须避开的坑：① 它硬编码了**作者自己账号的封面 media_id** 并在封面失败时静默回退（照抄必然 `40007`）；② 它只匹配 `40164` 一个白名单错误码。
  - **官方文档纠正了我自己的两处认知**（都写进 spec §1.2/§1.3）：① **白名单错误码官方两处不一致** —— 接口错误码表写 `40164`，开发指南写 `61004`，**两个都得认**；我先前以为 61004 只是「网上的说法」，核对后确认它同样是官方页面。② 风险调用确认是**三个码**：`89503`（待管理员确认）、`89506`（拒绝，24 小时）、`89507`（拒绝，1 小时）。另外 `45009` 是**日额度**、`45011` 才是**分钟限流**；稳定版凭据**普通模式下平台提前 5 分钟更新**，故返回的 `expires_in` 可能远小于 7200，**缓存必须用返回值**。
  - **可行性判据（唯一硬未知数）**：官方只在**发布能力**页写了「2025 年 7 月起个人主体/未认证账号回收权限」，**草稿箱页没有**，且配额表把「草稿箱-新建草稿 1000/日」与「发布接口 100/日」**分开列** —— 据此**推断**个人订阅号仍可建草稿，但**未经实测**。故 spec §1.4 把它列为一号风险，并设计了 **Task 1 的零副作用探针**（只换 token + `draft/count`）+ **§15 降级通路**（无论 API 通不通都产出可下载的 `article.html`，可粘贴进公众号编辑器）。
  - **产物**：`docs/superpowers/specs/2026-09-18-wechat-mp-article-publish-design.md`（15 节）、`docs/superpowers/plans/2026-09-18-wechat-mp-article-publish.md`（8 个 Task）、调研证据 `docs/research/ai-trend-publish-wechat-assessment.md`；代码 `src/lib/wechat-mp-client.ts` + `src/lib/wechat-mp-client.test.ts` + `scripts/verify-wechat-mp.ts`。
  - **Task 1 完成（Step 1–5，Step 6 待用户用真实凭据执行）**：21 个用例全绿，`npm run check` 双端 0，全量 `npm test` **509 → 530 项 / 528 通过 / 1 跳过 / 1 既有失败**（+21，**无新增失败**）。探针脚本用**进程内假微信 API 实测四种模式**（绝不联网）：`ok` 退出 0；`no-permission`(48001) 与 `ip`(40164) 与 `badsecret`(40125) 退出 1 且**文案互不相同、IP 被回显、四种模式均未打印任何凭据**。落盘缓存**按 AppID 隔离**（换账号绝不复用他人 token）。
  - **两个自己踩的坑（都有回归用例/注释）**：① 假 fetch 按 URL 分派最初写成 `url.includes("token")`，而 `draft/count` 的查询串带着 `access_token=...` → 它被误判成换取凭据的请求并拿到 token 响应，断言以**假成功**方式失败；已收敛为精确匹配并写进注释。② `npm run check` 抓到 `getDraftCount` 失败分支的**真类型错误**（泛型参数与返回类型不一致），改走 `withoutData()`。另修掉白名单失败时长指引在探针里**重复打印两遍**的观感问题。
  - **未提交**：工作区里仍有上一个会话（素材库 Task 3）未提交的改动，`docs/worklog.md` 已记「Step 4（提交）待用户决定」，故本次**未做任何 git 提交**。

- 2026-09-18：**③ 素材库 Task 3「素材库图片接入图文发布」完成**（测试先行，视频发布链路一行未改）。**关键发现**：图文包此前**根本没有创建界面** —— ② 只做了服务端 `previewNotePackage`/`createNotePackage`，详情页向导是纯视频的，真实发布那次是走 API 联调造的包；只做后端的话素材库图片在应用里依然选不到，故按用户确认一并补了最小界面。
  - **后端**：新增 `imageSource: "frames" | "library"` + `imageAssetIds[]`（预览与创建两处），服务层 `planNoteImages()` 统一产出「有序指纹键 + 预览清单」，素材库来源经 `AssetStore.resolveFile` 解析成**已校验归属**的绝对路径后再作为 `sourceImagePaths` 交给 `createNotePackageAssets`；`preview` 新增 `imageSource`/`imageLimit`/`copyLimits` 下发；`app.ts` 把 `AssetStore` 收成**单实例**供素材路由与发布中心共用。
  - **打包层未动**（`publishing-assets.ts` 只把 `MAX_NOTE_IMAGES` 改成导出）：② 已在该文件落好「按来源分派」的那一半（`sourceImagePaths` 显式传入按顺序、省略按场景序），再塞一份素材库分支等于把 id→路径的安全校验开出第二份真源。**与计划的偏差已写进计划正文**。
  - **前端**：新增独立组件 `CreateNotePackageDialog.tsx` + 纯逻辑 `utils/notePackage.ts`（按序多选、阻塞原因、请求体组装），详情页成果画布加「创建图文包」入口；视频向导 `CreatePublishPackageDialog` **一行未改**（两条链路的口径/必填项不同，混在一个向导里只会互相纠缠）。
  - **三处口径决定**：① 来源与顺序都进 `previewRevision`（换来源/调顺序 → 409）；② `library` 选 0 张报 400、超 35 张复用打包层的 `publish_too_many_images`（同一条件两个来源同码），而 `frames` 一张静帧都没有**不**报错（沿用 ②「缺图也把包建出来、只标 `missing_images`」）；③ 文案字数上限（20/1000/10）与图片上限（35）**由预览接口下发**，表单只渲染不复刻数字（服务端创建时仍重新校验）。
  - **验证**：`npm run check` 双端 0；`npm test` **509 项 / 507 通过 / 1 跳过 / 1 既有失败**（基线 490 → +19，无新增失败）。用 `dist/` 产物 + **临时 storage** 起隔离实例走真机 HTTP **36 项全绿**（含「包内 01 与先点的素材逐字节一致」「删素材后既有包仍在、重建才 422」「不传 contentType 的视频包行为不变」）；无头 Chrome 走**真界面 24 项全绿**（含缩略图 `naturalWidth > 0`、序号 1/2 按点选顺序、创建后到发布中心；并回归「加入发布中心」视频向导仍能打开）。隔离实例跑在 3199 + 临时 Vite 5199，**没碰用户的 3100 后端与 Vite(5173)**。
  - **两个坑记一下**：① 页面上现在有**两个同名「创建图文包」按钮**（视频区的入口 + 弹窗底部的提交），我的浏览器断言第一次就选了前者、把「未选图时按钮禁用」误判成失败 —— 界面断言必须限定作用域（`[role="dialog"]`），沿用上次「必须断言 `naturalWidth > 0`」的同一条教训；② 静态渲染又踩了一次**缺 `import React` 的 `ReferenceError`**（根 `tsconfig.json` 没有 `jsx` 设置），新组件已按惯例显式 import。
  - **收尾（同日，按用户要求重启项目）**：重启前先用**本项目自己的安全探针**（`POST /api/publishing/tasks/<不存在的 id>/auto-publish/code` —— 该路由第一件事就是 `requireSauRunner()`）测了两个进程的 sau 配置：**3100 返回 422（未配置）、Electron 内嵌后端返回 404（已配置）**。这条差异决定了怎么重启：3100 原本就没有 `SAU_*`（**保持原样，没有擅自加**），Electron 有（**原样带回去**）。重启后 3100 与 Electron（内嵌端口 51615）`/health` 均 200、新路由未认证返回 401（不是 404）、探针结果与重启前**完全一致**；用真实 App 数据做只读复核：素材库来源预览 200（真实素材 + `imageLimit 35` + `copyLimits 20/1000/10`）、静帧回归 10 张、两种来源 revision 不同、空选 400，**发布包数量与磁盘零新增**；真实作品页界面只读实测 8/8（含真实缩略图 `naturalWidth > 0`、序号、创建按钮变可用），最后点「取消」未建包。**Electron 必须放宽权限/在沙箱外启动**：它要写 `~/Library/Application Support/douyin-ai-video/storage`，且 `safeStorage` 解密 API Key 依赖 keychain（沙箱内 `security list-keychains` 实测报 `Module Directory Service error`，放宽后正常且启动日志无 keychain 报错）。计划 Task 5 Step 2 已勾选；Step 4（提交）仍待用户决定。
  - **注意**：本会话启动的 3100 与 Electron 是**托管后台作业，会话结束后可能被回收**；要长期使用请在自己的终端启动（Electron 命令见 `docs/worklog.md` 2026-09-17 条目：`NODE_ENV=development SAU_BINARY=... SAU_BASE_DIR=... node_modules/.bin/electron . --no-sandbox`）。
- 2026-09-17：**② 抖音图文自动发布 —— 端到端真实发布成功，Task 7 全部完成**。补上选择器补丁后由用户人工执行：`autoPublish.status = succeeded`，整轮 **34 秒**（21:14:36 → 21:15:09），日志逐行为「进入图文发布页面 → 填标题/描述/话题（标题 20 字、描述+话题 277 字、9 个话题）→ 图文发布成功 → cookie 更新完毕」；**任务仍为 `ready`、`publishedAt` 为空** —— 最关键的不变式在真实成功场景下确认（退出码 0 只记「已提交」，绝不自动写 `published`，仍由人工点「标记已发布」）。副作用：`~/.douyin-ai-video/douyin-cookie.txt` 被 sau 回写刷新（5900 → 6102 字节，设计如此）。计划 Task 7 Step 1–6 全部勾选并附实测记录。

- 2026-09-17：**图文自动发布首次真实尝试失败 —— 根因定位到上游一行选择器，已打补丁**。失败表现：`sau douyin upload-note` 走到「开始填标题」后正好 **120 秒**退出，`autoPublish.status = failed`（**死在点「发布」之前，未发出任何内容**）。用上游浏览器栈做**只读 DOM 排查**（进发布页、塞图、**不填表不点发布**）拿到铁证：图文发布页标题框真实 placeholder 是「**添加作品标题**」，而上游匹配的是「填写作品标题」→ 实测 `count = 0` vs `input[placeholder*="作品标题"]` `count = 1`；描述框 `div.zone-container[contenteditable="true"]` 与发布按钮 `get_by_role("button", name="发布", exact=True)` 均 `count = 1`（**无需改**）。按用户决定打了一行补丁（`填写作品标题` → `作品标题`，两种文案都成立），patch 存进 `docs/patches/sau-note-title-selector.patch` 并写进 `docs/patches/README.md` 与 AGENTS.md（**上游 `git pull` 会覆盖，升级后必须重新 `git apply`**）。附带发现：`sau` 用的是**系统安装的 Google Chrome**（`channel="chromium"`），不是下载的 headless shell。
- 2026-09-17：本轮修掉三个**用户实测暴露**的问题（都有回归用例）：① **失败原因被截断丢掉** —— `summarizeCliOutput` 原来只保开头 500 字，而上游进度在开头、**错误在末尾**，导致界面只剩一堆 INFO；改为去掉 ANSI 色码 + **保住尾部**（头部 1/3 + 尾部 2/3）。② **提交中毫无反馈** —— 同步请求要跑 1–3 分钟（光 `sau douyin check` 就约 100 秒），界面只是个不动的转圈 + 灰按钮，用户以为卡死；弹窗底部现在显示「正在提交到抖音…已用 N 秒，请不要关闭窗口」。③ **历史脏数据显示到界面上** —— 已落库的 `autoPublish.message` 含 loguru 色码，渲染层新增 `stripAnsi()` 清掉（任务行提示与审计 `reason` 都过一道；实测那条真实记录 496 字 → 去色码后 225 字）。
- 2026-09-17：**修掉「请选择当前操作者」**（用户反馈"不是已经移除登录了吗"）。根因不是功能回退：`LocalSessionStore` 的会话是**纯内存 Map**，后端一重启全部失效（而 AGENTS.md 要求改后端必须重启），登录/切换界面又已移除，客户端没有自救手段，只好把登录时代写的 401 文案弹出来。修法：`ApiClient` 响应拦截器遇到 **401 + `local_session_required`** 时**静默重开自动会话并重放一次**（只重放一次、会话接口自身失败不递归、并发 401 共用一个 Promise）；其它 401 与状态码照旧抛错。新增 2 个**集成用例**（假 adapter 跑真实拦截器：断言调用序列为 `packages → local-sessions/auto → packages` 且重放带新 token；真 401 只调 1 次）。另清掉上次失败留下的 **9 个孤儿无头浏览器**（按 playwright 专用 profile 匹配，不碰用户自己的 Chrome）。

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
