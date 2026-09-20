# 微信公众号 AI 文章发布 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在发布中心为「文章交付包」提供「提交到公众号草稿箱」动作：把已完成任务的转录 + 洗稿产物用 AI 写成一篇公众号文章，渲染成微信兼容 HTML，上传封面与正文图，调用官方 `draft/add` 建草稿；最终发布仍由人工在公众号后台完成。无论接口是否可用，都产出可下载的 `article.html`。

**Architecture:** 复用现有交付包与发布中心（版本/审计/垃圾桶/`previewRevision` 必经确认/`autoPublish` 子记录全部白拿）。给 `PackageContentType` 加第三种 `"article"`、给 `PublishPlatform` 加 `wechat_mp`；新增 `wechat-article.ts`（成文 + 纯函数渲染）、`wechat-mp-client.ts`（官方 API 客户端）、`wechat-media.ts`（ffmpeg 图片处理）三个模块。**不新增提交路由** —— 复用既有 `POST /api/publishing/tasks/:id/auto-publish`，按 `contentType` 分派。

**Tech Stack:** Node.js 18+ + Express 4 + TypeScript（`fetch`/`FormData`/`Blob` 原生，**零新依赖**；图片处理走项目已有的 ffmpeg）、React 19 + Tailwind（发布中心与设置页）、Node 内置 test runner（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-18-wechat-mp-article-publish-design.md`

## Global Constraints

- **不新增任何 npm 依赖**：不引 `ejs`、不引 `sharp`/`jimp`（图片处理用既有 `ffmpegBinary`），HTTP 用 Node 原生 `fetch` + `FormData` + `Blob`。
- **只建草稿**：**绝不调用 `freepublish/*`**（发布/群发接口；官方已对个人主体回收权限）。全仓库不得出现 `freepublish` 路径。
- **不新增 `PublishTaskStatus` 取值**：`scheduled|ready|published|failed|cancelled` 与 `PublishingListStatus`（含 `"broken"`）语义一字不改。
- `contentType` 缺省视为 `"video"`；存量包与既有用例必须**零改动**继续通过。`publishing-service.test.ts` 里 `previewRevision` 的**精确哈希断言必须逐字节不变**（这是本次重构的回归门禁）。
- **`autoPublish.status === "succeeded"` 只表示「草稿已创建」**，`task.status` 全程不变（仍停在 `ready`），直到人工点现有「标记已发布」。这是本设计最关键的不变式。
- **先判内容类型、再判配置**：抖音通路的 Task 4 已被测试抓到过一次这个错序；加进第三种内容类型后必须有专门用例守住（未配置微信凭据时，对 note/video 包仍返回该通路原本的错误）。
- 失败**绝不自动重试**；同一任务同时只允许一个 `autoPublish` 运行（运行中 409）；沿用既有 **30 分钟僵死阈值**（常量指向 `publishing-store.ts`，渲染层复刻时注释必须指向同一处）。
- **所有测试绝不联网**：微信客户端测试注入假 `fetchImpl`；图片测试用临时目录里的 **shell stub 冒充 ffmpeg**（`chmod +x` 后注入）。本计划不含任何真实上传或建草稿步骤。
- **日志与审计脱敏**：AppSecret 与 `access_token` **不得**出现在 `message`、审计 `reason` 或任何持久化字段中（有专门用例断言）。
- `PublishPlatform` 新增 `wechat_mp` 有 **5 个编译器兜不住的静默点**（见 Task 5），每个都要有用例。
- 未配置微信凭据时**不静默失败**：给出含「微信开发者平台 → 我的业务 → 公众号 → 开发密钥 → API IP 白名单」路径的可执行指引，并指向降级通路。
- 后端改动需 `npm run build:backend` 并重启；`electron/` 改动需 `npm run build:electron`（**两套产物互不覆盖**，见 `AGENTS.md`）。

---

### Task 1: `wechat-mp-client.ts` + 账号自检探针（测试先行，**可行性判据**）

> **这是全计划的第一优先级**：个人订阅号的草稿箱权限是唯一无法从文档确证的未知数（spec §1.4）。
> 本任务产出一个**零副作用**探针，用户用真实凭据跑一次即可定论。**探针的结论决定 Task 8 Step 3
> 是否把降级通路（§15）提升为主通路**，但不阻塞 Task 2–7 的实现（它们全部可用假 HTTP 测试）。

**Files:**
- Create: `src/lib/wechat-mp-client.ts`
- Create: `scripts/verify-wechat-mp.ts`（探针脚本，可 `npx tsx scripts/verify-wechat-mp.ts` 直接跑）
- Test: `src/lib/wechat-mp-client.test.ts`

**Interfaces:**
- Consumes: `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET`（env）、既有 `runCommand` 无关
- Produces: `WechatMpClient`（可注入 `fetchImpl` 与 `now`）、`WechatMpResult<T>`、`WechatMpErrorKind`、
  `WechatVerifyReport`、token 落盘缓存（`<storagePath>/cache/wechat-mp-token.json`）

- [x] **Step 1: 写失败用例（注入假 `fetchImpl`，绝不联网）**

- `40001|40013|40125` → `errorKind === "auth"`，文案含「AppID 或 AppSecret 不正确」；`40243` → `secret_frozen`，文案含「解冻」。
- **`40164` → `ip_whitelist`**，且从 `errmsg` 里**提取出 IP** 放进结果（例：`invalid ip 1.2.3.4 ipv6 ::ffff:1.2.3.4, not in whitelist` → `1.2.3.4`）。
- **`61004` → 同样是 `ip_whitelist`**（spec §1.2：官方两页各写一个码，**两个都必须认**）。
- **`89503` → `risk_confirm`**，文案含「管理员确认」。
- `48001` → `permission`，文案含「草稿箱接口权限」；`45009` → `rate_limit`；`45008|45028` → `quota`。
- 非 JSON 响应体 → `invalid_response`；`AbortError`/网络异常 → `network`（都不抛出，返回 `ok: false`）。
- **每个 `errorKind` 的中文文案互不相同**（防止又混成一句兜底文案，这是本项目已踩过的坑）。
- **token 缓存**：同一 client 连续两次调用只打 **1** 次 token 接口；`expiresAt` 剩余 < 5 分钟时**重新获取**（用注入的 `now` 推进时间验证）；并发 3 次调用只打 1 次 token 接口（**单飞锁**）。
- 优先打 `/cgi-bin/stable_token`；该接口失败时回退 `/cgi-bin/token`（断言两次请求的 path）。
- **脱敏**：断言 `message` 与返回对象里**不出现** appSecret 字面量与 `access_token` 字面量（构造一个含 token 的失败 URL 来验证）。

> **执行记录（2026-09-18，Step 1–5 完成，Step 6 待用户用真实凭据执行）**
>
> - **21 个用例全绿**；`npm run check` 双端 0；全量 `npm test` 基线 509 → **530 项 / 528 通过 / 1 跳过 /
>   1 既有失败**（即 +21，无新增失败；唯一失败仍是 `publishing-service.test.ts` 那条既有基线）。
> - **计划外新增一个错误码**：核对稳定版凭据官方文档时发现风险调用确认其实是**三个码** —— `89503`
>   （待管理员确认）、`89506`（拒绝，24 小时）、`89507`（拒绝，1 小时），故 `errorKind` 拆成
>   `risk_pending` 与 `risk_rejected`（后者按码给不同等待时长）。同时确认 `40164` **确实**出现在
>   稳定版凭据的错误码表里，而开发指南写 `61004` —— 官方两处不一致，两个都认（spec §1.2 已更正）。
> - **两处从官方文档纠正的既有认知**：① `45009` 是**日额度**（可 `clear_quota` 恢复），`45011` 才是
>   **分钟级限流** —— 两者文案与用户动作不同，不能都叫「超频」；② 稳定版凭据**普通模式下平台会提前
>   5 分钟更新**，故返回的 `expires_in` 可能远小于 7200（官方示例有 345），**缓存必须用返回值**；
>   有用例专门守住（`expires_in: 345` 时 60 秒后必须已刷新，硬编码 7200 会漏）。
> - **测试自己踩了一个坑并已修**：假 fetch 的分派最初写成 `url.includes("token")`，而 `draft/count`
>   的查询串里带着 `access_token=...`，于是它被误判成换取凭据的请求、拿到 token 响应 —— 断言以
>   **假成功**方式失败。已收敛为 `isTokenRequest()`（精确匹配 `/cgi-bin/stable_token` 或
>   `/cgi-bin/token?`）并把这个坑写进注释。**教训：按 URL 分派假响应时，子串匹配查询串是不安全的。**
> - **`npm run check` 抓到 1 个真类型错误**：`getDraftCount` 的失败分支直接 `return result`，而
>   `requestJson` 的泛型参数与对外返回类型不同 —— 已改为走 `withoutData()`（与文件内其它分支一致）。
> - **探针脚本用进程内假微信 API 实测了四种模式**（绝不联网）：`ok` → 退出码 0 且三行全绿；
>   `no-permission`（48001）→ 退出码 1 且明确指向降级通路；`ip`（40164）→ 回显 IP `203.0.113.7`
>   并给出微信开发者平台路径；`badsecret`（40125）→ 与冻结/白名单/权限三类文案**互不相同**。
>   四种模式**均未打印 AppSecret 与 access_token**（脚本只打印掩码后的 AppID）。
>   顺带修掉一处观感问题：白名单失败时长指引原本在「凭据」与「IP 白名单」两行重复打印。
> - 落盘缓存按 **AppID 隔离**（有用例断言换账号绝不复用他人 token），这是防止把 A 号凭据用在 B 号上的关键一条。

- [x] **Step 2: 运行确认失败**（`ERR_MODULE_NOT_FOUND`，模块不存在）

- [x] **Step 3: 实现客户端**

- [x] **Step 4: 运行确认通过**

- [x] **Step 5: 写探针脚本并自测（不联网部分）**

- [ ] **Step 6: 交给用户用真实凭据跑（本任务唯一的联网步骤，由用户执行）**

Run（用户在自己终端）：
```bash
WECHAT_MP_APP_ID=... WECHAT_MP_APP_SECRET=... npx tsx scripts/verify-wechat-mp.ts
```
Expected: 三行结论。**把实际输出原样记回本 Step**（这是 spec §1.4 那个未知数的唯一答案，也是 Task 8 Step 3 的判据）。
若报 `ip_whitelist`：按提示加白名单后重跑。若报 `permission`：草稿箱不可用 → **降级通路成为主通路**，Task 6/7 的界面文案按 `permission` 分支为准，其余任务照做。

### Task 2: 微信兼容 HTML 渲染（测试先行，纯函数）

**Files:**
- Create: `src/lib/wechat-article.ts`（本任务只放渲染与校验；成文见 Task 3）
- Test: `src/lib/wechat-article.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，零 IO）
- Produces: `WECHAT_ARTICLE_LIMITS`（`title: 32` / `author: 16` / `digest: 120` / `contentChars: 20000` /
  `coverBytes: 10MB` / `contentImageBytes: 1MB`）、`renderWechatArticleHtml(draft, images)`、
  `validateArticleDraft(draft)`、`extractContentImageSources(html)`

> **执行记录（2026-09-18，Step 1–4 完成）**
>
> - **32 个用例全绿**；`npm run check` 双端 0；全量 `npm test` 530 → **562 项 / 560 通过 / 1 跳过 /
>   1 既有失败**（+32，无新增失败）。
> - **抓到 1 个真 bug（用例抓的）**：`ensureStyle` 早期实现是「标签没有 style 就整个重建标签」，
>   于是 `<img src="…">` 被重建成了 `<img style="…">` —— **图片的 src 被静默抹掉**，表现是草稿里
>   一张图都没有、而接口不报任何错。已改为「保留原属性再补 style」。同类风险还波及 `<a href>`。
> - **抓到 1 个真 bug（肉眼复核渲染样例抓的）**：段内文本里的块级标签被**直接解开**，
>   于是 `<li>钩子要具体</li><li>别用「大家好」开场</li>` 变成「钩子要具体别用「大家好」开场」——
>   两条要点粘成一句。已改为「段内块级边界换成 `<br>`」（同时解决 `<p>甲</p><p>乙</p>` 变「甲乙」）。
>   **教训：纯函数测试全绿 ≠ 产物读得通，渲染类改动必须把真实样例打出来看一眼。**
> - **一处偏离计划的决定（比计划更严）**：计划的行内白名单里没有 `a`。实现时把锚点**成对**处理：
>   `mp.weixin.qq.com` 的文章链接**保留**（官方明说「图文消息支持正文中插入自己账号和其他公众号/
>   服务号已群发文章链接的能力」），**站外链接整对拆掉只留文字** —— 站外链接在公众号正文里本就
>   点不动，留一个「看起来能点」的样式是误导，而它的正规位置是 `content_source_url`（「阅读原文」）。
> - **正文长度断言放在渲染里而不是 `validateArticleDraft` 里**：正文是渲染产物（含我们注入的样式），
>   只有渲染完才知道真实长度；因此 `validateArticleDraft` 只管标题/摘要/作者，渲染超限时抛
>   `WechatArticleError("wechat_article_too_long")` 并**指出是第几段超的**。
> - **配图位置规则（计划未定，此处定死）**：第 k 张图放在第 k 个 section 之后；**图多于 section 时
>   余下的按顺序附在文末**（宁可多插一张也不静默丢图）。有用例断言顺序与位置。
> - **`sanitizeWechatHtml(html, allowBlocks)` 用一个开关覆盖两种场景**：整篇正文（允许块级）与段内文本
>   （只允许行内）—— 段内若允许块级会产出 `<p><p>…` 这种非法嵌套。两个入口都是导出的纯函数，便于单测。
> - `WECHAT_ARTICLE_LIMITS` 一并定义了 `coverBytes`(10MB) / `contentImageBytes`(1MB)，供 Task 4/6 取用，
>   **全项目只有这一份数字**。

- [x] **Step 1: 写失败用例**

- [x] **Step 2: 运行确认失败**（`ERR_MODULE_NOT_FOUND`，模块不存在）

- [x] **Step 3: 实现渲染与校验**

- [x] **Step 4: 运行确认通过**

### Task 3: AI 成文与兜底（测试先行，假 AI 客户端）

**Files:**
- Modify: `src/lib/wechat-article.ts`
- Test: `src/lib/wechat-article.test.ts`

**Interfaces:**
- Consumes: Task 2 的校验与渲染、既有 AI 运行时配置（`resolveAiConfig`，与 `publishing-copy.ts` 同一模式）
- Produces: `planWechatArticle(context, deps)` → `{ draft: WechatArticleDraft; copySource: "ai" | "fallback"; warning?: { code: "wechat_article_ai_fallback"; message: string } }`

- [x] **Step 1: 写失败用例（注入假 AI 客户端，绝不联网）**

- AI 返回合法 JSON → `draft` 字段齐全、`copySource === "ai"`、无 warning。
- AI 返回**超 32 字的标题** → 截断到 32 字并用子串断言（**不抛错**）。
- AI 返回坏 JSON / 抛异常 → **兜底**：`copySource === "fallback"`、`warning.code === "wechat_article_ai_fallback"`、标题取任务标题（压缩到 32 字）、正文由 `keyPoints` 逐条成段。
- **兜底结果必须能被 Task 2 的 `validateArticleDraft` 接受**（端到端串起来：兜底 → 校验 → 渲染，全程不抛错）。
- 兜底**不静默**：`warning.message` 面向用户可读（含「已使用兜底结构」），且调用方拿得到它。

- [x] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/wechat-article.test.ts`
Expected: FAIL —— `planWechatArticle` 不存在。

> **执行记录（2026-09-18，Step 1–4 完成）**
>
> - **新增 12 个用例**（本文件合计 44 个全绿）；`npm run check` 双端 0；全量 `npm test` 562 → **574 项 /
>   572 通过 / 1 跳过 / 1 既有失败**（+12，无新增失败）；并额外跑 `publishing-copy.test.ts` 作为回归，PASS。
> - **一处口径定死**：AI 返回的标题/摘要/作者**超限时压缩而不是抛错**（保留前 `limit-1` 个码点再补
>   「…」，按码点计数），这样用户**看得出被截断过**，配合界面的「已压缩，可编辑」形成闭环；
>   若改成抛错，用户拿到的是一句「标题超长」而不知道怎么办。
> - **不变式（有用例守住）**：**无论 AI 返回什么**（合法 / 超限 / 缺字段 / 空段落 / 坏 JSON / 抛异常 /
>   无 AI 配置 / 甚至 `null` 与数字），`planWechatArticle` 产出的草稿**必定能通过 `validateArticleDraft`
>   并渲染成功**，且失败一定带 `copySource: "fallback"` + `warning`。**绝不静默**产出一份看起来正常、
>   其实是原始口播稿的东西。
> - **兜底的三个决定**：① 标题优先取任务标题、其次第一个要点、再次大纲首项；② 正文优先 `keyPoints`
>   逐条成段，没有要点时退回 `cleanScript`/`summary` 按句切分；③ **一条素材都没有时给一句可执行的占位
>   说明**（提示先去完成 AI 洗稿或手动补写），而不是产出空文章让用户以为成功了。
> - **提示词里的限额全部由 `WECHAT_ARTICLE_LIMITS` 生成**（用例断言提示词里出现 32/120/20000），
>   **不在提示词里另写一份数字**；`response_format: { type: "json_object" }` 与 `publishing-copy.ts` 同一形状。
> - **观察到一个不复现的抖动（如实记录）**：5 次全量运行里有 **1 次**报 `fail 2`，其余 4 次均为 `fail 1`。
>   单独把 `publishing-service.test.ts` 连跑 4 次都是稳定的 `29 项 / 1 失败`（既有基线那条），
>   且本次新增的两个测试文件**不共享任何状态、只写自己的临时目录**，故判断是该既有失败所在文件的
>   跨文件并行抖动，**与本次改动无关**。若后续再观察到，应单独排查那条基线用例。
>
- [x] **Step 3: 实现成文**

- [x] **Step 4: 运行确认通过，并跑既有文案用例作为回归**

### Task 4: 图片处理（ffmpeg，测试先行，假 ffmpeg stub）

**Files:**
- Create: `src/lib/wechat-media.ts`
- Test: `src/lib/wechat-media.test.ts`

**Interfaces:**
- Consumes: 既有 `ffmpegBinary` 配置（与 `media.ts` 同一套注入方式）
- Produces: `prepareCoverImage(srcPath, outDir)` → 2.35:1 封面（900×383）；`prepareContentImage(srcPath, outDir, index)` → <1MB jpg

> **执行记录（2026-09-18，Step 1–4 完成）**
>
> - **14 个用例全绿**；`npm run check` 双端 0；全量 `npm test` 574 → **588 项 / 586 通过 / 1 跳过 /
>   1 既有失败**（+14，无新增失败）。
> - **🔴 关键补充验证：用真实 ffmpeg 跑了一遍**（计划里没有这一步，但不做就有一个大盲区）——
>   **stub 会接受任何 argv，所以它根本无法证明我的 ffmpeg 滤镜语法是对的**。实测（ffmpeg 9.0.1 + ffprobe）：
>   - 封面：真实 `1080×1920` 静帧 → **`mjpeg 900×383`** ✓（正是官方唯一支持的 `2.35_1`）；
>   - 竖屏静帧正文图：`1080×1920` → **`608×1080`**、39KB —— 证明「限长边」滤镜对竖图**限的是高**。
>     **这条特别值得记**：如果写成朴素的 `scale=1080:-2`（只限宽），输出会仍是高 1920，等于没压；
>   - 16.2MB 的 `2400×2400` 噪声 PNG → **`900×900`、557KB**，降质阶梯用到**第 3 档**才进 1MB
>     （纯噪声几乎不可压，说明「只降画质不降尺寸」是不够的，两轴都动是对的）；
>   - 源文件 sha256 **前后一致**；产物目录里**只有该有的那两个文件**（无残留）。
> - **一处实现选择**：产物**直接写目标文件名**，失败或超限时**删掉再抛错**，而不是「先写临时名再 rename」。
>   理由是 stub 的契约是「最后一个参数是输出路径」，临时名会让这条契约失去意义；而清理逻辑
>   同样能保证「不留半成品」（用例把 stub 改成**先写出产物再失败**，这样清理断言才真的在测清理）。
> - **`MAX_SOURCE_IMAGE_BYTES = 20MB` 是本模块自己的兜底上限**，**没有**去 import `assets-store.ts`
>   的 `MAX_BYTES.image`：那个是**上传**限制，这个是**处理前**的合理性上限，两者理由不同（注释里互相点到）。
> - 另外补了一个计划外的分支：`ffmpegBinary` 被显式传成**空白字符串**时抛 `wechat_media_ffmpeg_unavailable`
>   并给出安装指引 —— 缺省（`undefined`）仍按 `media.ts` 的老口径回退到 PATH 里的 `ffmpeg`。
>   （**没有**去测「PATH 里没有 ffmpeg」那种情况：那会真的启动一个进程，违反本任务「全程 stub」的约束。）

- [x] **Step 1: 写失败用例（stub 脚本冒充 ffmpeg，`chmod +x` 后经 `ffmpegBinary` 注入）**

- [x] **Step 2: 运行确认失败**（`ERR_MODULE_NOT_FOUND`，模块不存在）

- [x] **Step 3: 实现**

- [x] **Step 4: 运行确认通过**

### Task 5a: 平台接入与清单守卫（**执行时从 Task 5 拆出**，2026-09-18 完成）

> 原 Task 5 一肩挑了「加平台」与「改安全加固过的打包层」两件事。执行时把它拆成两半：
> 5a 只碰枚举与清单（编译器 + 守卫用例能兜住），5b 才动 `publishing-assets.ts` 的打包事务。
> 理由：`publishing-assets.ts` 有 1957 行、带锁/临时目录/目录身份校验/原子提升/回滚，
> 与「加一个平台枚举」的风险等级完全不同，混在一次改动里出问题不好定位。

**Files:**
- Modify: `src/types.ts`、`renderer/src/types/index.ts`（`PublishPlatform` 加 `wechat_mp`）
- Modify: `src/lib/publishing-platforms.ts`（`PUBLISH_PLATFORMS.wechat_mp`）
- Modify: `src/lib/publishing-assets.ts`（导出并补 `APPROVED_PLATFORMS`）
- Modify: `src/lib/publishing-routes.ts`（导出并补 `PLATFORMS`）
- Modify: `src/lib/publishing-service.ts`（导出`SUPPORTED_PLATFORMS`/`NOTE_PLATFORMS`）
- Modify: `src/lib/publishing-store.ts`（导出并补 `isPlatform`）
- Modify: `renderer/src/utils/publishing.ts`（平台表补点）
- Test: `src/lib/publishing-platforms.test.ts`、`renderer/src/utils/publishing.test.ts`

> **执行记录（2026-09-18，完成）**
>
> - 新增 5 个后端用例 + 2 个渲染层用例，**全绿**；`npm run check` 双端 0
>   （这同时证明 `Record<PublishPlatform, PlatformPolicy>` 已补齐、没有别处的穷尽分支被破坏）；
>   全量 `npm test` 588 → **595 项 / 593 通过 / 1 跳过 / 1 既有失败**（+7，无新增失败）。
> - **守卫写法比原计划更省更狠**：原计划是「5 个静默点各写一条断言」，实际改成
>   **断言所有清单彼此一致** —— 以 `PUBLISH_PLATFORMS` 的键（编译器强制的那个真源）为基准，
>   要求 `APPROVED_PLATFORMS`、路由 `PLATFORMS`、`SUPPORTED_PLATFORMS` 的集合与之**完全相等**。
>   这样将来再加平台时，漏掉任何一份清单都会**自动**被抓到，不用再补断言。
>   为此把这几份集合**导出**（它们只是数据，导出成本为零），并在每处注释里写明「为什么导出」。
> - `NOTE_PLATFORMS` 另写一条：它是**严格子集**（只含 douyin）且**断言不含 `wechat_mp`** ——
>   公众号走 article 通路，塞进图文闸门会拿「标题 20 / 正文 1000」的口径去校验公众号文章。
> - `isPlatform`（存档校验）改成逐个平台断言：**漏一个的后果是静默的**（该平台的任务在读回索引时
>   被悄悄丢掉，而不是报错），所以它值得一条专门的用例。
> - 渲染层是**独立的 TS 工程**，`src` 的测试覆盖不到它的平台表，因此在
>   `renderer/src/utils/publishing.test.ts` 里补了 2 条（清单一一对应 + 口径与后端一致）。
> - 既有那条**穷尽式**断言 `assert.deepEqual(PUBLISH_PLATFORMS, {...4 个平台})` 如期被打破 ——
>   这正是它存在的意义（它相当于一个测试层的「必须补齐」守卫），已把 `wechat_mp` 补进去，
>   其余 4 个平台条目**逐字未改**。

- [x] **Step 1: 写失败用例**（清单一致性守卫先失败：`APPROVED_PLATFORMS` 尚未导出）
- [x] **Step 2: 运行确认失败**（`SyntaxError: … does not provide an export named 'APPROVED_PLATFORMS'`）
- [x] **Step 3: 实现**（枚举 + 5 处静默点 + 渲染层平台表 + `PUBLISH_PLATFORMS.wechat_mp`）
- [x] **Step 4: 运行确认通过**（后端 15/15、渲染层 28/28、`npm run check` 双端 0）

### Task 5b: `article` 包模型与打包（**执行时从 Task 5 拆出**，2026-09-18 完成）

> 剩下的是原 Task 5 的后半：`PackageContentType` 加 `"article"`、`DeliveryPackage.articleCopy`、
> `createArticlePackageAssets()` / `stageArticleContent()`（复用既有 `withStagedPackage` 暂存目录事务，
> **不复制第二份骨架**），以及「不传 article 参数时视频包哈希逐字节不变」的回归门禁。

**Files:**
- Modify: `src/types.ts`（`PackageContentType` 加 `article`；新增 `WechatArticleCopy`；`DeliveryPackage.articleCopy`）
- Modify: `src/lib/wechat-article.ts`（图片占位符 + `substituteWechatImageSlots`）
- Modify: `src/lib/publishing-assets.ts`（`createArticlePackageAssets` / `stageArticleContent` / 共用 `copyOrderedImages`）
- Modify: `src/lib/publishing-store.ts`（接受 `article` + `articleCopy` 形状校验）
- Test: `src/lib/wechat-article.test.ts`、`src/lib/publishing-assets.test.ts`

> **执行记录（2026-09-18，完成）**
>
> - 新增 **6 个占位符用例 + 7 个打包用例**，全绿；`npm run check` 双端 0；
>   全量 `npm test` 595 → **608 项 / 606 通过 / 1 跳过 / 1 既有失败**（+13，无新增失败）。
> - **存量兼容门禁如期通过**：`publishing-assets.test.ts` 里那条**逐字节固定视频包 manifest** 的用例
>   （`packages one cloned MP4 with safe manifest…`，内含精确哈希基线）**本来就存在**，
>   所以不需要新写 —— 它正是「图文/文章打包不得改动视频包」的现成闸门，本次改动后仍然通过。
> - **🔴 补上了计划漏掉的一环：正文图片占位符机制。** 计划在 Task 6 只写了「替换 HTML 内 src」，
>   但没说**替换什么**。而微信正文图**只能是 `uploadimg` 返回的 mmbiz URL，那个 URL 只有提交时才拿得到**，
>   所以包里的 `article.html` 必须先存占位符。定下的契约：
>   - `WechatArticleImage` 现在是一联合类型：`{ url }`（已知道最终地址）与 `{ slot: n }`（打包阶段）；
>     `{ slot }` 渲染成 `src="{{wechat-image-N}}"`；
>   - `substituteWechatImageSlots(html, urlBySlot)` 在提交时替换，三条硬要求各有用例守住：
>     **① 一个占位符都不许剩下**（漏替换 = 全裂图且接口不报错）、**② 只接受 mmbiz 托管地址**、
>     **③ 替换后仍要满足 2 万字符上限**（图片 URL 也是 content 的一部分）。
> - **一个新用例抓到 1 个真 bug**：`stageArticleContent` 把封面的**暂存目录路径**直接当成结果返回，
>   而提升之后那个路径已经不存在了 —— 已改为「暂存只带 `stagedCoverPath` 标志、对外用
>   `path.join(staged.packagePath, "cover.jpg")` 换算」，与视频封面同一口径。
> - **一处重构（消重）**：把 `copyNoteImages` 提取成共用的 `copyOrderedImages`，图文包与文章包共用
>   —— 两者的「按序复制 + 逐张 sha256 校验 + 顺序敏感清单哈希」完全一致，各写一份等于把
>   「复制后必须校验」这条纪律拆成两处（本项目在 assets 层立过「安全校验只允许有一个真源」的规矩）。
> - **计划外加的一条守卫**：`assertArticleImageCoverage()` —— 正文里有 `{{wechat-image-N}}` 却没有
>   对应图片时**在打包阶段就拦掉**（`publish_images_missing`），否则这个包**永远提交不了**，
>   只会在提交那一刻才失败。**注意「一张图都没有」本身合法**（文章的内容是文字），
>   所以文章包 0 图不报错、也不标 `missing_images`（与图文包刻意不同：图文包的图片就是内容本身）。
> - **打包层不转码**：正文图与封面必须是 `wechat-media` **已经处理过**的产物（jpg、<1MB、2.35:1），
>   打包只做「复制 + 哈希 + 校验」。ffmpeg 不该出现在这个安全加固过的复制事务里
>   （打包用例里注入的 `runCommand` 会直接抛错，专门守住这一点）。

- [x] **Step 1: 写失败用例**（先失败：`substituteWechatImageSlots` / `createArticlePackageAssets` 不存在）
- [x] **Step 2: 运行确认失败**（`does not provide an export named 'substituteWechatImageSlots'`；打包 7 个全红）
- [x] **Step 3: 实现**
- [x] **Step 4: 运行确认通过**（`wechat-article` 50/50、`publishing-assets` 44/44、`npm run check` 双端 0）

### Task 5: 平台接入与包模型（测试先行）

**Files:**
- Modify: `src/types.ts`、`src/lib/publishing-platforms.ts`
- Modify: `src/lib/publishing-assets.ts`（`stageArticleContent`）、`src/lib/publishing-routes.ts`、`src/lib/publishing-service.ts`、`src/lib/publishing-store.ts`
- Modify: `renderer/src/types/index.ts`、`renderer/src/utils/publishing.ts`
- Test: `src/lib/publishing-platforms.test.ts`、`src/lib/publishing-assets.test.ts`、`src/lib/publishing-store.test.ts`

**Interfaces:**
- Consumes: 既有打包暂存目录事务 `withStagedPackage`、既有 `assetHealth` 口径
- Produces: `PublishPlatform` 含 `"wechat_mp"`、`PackageContentType` 含 `"article"`、`DeliveryPackage.articleCopy`、
  `PUBLISH_PLATFORMS.wechat_mp`、`createArticlePackageAssets()`

- [ ] **Step 1: 写失败用例**

- **平台枚举 5 个静默点各一条断言**：`APPROVED_PLATFORMS`（assets）、`PLATFORMS`（routes）、`NOTE_PLATFORMS`（service）、
  `isPlatform`（store）、渲染层平台表 —— 断言 **`wechat_mp` 在其中**，**且既有 4 个平台一个都没少**（防「加了新的、丢了旧的」）。
- `validatePlatformCopy("wechat_mp", …)`：标题 33 字报错 / 32 字通过 / 摘要 121 字报错。
- 打包：`createArticlePackageAssets` 产出 `contentType: "article"`、包内 `article.html`、有序 `imagePaths`、`coverPath`、
  以及 `articleCopy.htmlSha256`（= `article.html` 的哈希）。
- 缺封面 → `assetHealth === "missing_cover"`；**缺正文图不报错**（与图文包「缺图也把包建出来」同一口径）。
- **存量兼容**：不传 article 参数时 `contentType` 仍为 `"video"`，视频包哈希**逐字节不变**。
- `isPlatform("wechat_mp") === true` 且落库读回一致。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts src/lib/publishing-store.test.ts`
Expected: FAIL —— 平台不存在。

- [ ] **Step 3: 实现**

`PUBLISH_PLATFORMS.wechat_mp = { label: "微信公众号", titleMax: 32, descriptionMax: 120, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: "https://mp.weixin.qq.com/" }`。
**`SUPPORTED_PLATFORMS` 不要改成字面量**（它是 `Object.keys(PUBLISH_PLATFORMS)` 自动派生的，改了会变成第 6 个静默点）。
`NOTE_PLATFORMS` **不得**顺手加 `wechat_mp`（那是图文口径的闸门，article 走自己的分支）。
打包复用 `withStagedPackage`，**不复制第二份暂存骨架**。

- [ ] **Step 4: 运行确认通过，并跑既有打包用例作为回归**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts src/lib/publishing-assets.test.ts src/lib/publishing-store.test.ts`
Expected: PASS，且既有视频/图文打包用例全部保持通过。

### ⚠️ 恢复本计划前必读：`article` 通路已被今日头条占用（2026-09-18）

本计划暂停期间，「今日头条 AI 文章发布」把 **`article` 内容类型**从「只有类型和打包、没有调用方」
做成了**一条真实通路**（见 `docs/superpowers/plans/2026-09-18-toutiao-article-publish.md`）。
恢复公众号时，以下几点**必须知道**，否则会撞车或重复造轮子：

| 已经存在的东西 | 公众号恢复时要怎么做 |
| --- | --- |
| `AUTO_PUBLISH_ROUTES`（`publishing-platforms.ts`）= **(内容类型 × 平台) → 引擎** 的路由表，目前只有 `note×douyin` 与 `article×toutiao` | **不要**再写 `contentType !== "note"` 这类硬判；往这张表里加 `{contentType:"article", platform:"wechat_mp", engine:"wechat"}` 即可（store 与 service 两处读的是同一张表） |
| `publishing-service.ts` 的 article 分支：`previewArticlePackage` / `createArticle` / `createArticlePackage` / `packagePreview` 的 article 分支 | 它们目前**只接受 `toutiao`**（`assertArticlePlatforms` 会拒 wechat_mp）。两者要共存：把「按平台分派渲染/限额/封面比例」抽一层，而不是复制整段编排 |
| `article-draft.ts`（平台中立成文内核）+ `wechat-article.ts`（已改成薄封装，委托给它） | 公众号侧**已经**在共用这套内核；Task 3 无需重做，只要在档案里补你自己的限额/提示词即可 |
| `ArticleCopy`（`types.ts`）= 标题 + 可选摘要/作者 + `htmlSha256`；`WechatArticleCopy` 是它的别名 | Task 5b 的 `articleCopy` 形状未变；**新增**了 `DeliveryPackage.toutiaoOptions` 与 article 分支的**包级指纹**（覆盖 `articleCopy.title` / `htmlSha256` / 封面 / 头条选项） |
| `verifyPackageHealth()`（assets 层，按内容类型分派）；`markPublished` / `verifyPackage` 已改用它 | 这块以前是「只按 video 查」，文章包会被误判成 `broken_video` —— 恢复时**不要**回退成 `verifyPackageVideo` |
| article 的**创建阶段** `previewRevision` **不绑 AI 草稿**（只绑源 + 封面选择） | 公众号侧同理：把草稿绑进创建指纹会让「界面可编辑」=「一编辑就 409」。包级指纹才是防「预览后内容被改」的那道闸门 |
| 渲染层：`PackageContentType` 已含 `'article'`；`PublishPreviewDialog` 有 article 分支；平台表已含 `toutiao` | 加 `wechat_mp` 的 article 分支时沿用同一形状（正文以纯文本下发，弹窗不做 HTML 注入） |

另外两条实测教训（对公众号也成立）：
① **页面/预览侧代码**如果要用 `page.evaluate`，内联函数会被 tsx 的 `__name` 助手打挂 —— 但那只是头条侧的问题（公众号是纯 HTTP，不涉及）；
② **文案不许写死平台**：`getPublishingAutoPublishHint` / `getAutoPublishConfirmLabel` / 动作文案都已改成按平台取
（以前头条任务会显示「正在提交到抖音」）。恢复时加平台名即可，别在渲染层再写死一处。

### Task 6: 服务编排与路由（测试先行）

**Files:**
- Modify: `src/lib/publishing-service.ts`（`verifyWechatAccount` / `createWechatArticlePackage` / `autoPublish` 分派）
- Modify: `src/lib/publishing-routes.ts`（`/wechat/verify`、`/packages/:id/article`）
- Modify: `src/app.ts`、`src/server.ts`、`electron/server.ts`（`wechatMp` 注入与 env 透传）
- Test: `src/app.test.ts`、`src/lib/publishing-service.test.ts`

**Interfaces:**
- Consumes: Task 1 客户端、Task 3 成文、Task 4 图片、Task 5 打包
- Produces: `POST /api/publishing/wechat/verify`、`GET /api/publishing/packages/:id/article`、
  `autoPublish` 对 `contentType === "article"` 的分派

- [ ] **Step 1: 写失败用例**

- `GET /packages/:id/article`：article 包 → 200 且 `content-type: text/html`；视频包 → 404/422 明确错误；越界路径被拒。
- `POST /wechat/verify`：未配置凭据 → 明确错误（含配置路径）；配置 + 假客户端返回各 `errorKind` → 逐项透出且**脱敏**。
- **分派顺序**（本任务最关键的一组）：
  - **未配置微信凭据**时，对 **note** 包调用 `auto-publish` → 仍返回 note 通路原本的错误（**不是**「未配置微信公众号」）；
  - **未配置微信凭据**时，对 article 包调用 → 明确错误，且**不产生 `autoPublish` 记录**；
  - article 包调用时**断言不触碰 sau**（注入的假 `sauRunner` 调用次数为 0）；note 包调用时**断言不触碰微信客户端**。
- **`previewRevision` 契约**：article 包不带 → **400 且不产生记录**；带过期值 → **409 且不产生记录**；带正确值 → 走通。
- 运行中重复触发 → **409**，且不产生第二条记录。
- **不变式**：article 通路成功（假客户端返回 media_id）→ `autoPublish.status === "succeeded"`、
  `message` 含 draft media_id、**`task.status` 仍为 `"ready"`、`publishedAt` 为空**（本设计最关键的一条断言）。
- **绝不调用发布接口**：断言测试期间没有任何请求打到含 `freepublish` 的路径。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/app.test.ts src/lib/publishing-service.test.ts`
Expected: FAIL —— 路由与分派不存在。

- [ ] **Step 3: 实现编排与路由**

编排放 `PublishingService`（**不塞进路由处理器** —— 本项目所有路由都是「校验 + 转调 service」的薄层）。
`autoPublish` 先按包 `contentType` 分派，**分派之后**才做该通路自己的检查与配置校验。
env 透传两条入口都要改：`src/server.ts`（`WECHAT_MP_APP_ID`/`WECHAT_MP_APP_SECRET`/`WECHAT_MP_AUTHOR`）与
`electron/server.ts`；`src/app.ts` 加 `wechatMp` 选项（对照既有 `sauBinary`/`sauBaseDir` 的写法）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/app.test.ts src/lib/publishing-service.test.ts && npm run check`
Expected: PASS，`tsc` 双端退出码 0。

### Task 7: 渲染层（设置页配置 + 校验连接 + 创建向导 + 发布动作）

**Files:**
- Modify: `renderer/src/pages/SettingsPage.tsx`、`renderer/src/pages/PublishingPage.tsx`
- Modify: `renderer/src/components/PublishPreviewDialog.tsx`、`renderer/src/services/api.ts`
- Modify: `renderer/src/utils/publishing.ts`、`renderer/src/types/index.ts`
- Create: `renderer/src/components/CreateWechatArticleDialog.tsx`
- Modify: `electron/handlers/config-handler.ts`（AppID/AppSecret 的 `safeStorage` 读写）
- Test: `renderer/src/utils/publishing.test.ts`、`renderer/src/components/CreateWechatArticleDialog.test.tsx`

> **注意（本项目已踩过的两个坑）**：① 新组件**必须显式 `import React`**（根 `tsconfig.json` 无 `jsx` 设置，
> tsx 走经典转换，缺了会在 Node 下 `ReferenceError`）；② 界面断言必须**限定作用域**（`[role="dialog"]`）——
> 页面上会有多个同名按钮（本项目因此误判过一次）。

- [ ] **Step 1: 写失败用例**

- `getWechatPublishBlocker(task, pkg)` **返回原因字符串而非布尔**：非 article 包 / 缺封面 / 凭据未配置 /
  自检未通过（`permission`）/ 运行中 / 已完成各一条断言，**每条的文案互不相同**（界面必须说明禁用**为什么**）。
- 「下载文章 HTML」动作**与任务状态无关**（只读，垃圾桶里不给）。
- `CreateWechatArticleDialog`：未选够图时提交禁用并给出原因；标题超 32 字时禁用并显示 `32/32`；
  字数上限**由 props 下发**（不在渲染层复刻数字）。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts renderer/src/components/CreateWechatArticleDialog.test.tsx`
Expected: FAIL —— 函数与组件不存在。

- [ ] **Step 3: 实现 UI 与配置**

设置页「微信公众号」区：AppID / AppSecret / 默认作者 + **「校验连接」按钮**（调 Task 6 的接口，逐项显示
「凭据 / IP 白名单 / 草稿箱权限」三行结果，失败文案按 `errorKind` 分支，**含微信开发者平台路径**）。
发布中心动作：「创建公众号文章包」「预览」「提交到公众号草稿箱」（先弹预览，**必经**）、「下载文章 HTML」。
`PublishPreviewDialog` 加 `article` 分支：渲染正文 HTML 预览 + 标题/摘要字数 + 封面 + 平台禁用原因。
媒体元素沿用既有纪律：**不能用相对 URL、不能带自定义请求头**（走 `apiClient` 取 blob 或绝对 URL）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts renderer/src/components/CreateWechatArticleDialog.test.tsx && npm run check`
Expected: PASS，`tsc` 双端退出码 0。

### Task 8: 全量验证、编译与人工复核

- [ ] **Step 1: 类型检查与全量测试**

Run: `npm run check && npm test`
Expected: 基线 **509 项 / 507 通过 / 1 跳过 / 1 既有失败**（`src/lib/publishing-service.test.ts` →
`startup recovery reports asset phases before due handling and purge`）之上**只增不减**，无新增失败。

- [ ] **Step 2: 编译并重启**

Run: `npm run build:backend`（改了 `electron/` 则还要 `npm run build:electron`），随后重启后端/Electron。

- [ ] **Step 3: 未配置状态下的人为验证**

不配置 `WECHAT_MP_*`：设置页点「校验连接」→ 应看到**明确配置指引**；对 article 包点「提交到公众号草稿箱」
→ 应看到明确错误且**任务状态不变、无 `autoPublish` 记录**；点「下载文章 HTML」→ 应能拿到 HTML
（**降级通路在零凭据状态下可用**，这是 §15 的核心验收点）。

- [ ] **Step 4: 配置后只跑自检（不建草稿）**

用 Task 1 Step 6 的真实结论复核：设置页「校验连接」三行结果应与探针输出一致。
**本 Step 不创建任何草稿。**

- [ ] **Step 5: 真实建草稿留给人工决定**

用**一个自己接受的标题**（例如标题前缀加「测试」）建一次草稿，验证：`autoPublish.status === "succeeded"`、
`task.status` 仍为 `ready`、公众号后台草稿箱里能看到该草稿（含封面与正文图**不裂图**）。
**若 `draft/add` 报权限错误**：记录原文，确认 §15 降级通路成为主通路，并把结论写进 worklog 与 spec §1.4。

- [ ] **Step 6: 文档同步与提交（提交前做私密数据审计）**

同步 `AGENTS.md`、`CLAUDE.md`（保持两者逐字一致）、`README.md`：架构清单、新接口（3 个）、
`WECHAT_MP_*` 配置、新增「微信公众号草稿箱」注意事项与故障排查节（含 40164/61004/89503/40243 四个码）。
提交前审计：无 AppSecret、无 `access_token`、未带 `cookies/`、`storage/`、`.env`。

```bash
git add src/types.ts src/lib/wechat-mp-client.ts src/lib/wechat-mp-client.test.ts \
        src/lib/wechat-article.ts src/lib/wechat-article.test.ts \
        src/lib/wechat-media.ts src/lib/wechat-media.test.ts \
        src/lib/publishing-platforms.ts src/lib/publishing-assets.ts \
        src/lib/publishing-routes.ts src/lib/publishing-service.ts \
        src/lib/publishing-store.ts src/app.ts src/app.test.ts \
        src/server.ts electron/server.ts electron/handlers/config-handler.ts \
        scripts/verify-wechat-mp.ts \
        renderer/src/pages/PublishingPage.tsx renderer/src/pages/SettingsPage.tsx \
        renderer/src/components/PublishPreviewDialog.tsx \
        renderer/src/components/CreateWechatArticleDialog.tsx \
        renderer/src/utils/publishing.ts renderer/src/services/api.ts \
        renderer/src/types/index.ts \
        docs/superpowers/specs/2026-09-18-wechat-mp-article-publish-design.md \
        docs/superpowers/plans/2026-09-18-wechat-mp-article-publish.md
git commit -m "feat: 微信公众号 AI 文章发布（官方 API 建草稿 + 人工确认）"
```
