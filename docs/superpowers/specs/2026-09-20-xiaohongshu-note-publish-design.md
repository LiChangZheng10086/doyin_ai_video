# 抖创工坊 小红书图文自动发布 设计规格

> 状态：设计已评审通过（骨架经用户确认 2026-09-20），**选择器待只读侦察校准**
> 前置调研：`docs/research/xhs-publish-projects-assessment.md`（17 个参考项目核实 + 平台公告原文 + 封号实证）
> 决策记录：① 只做只读侦察 + spec 先行；② `note` 渠道并成「图文（抖音 / 小红书）」；③ 新增 3:4 裁切（模块 `note-media.ts`，平台中立）；④ **先建共享的 90%，「是否真点发布」做成最后一步开关**

---

## 1. 背景与结论

### 1.1 我们要做什么

把小红书**图文笔记**接进既有发布中心，成为**第三条自动发布通路**（抖音图文走外部 `sau`、头条文章走自研执行器、小红书图文走新增的自研执行器）。

### 1.2 结论：技术上可行，但**风险等级是三条通路里最高的**

`xiaohongshu` 平台本身**早已存在**于我们的代码里（当年作为**人工交付**的视频平台接入）：`PublishPlatform` 已含它、`PUBLISH_PLATFORMS.xiaohongshu` 已有且口径与实测一致。本次补的是「图文自动发布」这半边。

**但必须先说清风险**（详见调研文档 §4）：

| 事实 | 来源 |
| --- | --- |
| 「通过 AI 托管工具…发布」或「主页所有公开笔记均为 AI 托管代发」→ **封禁** | 2026-03-10 治理公告原文 |
| AI 生成合成内容**未主动标识 → 限制分发** | 2026-02-12 公告 |
| 2026-07 通报：处置 **42 万**账号、拦截 **302 万**脚本账号、约 **13 万**「AI 托管发布」账号封号/禁言 | 平台通报 |
| **代发 1 篇当晚永封**；2 天、4 篇、6 篇/天即封；「仅自己可见」也不豁免 | 用户实证（V2EX、多个项目 issue） |
| **「点完发布后再去页面读回确认」本身被报为封号诱因**（警告 → 7 天） | `xiaohongshu-mcp` #715 |
| **没有面向个人的官方发布 API**（开放平台接口目录只有电商八类） | 已核实 |

**因此本 spec 的核心不是「怎么点发布」，而是「把不可逆的那一下关进闸门」。**

### 1.3 与抖音/头条通路的本质差别

抖音与头条的风险表述是「上游靠反检测手段对抗平台检测」；小红书是**平台公开声明要封这类账号**，且执法规模是公开数字。所以本设计**刻意偏离**头条范式两处（§9、§11），偏离必须写进代码注释，否则后人会当成漏做。

---

## 2. 已确认的设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 走**自研 Playwright 执行器**，驱动真实 `creator.xiaohongshu.com` | 逆向 API 路线不可行（签名一两周变一次、需 node 子进程 + 冻结指纹、已有 406 失效实测）；且我们已打包浏览器，零新增运行时依赖 |
| D2 | 图片**裁成 3:4（1080×1440）**，模块名 **`note-media.ts`**（平台中立）；**插在打包时**（方案甲，2026-09-20 拍板） | 场景静帧是 9:16；发布页原文「推荐上传 3:4 至 2:1 之间」。⚠️ **甲意味着所有图文包（含纯抖音包）的 `images/` 都是 3:4**，所以这个模块**不再是「小红书专用」** —— 名字与常量都不带平台前缀，否则三个月后会有人问「为什么纯抖音的包要过一遍小红书的东西」 |
| D3 | `note` 渠道并成**「图文（抖音 / 小红书）」**（`platforms: ['douyin','xiaohongshu']`） | 改动最小；渠道变多平台后 `channelPlatformOptions` **自动**长出平台下拉，符合既有「单平台渠道不显示平台下拉」的约定。**不**引入 `(contentType, platform)` 渠道身份，那条会推翻 AGENTS.md 的「渠道 = 内容类型」不变式 |
| D4 | **先建共享的 90%**（浏览器/登录/选择器/填表/裁图/声明勾选），**「是否真点发布」做成最后一步开关** | 两种姿态共享绝大部分实现，不必在证据不足时赌一把（§10） |
| D5 | **点完发布后不做读回** | #715 实证：读回确认本身触发警告/封禁。如实记 `unconfirmed`，由人工核实 |
| D6 | **不做**任何小红书侧的读取/采集/互动，**不做** cron 定时 | 只读同样出事（#726/#728/#777/#150）；cron 被点名（#680） |

---

## 3. 平台侧硬事实（已核实）

