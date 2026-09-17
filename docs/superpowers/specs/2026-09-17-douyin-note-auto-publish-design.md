# 抖创工坊 抖音图文自动发布 设计规格

**状态：** APPROVED
**批准日期：** 2026-09-17
**日期：** 2026-09-17
**产品：** 抖创工坊
**范围：** 把已生成的交付包以「抖音图文」形式自动提交发布，人工确认结果
**实施边界：** 只新增图文这一条发布通路；不动视频发布、不动现有任务状态机、不内置外部依赖

## 1. 背景与结论

发布中心目前只做「人工交付」：准备交付包、校验文案、打开平台上传页，最后一步由人做。本次把**抖音图文**这一步自动化，视频与其它平台暂不做。

实施方式：调用开源项目 [social-auto-upload](https://github.com/dreammis/social-auto-upload)（MIT，15k star）的 `sau` CLI 作为**外部引擎**，与项目现有的 yt-dlp / ffmpeg / whisper-cli / hyperframes 同模式。

### 1.1 已完成的最小可行性验证（2026-09-17）

| 验证项 | 结果 |
| --- | --- |
| 现有 cookie 能否复用 | **能**。把 `~/.douyin-ai-video/douyin-cookie.txt` 的 Cookie 头（59 段）转成 Playwright `storage_state` 后，`sau douyin check --account mine` 输出 **`valid`**（退出码 0） |
| 阴性对照 | 同流程把 `sessionid`/`sid_*`/`ttwid` 换假值 → **`invalid`**（退出码 1），证明校验器有真实判别力 |
| 是否发布过内容 | **没有**。全程只做登录态校验 |

### 1.2 上游的三处已知问题（必须在引导文案里覆盖）

1. **按官方安装步骤装完 CLI 起不来**：`pyproject.toml` 只声明 `patchright`，但 7 个 uploader（tk/tk_chrome/alipay/hupu/weibo/xhs/baijiahao）与 `myUtils/auth.py`、`myUtils/login.py` 仍在 `import playwright`，而 `sau_cli.py` 在 import 阶段加载全部平台 → `ModuleNotFoundError: No module named 'playwright'`。需手动补装 `playwright`。
2. **Python 版本**：`requires-python = ">=3.10,<3.13"`，需 3.12（本机 3.13 不在范围内）。
3. **体积** ≈ 970MB（仓库+venv 444MB、patchright chromium 525MB）。

## 2. 已确认设计决策

| 决策 | 结果 |
| --- | --- |
| 范围 | 只做抖音**图文**（`upload-note`）；视频与多平台以后再说 |
| 依赖交付 | **用户自装 + 我们检测引导**（不内置 970MB） |
| 触发方式 | **人工点击**「发布图文到抖音」，不做排期全自动 |
| 结果认定 | CLI 退出码 0 **只算"已提交"**；最终由人点现有「标记已发布」确认 |
| 图文素材 | 复用已有的场景静帧，**零新增渲染** |
| 包模型 | `DeliveryPackage` 加 `contentType`，不新建并列类型 |
| 任务状态机 | **一个状态都不加**，用任务上的 `autoPublish` 子记录表达机器动作 |
| 失败重试 | **不自动重试** |
| **发布前预览** | **通用预览**（视频包 + 图文包），弹窗形态；图文自动发布**必经确认**（见 §14） |
| **必经确认的实现** | `auto-publish` **必须带 `previewRevision`**，后端比对不一致返回 409 —— 做成真约束而非 UI 装饰（见 §14.3） |

## 3. 素材来源（已实测）

应用生成视频时已经执行 `hyperframes snapshot --at <各场景中点>`（`src/lib/hyperframes-video.ts:166`），产物已落在磁盘：

```
output/videos/{jobId}/hyperframes/snapshots/
  frame-00-at-3s.png … frame-10-at-58.2s.png     11 张，各 1080×1920，约 500KB，合计 5.4MB
  contact-sheet-1.jpg / contact-sheet-2.jpg
```

- 文件名里的 `frame-NN` 即**场景序号**，排序稳定。
- 抖音图文上限 35 张，11 张在范围内。
- 与成片、`cover.jpg`（同为 1080×1920）同源同风格。

因此图文素材 = 按场景序排列的静帧，无需新增渲染管线。

> **2026-09-17 修正（素材库）**：`docs/superpowers/specs/2026-09-17-asset-library-design.md` 引入了手动上传的素材库，因此本节的结论**不再唯一**：图文图片有两种来源**二选一** —— **自动静帧（默认，即本节所述）** 或 **素材库选图（多选、按选择顺序）**。两者都在打包时复制进包目录 `images/NN.png`，因此 `DeliveryPackage` **不需要**新增"来源"字段，包依然自包含；事后删除素材也不影响已建好的包。

## 4. 上游接口契约（已从源码确认）

```
sau douyin check --account <name>                     # 登录态检测，打印 valid/invalid，退出码 0/1
sau douyin upload-note --account <name> \
    --images <img1> <img2> ...                        # 必填，最多 35 张
    --title <T>                                       # 必填，≤20 字符
    --note <N> | --notef <file>                       # ≤1000 字符
    --tags t1,t2  [--bgm 名称]  [--schedule <时间>]
```

来自 `DouYinNote.validate_upload_args()` 的硬限制：**title ≤20 字符**、images 非空且 ≤35 张、note ≤1000 字符。注意我们现有的 `PUBLISH_PLATFORMS.douyin.titleMax = 55` 是**视频**口径，不能直接用于图文。

发布流程：点「发布图文」→ `input[accept*='image']` 塞入多图 → 等 URL 变为 `content/post/image?**` → 填标题/正文/话题 →（可选 BGM/定时）→ 发布循环。

账号文件约定：`<sau BASE_DIR>/cookies/douyin_<account>.json`，Playwright `storage_state` 格式；sau 每次跑完会**回写**刷新后的 cookie。

## 5. 包模型

`DeliveryPackage` 新增：

```ts
contentType: "video" | "note";     // 缺省视为 "video"（兼容存量包）
imagePaths?: string[];             // 仅 note 包，包内相对路径，按场景序
noteCopy?: PlatformCopy;           // 仅 note 包，title ≤20 / note ≤1000 口径
```

- note 包的 `videoSha256` / `videoSize` / `videoMethod` 不适用；用**图片清单哈希**（各图 sha256 的有序拼接再哈希）作为等价完整性凭据。
- `PublishAssetHealth` 增 `missing_images`（图文缺图）。
- 打包时把静帧**复制进包目录**（`images/01.png`…），保持"包自包含"这一现有约束（视频与封面当前也是 clone/copy 进包的）。
- **图文文案独立成 `noteCopy`，不复用视频那份**：视频标题上限 55、图文 20，共用字段会让现有标题一律不合格。默认值由现有标题**压缩生成**（超 20 字截断并在 UI 标注"已压缩，可编辑"）。

## 6. 执行器（后端）

新增 `src/lib/sau-runner.ts`，与既有外部二进制同模式：

```
1. 预检   sau douyin check --account <name>        → valid 才继续；invalid 提示重新扫码登录
2. 准备   把我们的 cookie 文件转成 <sauBaseDir>/cookies/douyin_<name>.json
3. 执行   sau douyin upload-note --account … --images <包内图…> --title … --note … --tags …
4. 回写   读回 storage_state，转回 Cookie 头写我们的 douyin-cookie.txt（爬取同样受益）
```

> **接口契约（2026-09-17 修订）**：`POST /api/publishing/tasks/:id/auto-publish` **必须携带 `previewRevision`**（由包级预览接口返回，见 §14）。缺失 → 400；与当前内容不一致 → 409 且**不产生任何 `autoPublish` 记录**。这让"发布前必经预览"成为服务端约束，同时拦住"预览之后文案/图片被改动"的情况。

配置沿用现有模式（`app.ts` 的 `ytDlpBinary` / `whisperCliPath` / `hyperframesNpxBinary` 同理）：

- `sauBinary`：`sau` 可执行文件路径
- `sauBaseDir`：其仓库根目录（`verify_code.txt` 与 `cookies/` 都相对它）
- 二者由 env 注入（`SAU_BINARY` / `SAU_BASE_DIR`），Electron 与独立后端两条入口都要透传。

**我们不自带依赖**；未配置或预检失败时，界面给出安装指引，并明确写出 §1.2 的三个坑。

## 7. 验证码通路（必须有）

sau 在发布循环里检测到短信验证弹窗时会读 `<sauBaseDir>/verify_code.txt`；不处理的话任务会静默卡在它的 `while True` 里。

- `autoPublish.status = "awaiting_code"` 时，发布中心显示验证码输入框（交互沿用现有 PIN 弹窗模式）。
- 用户提交后写入 `<sauBaseDir>/verify_code.txt`（sau 验证通过后会自行删除）。
- 超时未提交则该次尝试失败，落在 `failed`（不自动重试）。

> **2026-09-17 更正（从上游源码实测，非推断）**：上面这段对**图文通路不成立**。
> `_read_verify_code()` / `verify_code.txt` 与「检测到短信验证码弹窗」的等待循环，全部位于
> `uploader/douyin_uploader/main.py` 的 **`DouYinVideo.upload`（628–1125 行）**；我们实际使用的
> **`DouYinNote`（1126 行起）既不读 `verify_code.txt`，也没有任何短信处理**。核对方式：
> 对 `main.py` 逐行做「归属类」分析，`verify_code` 的 4 处引用全部落在 `DouYinVideo` 内。
>
> 同时 `DouYinNote.upload_note_content()` 里有**两个没有次数上限的 `while True`**
> （等 `content/post/image` 页面、点发布等 `content/manage` 跳转），因此图文发布的**真实失败语义**是：
>
> - 上传/发布迟迟不成功（含出现短信挑战、上游 DOM 变更）→ **一直循环，直到我们的 `timeoutMs`
>   （`sau-runner` 默认 900s）杀掉进程** → `autoPublish.status = "failed"`；
> - 这种情况下 `needsVerificationCode` 的关键字**永远不会出现**，所以 `awaiting_code` 在图文通路上
>   **当前不可达**；写 `verify_code.txt` 对图文发布**没有任何效果**；
> - Cookie 失效是另一条干净路径：`upload_note()` 会先跑 `douyin_setup(handle=False)`，失败即
>   `RuntimeError` 非零退出（提示重新 `sau douyin login`），我们记为 `failed`。
>
> 因此：`awaiting_code` 与验证码接口按本节**保留为契约**（等上游补齐 note 侧支持、或将来改用视频
> 通路时即可生效），但界面与提示必须让操作者知道**「图文发布卡住」的正确动作是去抖音后台核实**，
> 而不是等一个验证码输入框；且超时与 §9 的重复点击风险叠加 —— **重试前必须先确认上一次是否已发出**。

## 8. 状态表达：`autoPublish` 子记录

**不新增 `PublishTaskStatus`**（现有 `scheduled|ready|published|failed|cancelled` 与其 filter 语义、`PublishingListStatus` 里的 `"broken"` 全部保持不动）。改为在 `PublishTask` 上挂：

```ts
autoPublish?: {
  status: "running" | "awaiting_code" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  message?: string;         // sau 输出摘要
  attemptId: string;
};
```

- `succeeded` 的语义是**已提交**，不是已发布 —— 最终结论由人点现有「标记已发布」给出。
- 人工确认复用现有的 `mark-published` 动作与审计，不新增确认流程。
- **`task.status` 全程不变**：`autoPublish` 的任何取值都只写子记录，任务状态仍停在 `ready`，
  直到人工点「标记已发布」。这是本设计最关键的一条不变式（有用例守住）。
- **遗留的 `running`/`awaiting_code` 超过 30 分钟视为「进程已死」**，允许重新发起。
  我们的发布请求是同步的：进程被杀或应用崩溃会留下一条永远 `running` 的记录，而界面里
  没有任何入口能清掉它 —— 没有这个阈值，任务会被永久锁死。阈值必须大于单次上传超时（900s）。

## 9. 兜底：重复发布是本功能最大的坑

上游的成功判定是"URL 跳到作品管理页"，而 `wait_for_url` 超时仅 3 秒，超时会落进 `except` 再 `force=True` 点一次「发布」——即**上游自身就可能重复点击**。我们的对策：

1. 同一任务**同时只允许一个** `autoPublish` 在跑（运行中重复触发返回 409，与现有步骤并发语义一致）。
2. **提交前必须有未过期的预览**：`previewRevision` 不匹配即 409（见 §14.3）。这条同时防住"预览后内容被改"。
2. 失败**绝不自动重试**，必须人工再次点击（人知道上一次到底发出去没有）。
3. 我方**不把 CLI 退出码当作"已发布"**，只标 `succeeded`（已提交），发布状态仍由人工判定。
4. 把 sau 的原始输出摘要写入审计与 `autoPublish.message`，便于事后追。

## 10. 明确不做

- 抖音视频自动发布（本次只图文）
- 多平台（小红书/快手/B站等）
- 排期到点全自动发布
- 图片编辑、裁剪、重新排版（直接用静帧）
- 内置 Python/chromium 依赖

## 11. 测试与验证

| 类别 | 内容 |
| --- | --- |
| 打包 | note 包按场景序复制静帧、生成图片清单哈希、`contentType` 缺省视为 video（存量包兼容） |
| 文案 | `noteCopy` 校验：title >20 报错、note >1000 报错、标题压缩规则 |
| 执行器 | **全部用假 CLI 脚本**（临时目录里放一个打印预期输出、退出码可控的 stub）验证：预检失败不改状态、成功标记 `succeeded`、验证码分支进 `awaiting_code`、cookie 双向转换。**测试绝不联网、绝不触碰真实抖音** |
| 路由 | 运行中重复触发 409；未配置 `sauBinary` 时返回明确错误 |
| 状态机回归 | `PublishTaskStatus` 与 `PublishingListStatus` 语义不变，既有 publishing 相关用例全部保持通过 |

**验证命令**：`npm run check`、`npm test`、`npm run build:backend`。基线见 `docs/worklog.md`。
**生效条件**：后端改动需 `npm run build:backend` 并重启；Electron 需整个重启。

## 12. 风险

| 风险 | 说明与处理 |
| --- | --- |
| **重复发布** | 见 §9 四条对策；人工确认是最后一道闸 |
| **平台风控与账号风险** | 上游靠 patchright + `stealth.min.js`(180KB) 对抗检测，作者自述"降低平台检测风险"是持续目标 —— 即检测是真实存在的。风险由你的账号承担，本设计不消除它 |
| 上游 DOM 变更导致失效 | 已见其同时兼容两套发布页（version_1/version_2）；失效时表现是 CLI 失败 → 我们标 `failed`，不误报成功 |
| 上游依赖缺声明 | §1.2 第 1 条；引导文案必须包含补装 `playwright` |
| 图文文案与视频文案混淆 | 独立 `noteCopy` 字段 + 独立校验口径 |
| 存量包兼容 | `contentType` 缺省视为 `video`，并用回归用例守住 |

## 13. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | `DeliveryPackage` 加 `contentType`/`imagePaths`/`noteCopy`；`PublishTask` 加 `autoPublish`；`PublishAssetHealth` 加 `missing_images` |
| `src/lib/publishing-platforms.ts` | 新增图文口径 `PUBLISH_NOTE_POLICIES`（douyin: title 20 / note 1000 / hashtags 10） |
| `src/lib/publishing-assets.ts` | 打包图文：复制静帧、图片清单哈希、`missing_images` 健康判定 |
| `src/lib/sau-runner.ts`（新增） | 预检 / 凭据转换 / 执行 / 回写 |
| `src/lib/publishing-routes.ts` | `POST /api/publishing/tasks/:id/auto-publish`（**必须带 `previewRevision`**）、验证码提交接口、`GET /api/publishing/packages/:id/preview`、`GET /api/publishing/packages/:id/images/:index` |
| `src/lib/publishing-store.ts` | `autoPublish` 读写、并发互斥、包级 `previewRevision` 的计算与比对 |
| `renderer/src/pages/PublishingPage.tsx` | 「发布图文到抖音」动作（先预览、确认后才提交）、「预览」入口、验证码输入、待确认提示 |
| `renderer/src/components/PublishPreviewDialog.tsx`（新增） | 通用预览弹窗：视频播放器 / 图片横滑 + 文案字数校验 |
| `renderer/src/utils/publishing.ts` | 动作可见性规则 |
| `src/app.ts`、`src/server.ts`、`electron/server.ts` | `sauBinary` / `sauBaseDir` 透传 |
| 测试 | 新增 sau runner/打包/文案/路由用例；既有 publishing 用例作为回归门禁 |

## 14. 发布前预览（2026-09-17 追加）

### 14.1 为什么需要

自动发布是**不可逆**动作，而在此之前项目里**没有任何地方能"看见"将要发出去的内容**：

- 现有的 `PublishingPreview`（`POST /api/jobs/:id/publishing/preview`）返回的是**视频元数据**（文件名/尺寸/时长/是否有封面）+ 各平台文案 + warning，供**创建发布包向导**使用，其"确认"步骤只是纯文字摘要。
- 图文尤其危险：**图片顺序**与文案是两件事，发错了顺序或带错文案，事后只能删稿重发。

### 14.2 形态与入口

一个弹窗组件，两种进入方式：

| 入口 | 行为 |
| --- | --- |
| 任务行「发布图文到抖音」 | 先弹预览 → 点「确认发布」才真正提交（**必经**） |
| 包/任务行「预览」按钮 | 随时查看（视频包走这个） |

视频包不设"必经"，是因为它本来就没有自动提交动作——最终仍由人自己去平台发布。

内容按 `contentType` 分两支：

| | 视频包 | 图文包 |
| --- | --- | --- |
| 主区 | 成片 `<video controls>`（走既有 `/video/stream` 的 Range 流）+ 封面 | **图片横滑**，按 `imagePaths` 顺序，带 `1/11` 序号指示 |
| 文案区 | 各平台 标题 / 正文 / 话题 | 当前任务平台的 标题 / 正文 / 话题 |
| 公共 | 版本、包路径、创建人/时间、`assetHealth`（缺资产必须显眼） | 同左 |

文案区**必须带字数与上限**（如「标题 12/20」「正文 340/1000」），超限标红——直接复用 Task 1 的 `validateNoteCopy`，让预览成为"发布前最后一道校验"。

### 14.3 「必经确认」必须是服务端约束

只在界面上"不给点"是不可靠的：接口仍可被直接调用绕过。因此：

```
GET  /api/publishing/packages/:id/preview      → 返回包级预览数据 + previewRevision
POST /api/publishing/tasks/:id/auto-publish    → 必须带 previewRevision
                                                  缺失 → 400
                                                  与当前内容不一致 → 409「预览已过期，请重新预览」
                                                  且不产生任何 autoPublish 记录
```

`previewRevision` 沿用既有语义（现有 `PublishingPreview.previewRevision` 就是为向导的乐观并发设计的），不新造一套：它是**包内容指纹**，图文包需覆盖 `imagePaths`（含顺序）与 `noteCopy`，视频包覆盖视频哈希与各平台文案。

两个收益：确认是真必经；且**预览之后内容被改动会被拦下**，避免"看到的"与"发出去的"不一致。

### 14.4 图片读取接口

照既有 `GET /api/publishing/packages/:id/cover` 的模式新增：

```
GET /api/publishing/packages/:id/images/:index     # index 为 imagePaths 中的序号（0 基）
```

越界或包内缺图 → 404；仍走既有的路径归属校验（不得越出包目录）。

### 14.5 明确不做

- **抖音信息流效果模拟**（手机框、标题在上、横滑轮播的平台样式复刻）——已与用户确认排除：多维护一套"模仿平台"的样式，平台改版就会失真。
- 视频包的自动发布（仍是人工交付）。
- 在预览弹窗里直接编辑文案——编辑仍走既有任务行，避免出现第二套编辑状态。

### 14.6 测试

- 包级预览接口：视频包返回视频元数据、图文包返回**有序** `imagePaths` 与 `noteCopy`，两者都带 `previewRevision`。
- 图片接口：序号与 `imagePaths` 一一对应；越界 → 404。
- **`previewRevision` 契约**：不带 → 400；带过期值 → 409 且**不产生 `autoPublish` 记录**；带正确值 → 通过。改动文案后旧 revision 失效（回归断言）。
- 组件：视频包渲染播放器；图文包渲染 N 张图与序号指示；超限文案标红。
