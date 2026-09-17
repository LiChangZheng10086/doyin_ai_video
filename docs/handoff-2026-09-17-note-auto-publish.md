# 交接：抖音图文自动发布（2026-09-17）

> **状态更新（后续会话追加）**：**Task 1–6 + 计划外 Task 5.5 全部完成；Task 7 的 Step 1–3 也已完成。**
> **只剩 Task 7 Step 4–6**：Step 4（配置后只跑预检）与 Step 5（真实发布）需要真实 `sau` 引擎 ——
> **本机没有，约 970MB 需重装**；Step 5 按设计本来就留给人工决定；Step 6 是提交。
> 详见 `docs/worklog.md` 顶部与计划里的执行记录。
>
> **本次真机验证的结论与遗留**：
> 1. `npm run build:backend` 已跑，**独立后端已用新代码重启**（托管后台作业 `bash-23`，`node dist/server.js`，
>    `http://localhost:3100`）。⚠️ 它是本会话的托管作业，**会话结束后可能被回收**；要长期运行请自行
>    `cd <repo> && node dist/server.js` 起一个。
> 2. **Electron 已重启**（用户要求，托管后台作业 `bash-24`，内嵌后端 `http://localhost:58056`，已加载新
>    `dist/app.js`、新路由均 401 挂上）。⚠️ **但从 DSH 沙箱内启动的 Electron 读不到 macOS keychain**，
>    而 API Key 是 `safeStorage` 加密存的 → 解密失败会**静默退化**成空串/密文，表现为「AI 未配置」或
>    AI 调用 401。**要正常用 AI，请从自己的终端（沙箱外）重启**：
>    `cd <repo> && NODE_ENV=development node_modules/.bin/electron . --no-sandbox`。
>    这两个后台作业（后端 3100、Electron）**会话结束后可能被回收**，长期运行请自行起。
> 3. 仓库 `storage/` 里留了一个**联调图文包**（`packageId=devnotev1`、`taskId=devnotetask1`、
>    `sourceJobId=dev-note-demo`，3 张 1×1 假静帧），用于复现 Step 3。它只在 gitignored 的 `storage/` 里，
>    删除方式：删掉 `storage/output/publishing/dev-note-demo/`，并把 `storage/cache/publishing-index.json`
>    的 `packages.devnotev1`、`tasks.devnotetask1` 去掉。
> 4. Step 3 是用 **headless Chrome + CDP** 真点出来的（截图 `/tmp/step3-preview-dialog.png`、
>    `/tmp/step3-install-guidance.png`）；启动方式见 `docs/handoff-2026-09-15-ui-audit.md` 第 9/10 节 +
>    本会话：`withPage` / `savePng` 从 `/Users/mac/.dsh/profiles/web/node_modules/dsh-cdp-browser/dsh/cdp.js` import。
>
> **三个必须知道的坑**：① spec §7 已更正 —— `verify_code.txt` 只有上游**视频**通路会读，`upload-note`
> 既不读它、发布循环也没有次数上限，图文发布遇到短信挑战的真实结局是「超时 → failed」，`awaiting_code`
> 当前不可达；② 任何「重试前」都必须先到抖音后台确认上一次是否已发出（重复发布是最大风险）；
> ③ 图文包**只支持抖音**，且发布中心**还没有图文包的创建向导**（只有 API 能造包）。


## 0. 先做这三件事

1. **读计划**：`docs/superpowers/plans/2026-09-17-douyin-note-auto-publish.md` —— 7 个 Task，**Task 1 已完成**（计划里那 4 个 Step 已勾选），从 **Task 2** 开始。
2. **读规格**：`docs/superpowers/specs/2026-09-17-douyin-note-auto-publish-design.md` —— 注意 **§14「发布前预览」是后加的**，它改了 `auto-publish` 的接口契约（必须带 `previewRevision`），所以计划里多了 Task 5。
3. **确认基线测试通过**：`npm test`。**基线是 409 项 / 407 通过 / 1 跳过 / 1 个既有失败**，那个失败是 `src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge`，**与本特性无关**（曾用 `git stash` 在原始源码上复现过同一失败）。任何"多出来的失败"都是你自己引入的。

