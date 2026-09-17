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

## 9. 兜底：重复发布是本功能最大的坑

上游的成功判定是"URL 跳到作品管理页"，而 `wait_for_url` 超时仅 3 秒，超时会落进 `except` 再 `force=True` 点一次「发布」——即**上游自身就可能重复点击**。我们的对策：

1. 同一任务**同时只允许一个** `autoPublish` 在跑（运行中重复触发返回 409，与现有步骤并发语义一致）。
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
| `src/lib/publishing-routes.ts` | `POST /api/publishing/tasks/:id/auto-publish`、验证码提交接口 |
| `src/lib/publishing-store.ts` | `autoPublish` 读写、并发互斥 |
| `renderer/src/pages/PublishingPage.tsx` | 「发布图文到抖音」动作、验证码输入、待确认提示 |
| `renderer/src/utils/publishing.ts` | 动作可见性规则 |
| `src/app.ts`、`src/server.ts`、`electron/server.ts` | `sauBinary` / `sauBaseDir` 透传 |
| 测试 | 新增 sau runner/打包/文案/路由用例；既有 publishing 用例作为回归门禁 |