| 项 | 值 | 证据 |
| --- | --- | --- |
| 创作服务平台 | `https://creator.xiaohongshu.com/` | 实测可打开 |
| 发布页 | `https://creator.xiaohongshu.com/publish/publish?source=official&target=image` | 参考项目一致写法 |
| 登录页**默认是「短信登录」**，页面上**没有二维码**，须先点右上角切换图标 | 实测（本探针第一版被此坑到：把 64×64 的切换图标当成了二维码） | `storage/xhs/recon/` |
| 二维码元素 | `img.css-1lhmg90`（渲染 160×160 / 原图 196×196） | 实测 + 与 `jogholy/xhs-publisher:136` 交叉吻合 |
| 标题上限 | 20 字 | 已在 `PUBLISH_PLATFORMS.xiaohongshu` 里 |
| 正文上限 | 1000 字 | 同上 |
| **图片（发布页原文，一手）** | 「支持上传的图片大小，**最大 32MB** 的图片文件」「推荐使用 **png、jpg、jpeg、webp**，**不支持 gif、live** 及其转化后的图片」 | ✅ **2026-09-20 侦察实测** |
| **图片比例（发布页原文，一手）** | 「**不限制宽高比例**，推荐上传 **3:4 至 2:1 之间**、分辨率不低于 **720×960** 的照片」 | ✅ **2026-09-20 侦察实测** |
| ⇒ 对我们的含义 | 我们的静帧是 **1080×1920（9:16 ≈ 0.5625），落在推荐区间之外**（3:4 = 0.75 是最矮的一端）→ **§2 D2「裁成 3:4」由平台一手文字支持**，不再是第三方规格推测 | 同上 |
| **上传框（一手）** | 常驻且**唯一**：`<input class="upload-input" type="file" multiple accept=".jpg,.jpeg,.png,.webp">` —— **图片专用**（accept 只有图片），**不需要处理原生文件选择框** | ✅ 2026-09-20 侦察实测 |
| ⚠️ **页面是分阶段渲染的** | 「仅上传区」阶段 DOM 里**完全没有** 标题框 / 正文编辑器 / 话题 / 发布按钮 / 声明控件（`标题`、`话题`、`合成`、`声明`、`原创`、`存草稿` 命中数**均为 0**，且全页**没有任何 `placeholder` 属性**）→ **必须先上传图片，表单才会出现** | ✅ 2026-09-20 侦察实测 |
| ⇒ 对 §7 的致命含义 | 跨项目共识的 `input[placeholder*="标题"]` **在当前页面不可能命中**（全页 placeholder 数为 0）—— 4 个参考实现的标题选择器**已全部过期** | 同上 |
| 图片张数上限 | **18 张**（第三方汇总；上传阶段页面未展示张数） | **待复核** |
| 存草稿 | 侧栏有「**草稿箱(0)**」，DOM 存在 `header-draft` / `draft-title-box` / `draft-title`；但上传阶段**没有「存草稿」文案** | **待上传后复核** |
| AI 标识 | 发布环节须主动标识，未标识限制分发 | 2026-02-12 公告 |
| AI 标识控件 | ⚠️ 上传阶段 DOM 中**不存在**（`合成`/`声明`/`内容类型`/`原创` 均为 0）| **待上传后复核** |
| 官方发布 API | **不存在**（开放平台只有电商八类） | 已核实接口目录 |

---

## 4. 后端架构：第四个执行器

与头条四件套**同形**（这是刻意的：形状一致才好复用纪律与测试范式）。

| 新模块 | 职责 | 参照 |
| --- | --- | --- |
| `src/lib/xhs-browser.ts` | 浏览器解析链：显式配置 → env（`XHS_BROWSER_BINARY`）→ vendor → Playwright 缓存 → 系统 Chrome；**分有头 / 无头两条**（发布用打包的 headless shell，扫码兜底用系统 Chrome） | `toutiao-browser.ts` |
| `src/lib/xhs-page.ts` | 发布页选择器与**页面步骤**（每步读回） | `toutiao-page.ts` |
| `src/lib/xhs-runner.ts` | 扫码登录会话 + 发布编排 + 结果**不**校验（§9） | `toutiao-runner.ts` |
| `src/lib/note-media.ts` | 9:16 → 3:4 裁切（ffmpeg `scale+crop`，产物大小校验，失败即删不留半成品）。**平台中立**：按方案甲，所有图文包都走它 | `toutiao-media.ts` |

**新增错误类**：`XhsRunnerError` / `XhsBrowserError` / `XhsPageError` / `XhsMediaError`（各带 `status` + `code`）。
⚠️ **必须同时登记进 `publishing-routes.ts` 的错误边界** —— 头条那次事故（AGENTS.md 有记）就是漏登记 → 全落兜底 500「发布服务暂时不可用」，**指引整条丢掉**。用例：`xhs runner errors surface with their own status, code and guidance`。

---

## 5. 平台登记：后端只缺 4 处 + 1 条守卫用例

| 位置 | 现状 | 改动 |
| --- | --- | --- |
| `publishing-platforms.ts:99-108` `PUBLISH_NOTE_POLICIES` | 只有 `douyin` | 加 `xiaohongshu`（title 20 / 正文 1000 / 话题 10） |
| `publishing-platforms.ts:240-247` `AUTO_PUBLISH_ROUTES` | `note×douyin→sau`、`article×toutiao→toutiao` | 加 `note×xiaohongshu → engine "xhs"` |
| `publishing-platforms.ts` `AutoPublishEngine` | `"sau" \| "toutiao"` | 加 `"xhs"`（联合类型自动扩展） |
| `publishing-service.ts:1853` `NOTE_PLATFORMS` | `new Set(["douyin"])` | 加 `xiaohongshu`；`assertNotePlatforms` 的 422 文案同步改 |
| `publishing-service.ts:330` | 默认文案硬编码取 `PUBLISH_NOTE_POLICIES.douyin` | 改成按平台取 |
| `publishing-platforms.test.ts:112-118` | `assert.deepEqual([...NOTE_PLATFORMS], ["douyin"])` | **如期会被打破**（这正是它存在的意义），改为断言「含 douyin 与 xiaohongshu、不含 wechat_mp/toutiao」 |