## 1. Task 2 要做的事与硬约束

**一句话**：给 `DeliveryPackage` 增加**图文（note）打包**能力 —— 把已生成的场景静帧按顺序复制进包目录，产出 `imagePaths` 与**图片清单哈希**，并在没有图时给出 `missing_images` 健康值。

**素材来源（已实测）**：应用生成视频时已经在跑 `hyperframes snapshot --at <各场景中点>`（`src/lib/hyperframes-video.ts:166`），产物已在磁盘上：

```
output/videos/{jobId}/hyperframes/snapshots/frame-00-at-3s.png … frame-10-at-58.2s.png
   11 张、各 1080×1920、约 500KB、合计 5.4MB；文件名里的 frame-NN 即场景序
```

**硬约束**（写进计划的 Global Constraints，别绕过）：

- 图片**按场景序**进包（`images/NN.ext`）；**图片清单哈希 = 各图 sha256 有序拼接后再哈希**，所以**调换顺序必须改变哈希**（要有断言）。
- **存量视频包行为逐字节不变**：`contentType` 缺省视为 `"video"`，既有用例必须零改动继续通过。
- 没有图（缺 `snapshots/` 或一张都没有）→ `assetHealth === "missing_images"` 且打包报明确错误。
- 打包时**复制进包目录**，保持"包自包含"（视频与封面现在也是 clone/copy 进包的）。

## 2. 这次改动最大的风险，以及我建议的做法

`src/lib/publishing-assets.ts` 是 **1484 行、安全加固过**的文件。它的打包主流程 `createPackageAssets()` 有序地做了这些事：

```
withAssetLock（互斥）
  → ensureDirectDirectory + 目录身份校验（dev/ino）
  → 临时目录 .next-<pkgId>
  → copyVerified（带 inode 一致性校验的复制）+ hashFilePath
  → prepareCover
  → 写 platforms/ + manifest.json
  → safeRenameDirect 原子提升到正式目录（再验一次身份）
  → 返回 rollback() 闭包（内部有 publish_revision_conflict 检查）
  → 错误路径清理临时/已提升目录；finally 关源句柄
```

**两个都不要做**：

- ❌ 不要在 `createPackageAssets()` 里 if/else 塞图片逻辑 —— 会把图形流程塞进视频流程，两种资产的校验纠缠在一起。
- ❌ 不要复制一份骨架给图文用 —— **安全校验只允许有一个真源**。这条是这个项目里已经付出过代价的教训：`video-output.ts` 的 `resolveContainedMp4` 就是为了避免成片与原视频各写一份根目录校验（各写一份等于开放任意文件读取），同一个道理。

**建议的做法**：

1. **先写测试**：在 `src/lib/publishing-assets.test.ts` 里加图文用例。该文件已有现成的 `fixture()`（返回 `{ storageRoot, input }`）与注入依赖的写法（`now` / `copyFile` / `runCommand`），照抄即可。
2. **然后把"暂存目录事务"抽成共用私有 helper**（临时目录 → 内容 → 原子提升 → rollback 闭包），让视频入口与新的图文入口各自调用。
3. **既有 42KB 的 `publishing-assets.test.ts` 就是你这次重构的回归门禁** —— 抽完立刻全量跑它，必须全绿再继续。
4. 再实现 `createNotePackageAssets(...)`（建议独立入口，输入为 `sourceImagePaths[]` + `noteCopy` + `tasks` + `actor`）。

## 3. Task 1 已经做了什么（别重复做）

提交 `abe9d9e`：