### 5.1 ⚠️ 分派处的静默陷阱（必须显式处理）

`publishing-service.ts` 现在的分派是：

```ts
if (engine === "toutiao") return this.autoPublishToutiaoArticle(...);
return this.autoPublishNoteTask(...);   // ← 兜底送给 sau
```

**新增 `"xhs"` 后，如果不加分支，小红书会被静默路由到 `sau`（外部 CLI）**，表现是「报未配置 sau」这种莫名其妙的错误。所以必须：

```ts
if (engine === "toutiao") return this.autoPublishToutiaoArticle(...);
if (engine === "xhs") return this.autoPublishXhsNote(...);   // ← 必须在兜底之前
return this.autoPublishNoteTask(...);
```

并加一条用例：`note × xiaohongshu 走 xhs 执行器，且不会碰到 sau runner`。

---

## 6. 包模型与指纹

### 6.1 复用图文包，不新建内容类型

小红书图文复用既有 `contentType: "note"` 的包（`imagePaths` + `noteCopy`），与抖音图文同形。**不**新增内容类型。

### 6.2 新增 `xhsOptions`

```ts
interface XhsNoteOptions {
  /** AI 合成内容标识：**必须真的勾上并读回**（未标识会被平台限制分发）。 */
  aiDeclaration: boolean;
  /** 最后一步开关：true = 点「发布」；false = 填完即停在提交前（姿态乙，见 §10）。 */
  submit: boolean;
}
```

挂在包记录上（与 `toutiaoOptions` 同位置），**参与 `previewRevision`** —— 否则「预览时没勾 AI 标识、提交时勾了」不会被拦下。

### 6.3 ⚠️ 指纹兼容性：新字段**只在存在时**参与哈希

`packagePreviewRevision()` 的 `contentType === "note"` 分支现在哈希 `imagePaths` + `noteCopy`，而**抖音图文包的 revision 已有既有断言**。如果无条件追加 `aiDeclaration:0`，**所有既有抖音图文包的 revision 都会变**，既有断言会红 —— 而且那种红是「指纹口径被悄悄改了」，不是「功能坏了」。

因此：**`xhsOptions` 仅在 `!== undefined` 时哈希**，并加一条回归用例：

- `不含 xhsOptions 的图文包，其 previewRevision 与本次改动前逐字节相同`。

---

## 7. 页面步骤与选择器（**2026-09-20 已实测校准一部分**）

> ⚠️ 下表是**跨 4 个参考项目收敛出来的候选**，最新也只到 2026-09-10、多数是 2026-03；而**8 个参考实现没有一个做过提交前读回**，所以它们只能当线索。
> **本表的真源是侦察产物**，命令：
> ```bash
> node --import tsx scripts/probe-xhs-publish-page.ts --tab
> # 产物：storage/xhs/recon/publish-page.html 与 storage/xhs/recon/selectors.json
> ```
> 校准前不得写入 `xhs-page.ts` 作为「已验证选择器」。

### 7.0 侦察实测结论（2026-09-20，两轮 + 一次上传后）

真实 DOM 快照在 `storage/xhs/recon/`（`publish-page.html` / `publish-page-after-upload.html`，各约 1.3–1.4MB）。

**① 页面是分阶段渲染的 —— 这是本条通路最反直觉的一件事。**

| 阶段 | DOM 里有什么 |
| --- | --- |
| 进图文页签（**未上传**） | **只有上传区**：可见文本「上传图片，或写文字生成图片」+ 三条图片规格 + 两个按钮「上传图片／文字配图」。**标题框、正文编辑器、话题、发布按钮、声明控件全部不存在**（`标题`/`话题`/`声明`/`存草稿` 命中数均为 0） |
| **上传一张图之后** | 表单出现：标题框、正文编辑器、工具栏（话题/用户/表情）、内容设置、更多设置、笔记预览… |

**② 一处必须更正我先前的判断。** 我在第一轮只看到「未上传」阶段，据此写下「4 个参考实现的标题选择器已全部过期」——**这句话是错的**。上传后实测：

- `input[placeholder*="标题"]` **命中 1**，真实元素是 `input.d-text[placeholder="填写标题会有更多赞哦"]`；
- 正文是 `div.tiptap.ProseMirror[contenteditable="true"]`，空态段落 `p.empty.is-editor-empty`，`data-placeholder="输入正文描述，真诚有价值的分享予人温暖"`。

⇒ **跨项目共识的标题/正文选择器在当前页面是有效的**，前提是**先上传图片**。真正的坑不是「选择器过期」，而是**「在错误的阶段去找它们，得到的是 0 命中」**——这会让实现者误判为「页面改版了」。