- `src/lib/publishing-platforms.ts`：新增 `PUBLISH_NOTE_POLICIES`（抖音图文 **title ≤20 / note(=description) ≤1000 / hashtags ≤10**）与 `validateNoteCopy`。两者与视频校验**收敛到同一个实现** `validateCopyAgainstPolicy`，只换政策来源。**视频口径（`PUBLISH_PLATFORMS.douyin.titleMax = 55`）一个字都没改**。
- `src/types.ts`：`DeliveryPackage` 增 `contentType?`/`imagePaths?`/`noteCopy?`；`PublishTask` 增 `autoPublish?`；`PublishAssetHealth` 增 `"missing_images"`；新增 `PackageContentType`/`PublishAutoPublish*` 类型。
- `src/lib/publishing-platforms.test.ts`：新增 4 个用例（10/10 绿）。

## 4. 队列里剩下的（做完 Task 2 之后）

| Task | 内容 | 关键点 |
| --- | --- | --- |
| 3 | `sau-runner.ts` | **全程用假 CLI（临时目录里的 stub 脚本）**，不联网、不碰真实抖音 |
| 4 | 路由、并发互斥、验证码通路 | `auto-publish` **必须带 `previewRevision`**（缺失 400 / 不一致 409，且不写 `autoPublish`）；CLI 退出 0 只记 `succeeded`（已提交），**绝不写 `published`** |
| 5 | 发布前预览 | 产出 `previewRevision` 的包级预览接口 + 图片接口 + 弹窗组件（设计见 spec §14） |
| 6 | 发布中心 UI 与配置透传 | `sauBinary` / `sauBaseDir` 照 `hyperframesNpxBinary` 的写法透传 |
| 7 | 全量验证、编译、重启、人工复核 | 见计划 |

另外两件挂着的小事（都不属于 ②）：`③ 素材库`的 Task 3（图片接入图文）依赖 ② 的 Task 2 完成后再合并；根 `tsconfig.json` 缺 `"jsx": "react-jsx"`（25 个组件里有 7 个缺 `import React`，Node 下静态渲染会 ReferenceError）。

## 5. 环境事实（2026-09-17 实测）

- **后端 3100 与 Electron 都在跑**。Electron 的内嵌后端用随机端口，用 `lsof -nP -iTCP -sTCP:LISTEN | grep -i electron` 查；启动日志里也会打印 `Embedded Express server listening on http://localhost:<port>`。改 `src/` 后必须 `npm run build:backend` **并重启**才会生效（`check` / `test` 都不产出 `dist/`）。
- **Vite 5173 在跑**，渲染层改动走 HMR，不用重启。
- **headless Chrome 可以用 CDP 驱动**：`dsh-cdp-browser` 插件的工具**没挂上**（原因与修法见 `docs/handoff-2026-09-15-ui-audit.md` 第 9/10 节），但它的引擎可以直接从 Node import 用：
  ```js
  const { withPage, savePng } = await import(
    '/Users/mac/.dsh/profiles/web/node_modules/dsh-cdp-browser/dsh/cdp.js');
  ```
  本会话用它在真页面里量过侧栏宽度、截过图。启动 Chrome 记得带 `--headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=<新目录>`。
- `git push` 需要放宽沙箱（macOS keychain 被 DSH 沙箱挡住，凭据查询返回 `-67674`，表现为误导性的 "could not read Username"）。
- `npm install` 与 `uv` 都需要把缓存指到 `/tmp`（`npm_config_cache` / `UV_CACHE_DIR`），否则 `~/.npm`、`~/.cache/uv` 会被文件沙箱拒绝。

## 6. 进度与提交

- 本会话已完成：**② Task 1**（`abe9d9e`）+ **预览设计写进 spec/计划**（`67825ea`）。这两个提交**尚未推送**（`main` 领先 `origin/main` 2 个提交）。
- 工作区干净。
- 早些时候已推送的：P0 昵称/日期兜底、原视频播放、单一本机操作者、素材库（后端+页面）、侧栏可折叠、文档同步。