**③ 上传框比预期简单**：`<input type="file" hidden multiple accept=".jpg,.jpeg,.png,.webp">`，**常驻且唯一**（页面共 3 个 file 框：两个图片、一个文档 `.pdf/.doc/.docx/.ppt/.pptx`）。⇒ **必须按 `accept` 挑**，但**不存在**参考项目说的「第一个是视频框」问题，也不需要处理原生文件选择器。

**④ ✅ 提交控件的真相：它不是 `<button>`，而是一个带「封闭 shadow root」的自定义元素。**

这是本轮最难查、也最重要的一条。排查轨迹与结论：

| 排除掉的假设 | 怎么排除的 |
| --- | --- |
| 「校验门控」（内容有效才渲染） | ❌ 把标题、正文、AI 声明**全部真的填进去**后仍然找不到 |
| 「懒挂载」（滚到才插入 DOM） | ❌ `scrollHeight === innerHeight === 900`（**文档根本不滚动**），逐屏下滚 10 屏候选数不变（24 个，全是既有节点） |
| 「在 iframe 里」 | ❌ `frames` 只有 2 个：主 frame 与一个空的 `about:blank` |
| 「在 shadow DOM 里，穿透即可」 | ❌ `shadowHostCount === 0`（在**未上传**态查的，那时元素还不存在） |

**真实结构**（从原始 HTML 的 `submit-text=` 属性找到的）：

```html
<xhs-publish-btn is-publish="true" is-save-draft="true"
  submit-text="发布" save-text="暂存离开"
  submit-disabled="false" submit-loading="false" save-disabled="false">
</xhs-publish-btn>
```

- 它**只在上传图片之后出现**（未上传态 0 命中）；
- `customElements.get("xhs-publish-btn")` **返回已定义**，但 `element.shadowRoot === null` **且没有任何子节点** ⇒ **closed shadow root**（`mode: "closed"`）；
- ⇒ **`page.content()` 序列化不到、`document.querySelectorAll` 看不到、Playwright 的 CSS/role 定位器也不穿透**（实测 `getByRole("button", { name: "发布" })` = **0**、`xhs-publish-btn >> text=发布` = **0**）。

**⇒ 这解释了为什么 4 个参考实现的选择器全部失效**：`button.publishBtn`、`div.publish-page-publish-btn button`、`button:has-text("发布")` 找的都是一个**不存在于任何可查询子树里的 `<button>`**。

✅ **用「截图宿主元素」看清了里面有什么**（`storage/xhs/recon/submit-host.png` / `submit-area.png`）：底部并排两个按钮 ——
**「暂存离开」**（白底描边，= 保存草稿并离开）与 **「发布」**（红色实心主按钮）。

**落地策略（姿态甲）**：宿主几何 680×90，两个按钮的**中心相对偏移**实测为
**「发布」≈ (0.607, 0.5)**、**「暂存离开」≈ (0.396, 0.5)** ⇒ 只能**按宿主包围盒 + 相对偏移做坐标点击**。
**失败模式是良性的**：万一偏移没命中「发布」而落到「暂存离开」，结果是**存草稿离开**，不会误发。

⚠️ 另外：`save-text="暂存离开"` 说明**「存草稿」的真实文案是「暂存离开」**（按「存草稿」搜是 0 命中的原因），
⇒ 姿态乙其实**既有平台自动存草稿、也有一个显式的「暂存离开」按钮**可点。

**⑤ 合规控件确实存在（好消息）**：「添加内容类型声明」是一个 **`div.d-select-wrapper` 下拉**（注意页面自己的 HTML 里属性写错了：`lass="declaration-wrapper"`，所以按 `class="declaration-wrapper"` 找不到），其选项文案包含「**笔记含AI合成内容**」「虚构演绎，仅供娱乐」「内容包含营销广告」等，选项节点是 `div.d-option`。⇒ §11 的合规要求**可满足**。

**⑥ 其它实测确认**：图片计数显示「**1/18**」→ 18 张上限确认；正文「**0 /1000**」→ 1000 字确认；有「定时发布」开关（`div.post-time-wrapper`，**我们不实现定时**）；有「公开可见 / 仅自己可见 / 仅互关好友可见」可见性选择；**没有「存草稿」按钮**。

**⑦ 上一轮的图片没有被恢复**：不带 `--upload-dummy` 再进发布页，表单**又是空的**（回到只有上传区的状态）。⇒ 平台的**未完成笔记不会自动回到发布页**（至少没点过任何保存时不会）。

---

### 7.1 已验证的选择器（2026-09-20 实测，可直接用）

> 这些是**实测命中**的，与上面「候选表」（尚未逐条验证）区分开。

| 用途 | 选择器 | 实测 |
| --- | --- | --- |
| 进图文页签 | 文案为「上传图文」的 `.creator-tab`（点 `span.title` 亦可） | 命中 4，页签类 `creator-tab active` |
| 图片上传框 | `input[type="file"][accept*=".jpg"]`（**按 accept 挑，勿取 `.first`**） | 3 个 file 框，图片的带 `multiple` |
| 标题 | `input.d-text[placeholder*="标题"]`（或 `div.d-input input`） | 命中 1，`placeholder="填写标题会有更多赞哦"` |
| 正文编辑器 | `div.tiptap.ProseMirror[contenteditable="true"]` | 命中 1（`div.ProseMirror` 同样命中） |
| 话题入口 | `button#topicBtn.contentBtn.topic-btn`（**工具栏按钮**，不是「在编辑器里打 #」） | 命中 1，文案「话题」 |
| 内容类型声明 | `div.d-select-wrapper`（⚠️ 容器上 `class` 属性被写成 `lass`） | 命中 1，文案「添加内容类型声明」 |
| 声明选项 | `div.d-option` | 命中 5+，含「笔记含AI合成内容」 |
| 定时发布开关 | `div.post-time-wrapper` | 命中 1，**本设计不使用** |
| **提交控件（宿主）** | `xhs-publish-btn`（自定义元素，**只在上传后出现**） | 命中 1；`submit-text="发布"`、`save-text="暂存离开"`、`submit-disabled="false"` |
| **提交按钮本身** | ❌ **无 CSS/role 选择器可用**（closed shadow root；`getByRole`=0、`>> text=`=0） | 只能**按宿主包围盒 + 相对偏移坐标点击**（见 §7.0 ④） |
| 存草稿 | 同宿主的「暂存离开」（相对偏移 ≈ (0.396, 0.5)） | 实测按钮文案就是「暂存离开」 |

| 步骤 | 候选 | 共识度 | 读回要求 |
| --- | --- | --- | --- |
| 进图文表单 | 点文案为「上传图文」的**叶子节点**（不用 class） | 3/3 | 表单出现（标题框/编辑器存在） |
| 图片上传 | 常驻 `input[type="file"]` + `setInputFiles`；⚠️ **第一个 file 框是视频框**，须按 `accept` 含图片或带 `multiple` 挑选 | 4/4 | **图片预览计数** `.img-preview-area .pr` 或 `.img-container, .pr, .preview-item` **≥ 送入张数** |
| 标题 | `input[placeholder*="标题"]` → 兜底 `div.d-input input` | 4/4 | **清空后写入，断言读回 == 要发的标题**（持久化 profile 可能恢复上次草稿） |
| 正文 | `div.ProseMirror[contenteditable="true"]` / `div.tiptap.ProseMirror`（TipTap） | 3/4 | 编辑器纯文本里能找到**首段与末段** |
| 话题 | 在编辑器内打 `#词` → 等联想 → 点首项；失败**退化**为纯文本标签 | 2/2（**无稳定联想容器**） | 读回编辑器文本含该话题 |
| AI 标识声明 | 文案候选：「添加内容类型声明」「内容类型声明」「AI合成内容」 | 1/1（仅一个项目） | **勾选后读回**；改不掉就 fail closed |
| 发布按钮 | 按文案「发布」**精确**匹配（页面还有「发布笔记」「定时发布」） | 3/4 | 见 §9（**点完不读回**） |

**已被时间判死、不要抄**：`填写标题`、`填写能获得更多赞哦`（与头条「填写作品标题→添加作品标题」同型，只有 `*="标题"` 活下来）；`div.ql-editor`（Quill 时代残留）。

### 7.2 侦察问题的状态（更新到 2026-09-20 第二轮）

| # | 问题 | 状态 |
| --- | --- | --- |
| 3 | **9:16 会不会被强裁 / 该裁成什么比例** | ✅ **已回答（一手）**：页面原文「不限制宽高比例，推荐上传 3:4 至 2:1 之间、分辨率不低于 720×960」→ **我们的 9:16 在推荐区间之外**，**裁成 3:4 是对的**（§2 D2 成立） |
| 1 | **AI 合成内容标识控件的文案与 DOM 形态** | ✅ **已回答**：`div.d-select-wrapper` 下拉（页面把 class 写成 `lass`），选项 `div.d-option` 含「**笔记含AI合成内容**」→ §11 的合规要求**可满足**，且**必须真的选中并读回** |
| 4 | **话题入口** | ✅ **已回答**：是工具栏按钮 `button#topicBtn.contentBtn.topic-btn`（**不是**参考项目说的「在编辑器里打 `#`」）；联想弹层的容器**仍未取得**，退化路径（写成正文纯文本）仍要保留 |
| 2 | **是否存在「存草稿」或自动保存** | ✅ **已回答（实测，且结论对我们有利）**：页面上**没有**「存草稿」按钮，但 `--dry-run`（只填标题+正文+勾声明、不点发布）之后，创作中心首页出现「**草稿箱中有未发布的作品**」与「**编辑最新笔记**」⇒ **平台会为填过的内容自动存草稿** ⇒ **姿态乙成立**（§10） |
| 5 | **提交按钮的选择器** | ✅ **已回答（见 §7.0 ④）**：是 `<xhs-publish-btn>` 自定义元素 + **closed shadow root**，没有任何可查询的按钮选择器 ⇒ **按宿主包围盒做相对坐标点击**（「发布」≈(0.607,0.5)）；失败模式良性（落到「暂存离开」＝存草稿） |

---

## 8. 登录通路

- **持久化 profile**：`storage/xhs/profile`（**必须在 storage 内**，与头条同纪律；登录态不许落到 storage 之外）。
- **默认短信登录 → 必须先切扫码**（§3 实测）：
  `img.css-wemwzq` 是**切换图标**不是二维码；切换成功的判据是**出现更大的二维码元素**（面积 ≥20000），否则如实报失败。
- **二维码会先于我们的等待窗口过期** → 主动检测「二维码已失效／点击刷新」文案并刷新，把**新码**落盘（探针已实现，`saveQrPng` 的面积门槛防止再次误取图标）。
- **登录态判定：页面信号优先于 cookie**（`access-token-creator` / `galaxy_creator_session_id` **未登录访客也会被种**）：`READY ∧ ¬BLOCKER`，cookie 只作旁证。沿用头条的「**重试后才作数**」纪律（那次假阴性让用户去重扫了一个好码）。
- 两条入口（与头条同形）：① 打开**浏览器窗口**扫码（有头，用系统 Chrome）；② **应用内扫码**（无头取二维码 + 轮询）。

---

## 9. 结果语义：⚠️ **刻意不做读回**

| | 抖音 / 头条（既有） | 小红书（本设计） |
| --- | --- | --- |
| 点完发布后 | `submitAndConfirm` **继续读回**：抓确认后 URL、是否离开页面、可见文案头尾摘要，写进 `autoPublish.message` | **点完即断开**：不抓 `postConfirm`、不轮询成功文案 |
| `verification` | `confirmed`（命中判据）/ `unconfirmed` | **恒为 `unconfirmed`** |
| 核实动作 | 程序读回 + 人工到后台核实 | **只由人工**在真机 / 真浏览器里核实 |

**理由**：`xiaohongshu-mcp` #715 ——「我用发布是没问题的，有两次让 ai 确认一下发布成功了没有，第一次警告第二次七天」。平台检测的是**自动化访问模式**，点完还去页面里翻看正落在这个模式里。

**代价要说清楚**：我们会比头条那条通路拿到**更少的证据**，`unconfirmed` 是**常态而非例外**。界面文案必须据此写：不是「发布失败」，而是「**已提交，请到小红书 App 核实**」。

`task.status` **全程不变**（`succeeded` 只表示已提交，绝不写 `published`）—— 与抖音/头条**逐字相同**的不变式。

---

## 10. 姿态开关（D4）

> **2026-09-30 实测修正（优先于本节原结论）**：草稿仅存在同一浏览器 profile 的 `draft-database-v1/image-draft` IndexedDB 中，不同步到 App 或默认浏览器。原「填表即可保证自动保存」结论不足：用户本次草稿有标题与 10 张图片，但持久化正文为空，执行器却返回成功。`submit:false` / `dryRun:true` 现在必须点「暂存离开」，核实当前账号、本次时间及标题/正文/图片/AI 声明完整后才写成功和 `xhsDraftId`；核实失败写 failed。真人使用「打开小红书草稿浏览器」（同 profile）→「图文笔记」核对和发布。旧成功记录仅提示待核实。此核实只读本地 IndexedDB，仍不在正式点击发布后自动访问/确认笔记。


`xhsOptions.submit` 是最后一步的开关：

| | `submit: true`（姿态甲） | `submit: false`（姿态乙） |
| --- | --- | --- |
| 执行器行为 | 填表 → 勾标识 → 点「发布」 | 填表 → 勾标识 → **停手** |
| 与公告关系 | 正落在两条封禁口径上 | 不直接冲突（发布主体是人） |
| 实测证据 | 1 篇即永封 / 2 天即封 / cron 即封 | **无**（主要不确定性） |

**依赖侦察的决策分支 —— 已于 2026-09-20 用实测回答，结论对我们有利：**

- ✅ **姿态乙成立，而且是被真机演练验证的**：`--dry-run` 只填了标题 + 正文 + AI 声明（**没点发布**），随后创作中心首页出现「**草稿箱中有未发布的作品**」+「**编辑最新笔记**」。⇒ **平台会自动为填过的内容存草稿**，人工之后打开草稿箱点发布即可。
- 这与 §4 的风险结论叠加后意义很大：**风险最低的姿态恰好是这个平台原生支持的**（填到草稿 → 真人点最后一下），不是我们自己造出来的折中。
- ⇒ **默认 `submit: false`（姿态乙）现在有实证支持**，不再只是"保守选择"；姿态甲（点发布）仍是可选项，但要走 §11 的全部闸门。
- 待办：我们那次演练在**用户账号的草稿箱里留下了一条「测试标题（可删除）」草稿** —— 见 §17。

**默认值**：`submit: false`（先保守；要开自动提交必须由用户在每个包上显式打开，并经过预览确认）。

---

## 11. 风险与合规（必须进产品文案）

| 措施 | 具体做法 |
| --- | --- |
| **AI 标识** | `aiDeclaration` **默认 `true`**；必须真的勾上并读回；勾不上/改不掉 → **fail closed，不提交**（照 `ensureWeitoutiaoUnchecked` 的范式：已是目标状态就不点 → 不是就点 → 读回 → 改不掉才失败） |
| **⚠️ 页面上根本没有 AI 标识控件** | **一律拒绝自动提交**（错误码 `xhs_page_ai_declaration_missing`）：我们的内容整条都是 AI 生成的，平台口径是「未主动标识 → 限制分发」，所以「发一条没标识的 AI 笔记」不是「降级成功」而是**违规发布**。此时只提供姿态乙或人工交付 |
| **频率闸门** | 服务端硬拦：**每日 ≤1 篇**。「每日」按**本地自然日**（`Asia/Shanghai` 本地时区）计算，统计当日 `succeeded` 的小红书 `autoPublish` 记录数；超限 422 并说明原因。**文案里必须写明：这只是降低概率，不是安全保证**（有 1 篇即永封的案例） |
| **并发互斥** | 运行中再次触发 409；遗留 `running` 超 30 分钟视为进程已死（沿用既有阈值） |
| **绝不自动重试** | 失败后必须人工再点（人知道上一次到底发出没有） |
| **不做采集/互动/定时** | 不实现任何小红书侧读取、搜索、评论、私信、点赞、收藏；不实现 cron/定时发布 |
| **风险告知** | 界面必须写明：**风险由账号承担，平台可封号**；不承诺安全 |

---

## 12. 明确不做

- 小红书**视频**笔记、长文、商品/蒲公英相关能力。
- 自动注册、自动互动（评论/私信/点赞/收藏/关注）。
- **任何小红书侧的读取与采集**（含笔记搜索、数据看板）。
- 定时 / cron 到点自动发布。
- 逆向私有 API 路线（§2 D1）。
- 复用日常 Chrome profile（实测：大 profile 上 `launch_persistent_context` 50 秒不出窗口；`connect_over_cdp` 被 Chrome 136+ 拒绝）—— 必须用专用 profile 目录。
- **发布后读回**（§9，刻意不做）。

---

## 13. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | `XhsNoteOptions`；`DeliveryPackage.xhsOptions`；`AutoPublishEngine` 加 `"xhs"`（若定义在此） |
| `src/lib/publishing-platforms.ts` | `PUBLISH_NOTE_POLICIES.xiaohongshu`；`AUTO_PUBLISH_ROUTES` 加 `note×xiaohongshu` |
| `src/lib/publishing-store.ts` | `packagePreviewRevision` 的 note 分支加 `xhsOptions`（**仅存在时**）；存档校验接受新字段 |
| `src/lib/publishing-service.ts` | `NOTE_PLATFORMS` 加平台；`assertNotePlatforms` 文案；`:330` 默认文案按平台取；**分派加 `engine === "xhs"` 分支**；`autoPublishXhsNote`（频率闸门、AI 标识校验、图片 ≤18 校验、镜像 sha256 比对）；所有异常落 `failed` |
| `src/lib/xhs-browser.ts`、`xhs-page.ts`、`xhs-runner.ts`、`note-media.ts`（新增） | 见 §4 |
| `src/lib/publishing-routes.ts` | **登记 Xhs* 错误类**；`contentType` 白名单无需改（note 已在） |
| `src/lib/fixtures/xhs-publish-page.html`（新增） | 离线 fixture，从侦察快照逐段抠出来 |
| `scripts/probe-xhs-publish-page.ts`（已新增） | 只读侦察探针（已实测可用） |
| `renderer/src/utils/publishing.ts` | `PUBLISH_CHANNELS` 的 note 渠道改为双平台、标签改「图文」 |
| `renderer/src/pages/PublishingPage.tsx` | 「提交到小红书」（必经预览）；姿态乙下的「填写到小红书（不提交）」；频率超限提示；风险告知文案 |
| `renderer/src/components/CreateNotePackageDialog.tsx` | AI 标识声明 + 是否提交的选项（进 `previewRevision`） |
| `renderer/src/components/PublishPreviewDialog.tsx` | 图文包预览显示 xhs 选项与 18 张上限校验 |
| `src/app.ts`、`src/server.ts`、`electron/server.ts` | `XHS_BROWSER_BINARY` / `XHS_PROFILE_DIR` 透传（两条入口） |

---

## 14. 测试与验证

| 类别 | 内容 |
| --- | --- |
| 平台登记 | `NOTE_PLATFORMS` 守卫用例更新；`AUTO_PUBLISH_ROUTES` 三组合互不触碰 |
| **分派** | `note×xiaohongshu` 走 `xhs` 执行器、**不碰 sau runner**（§5.1 的坑） |
| **指纹兼容** | 不含 `xhsOptions` 的图文包 revision **逐字节不变**（§6.3） |
| 指纹生效 | 改 `aiDeclaration` / `submit` → 旧 revision 失效（409） |
| 页面步骤 | **真浏览器 + 离线 fixture**（照 `toutiao-page` 那 18 项的范式）：每步读回、文件框挑错即报错、AI 标识勾不上 → fail closed 且**一个提交按钮都没被点过** |
| ⚠️ 不读回 | 用例断言**点完之后没有向页面发起任何读取**（§9 的反向断言） |
| 频率闸门 | 当日第 2 篇 → 422，且**不产生 autoPublish 记录** |
| 图片上限 | >18 张 → 422（按小红书口径，不是抖音的 35） |
| 裁切 | `note-media` 用**真实 ffmpeg 实测一次**（1080×1920 → 1080×1440，源文件 sha256 前后一致，失败不留半成品）—— stub 证明不了滤镜语法（公众号那轮的教训） |
| 错误边界 | Xhs* 错误带自己的 `status` + `code` + 指引（不是兜底 500） |
| 失败落库 | 启动失败、意外原始错误 → 都记 `failed`，绝不 500 + 卡 `running` |
| 回归门禁 | 既有 publishing 全量用例通过；视频包 manifest 精确哈希 baseline 不变 |

**验证命令**：`npm run check`、`npm test`、`npm run build:backend`（+ `build:electron`，若动了 `electron/server.ts`）。
**生效条件**：后端改动必须 `npm run build:backend` 再重启；Electron 需整体重启。
**真机路径**：先 `--dry-run`（填完不点发布）→ 再由**用户本人**决定是否真实提交。

---

## 15. 未决 / 待侦察回答

1. ✅ **提交按钮**（§7.0 ④ / §7.2 #5）：**已解决** —— 它是 `<xhs-publish-btn>` 自定义元素（**closed shadow root**），只能按宿主包围盒做相对坐标点击。**实现时必须写清「为什么不能用选择器」**，否则后人会以为是偷懒。
   ⚠️ 残留风险：坐标依赖布局（视口宽 1440 下的实测值）。**实现时要在点击前校验宿主存在且 `submit-disabled === "false"`**，并在点不到时**如实返回 `clicked: false`**（绝不写「已提交」）。
2. ✅ **姿态乙是否可行 —— 已定论：成立**（§10，实测「草稿箱中有未发布的作品」）。
3. **话题联想弹层的容器选择器**：已找到入口（`#topicBtn`），但弹层 DOM 未取到；退化路径（正文纯文本标签）必须保留。
4. 小红书是否对**无头浏览器**有额外检测：目前无头**能正常登录与进发布页**（未遇风控页），但这只是「没被拦」，不等于「不会被识别」。
5. 「仅存草稿不点发布」是否能免于风控处罚 —— **无任何实测证据**，本设计不假设它能。
6. 图片尺寸下限（页面写「分辨率不低于 720×960」）对我们 1080×1440 无影响；**单图 32MB 上限已确认**（非第三方说的 20MB）。
7. ⚠️ **3:4 裁切插在哪一步（待用户拍板）**：**已于 2026-09-20 拍板为方案甲（打包时裁）**，并据此把模块改名为平台中立的 `note-media.ts`。
   —— **选定甲**。随之而来的两件事已落地/已排期：
   ① 模块改名 `note-media.ts` 并去掉平台专属常量（18 张与格式白名单留在小红书那侧）**已完成**；
   ② **把裁切接进打包层**（`createNotePackageAssets` / `stageNoteContent`）**尚未做**，已作为 Task 7 的显式步骤。
   ⚠️ 它**会改变既有抖音图文包的图片**（那条路原先直接用 9:16 静帧），所以 Task 7 要有一条回归用例断言
   「打包产物是 1080×1440」以及「既有视频包一字不变」。

---

## 16. 与调研文档的关系

本文档只写「我们怎么做」；风险证据、17 个参考项目的核实、封号案例与平台公告原文全部在
`docs/research/xhs-publish-projects-assessment.md`。**改本设计前先读那份 §4**。

---

## 17. ⚠️ 侦察在用户账号里留下的东西（必须清理）

本轮侦察**在你的小红书账号里留下了真实痕迹**，如实记录如下（都由你授权后产生）：

| 遗留物 | 来源 | 怎么处理 |
| --- | --- | --- |
| **草稿箱里 1 条草稿**，标题「**测试标题（可删除）**」，正文以「这是只读侦察演练写入的占位正文」开头 | `--dry-run`（填假内容、**未点发布**） | 到创作中心「笔记管理 → 草稿箱」删掉，或在 App 里删。**不要发布它** |
| 上传上去的**纯灰色 1080×1440 假图**（共 2–3 张，非用户素材） | `--upload-dummy` | 随草稿一起删；若图片进了素材库，也一并清掉 |
| 本地 `storage/xhs/profile`（登录态）、`storage/xhs/recon/`（DOM 快照与选择器报告） | 探针 | **保留**：profile 让后续不用再扫码，recon 是选择器的证据来源。**不要提交进 git**（`storage/` 本就在 `.gitignore` 里） |

⚠️ **未发生的事**：全程**没有点过「发布」**，没有选话题，没有填真实内容，没有自动互动/采集。
⇒ 账号状态应仍是干净的（只有一条草稿），但**请你自己在 App 里确认一次**。

## 2026-10-08：可见的本地草稿入口

用户截图中的视频交付包只有外链图标，无法发现专用草稿浏览器。所有小红书图文/视频任务增加独立文字按钮“查看本地草稿”，不依赖填稿成功、任务发布状态或 AI 声明；垃圾桶不提供。复用现有专用 profile 和草稿窗口 API，窗口已打开时切到前台。原平台打开动作保留，查看操作不填写、不保存、不发布。
