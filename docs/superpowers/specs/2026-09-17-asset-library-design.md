# 抖创工坊 素材库 设计规格

**状态：** APPROVED
**批准日期：** 2026-09-17
**日期：** 2026-09-17
**产品：** 抖创工坊
**范围：** 新增「素材」页面，支持手动上传与管理图片、音频；图片可接入图文发布
**实施边界：** 只做上传/管理/预览与图片接入图文；音频不混音、素材不接入视频渲染

## 1. 背景与结论

用户希望有一个素材页面，手动上传图片与音频。当前项目：

- **后端没有任何接收上传的能力**：全仓库无 `multer` / `busboy` / `formidable`，也无 multipart 处理。
- HyperFrames 项目里的 `assets/` **不是用户素材**，只放内置的 `gsap.min.js`；上传的素材不会被渲染管线使用。
- 音频有硬约束：`sau` 的 `--bgm` 收的是**歌曲名**（去抖音搜索选用），**不是音频文件**。因此上传的音频无法喂给上游 CLI；要真起作用只能是混进我们自己的成片（当前成片是"无声动效版"）。本轮决定**只存与试听**。

因此本轮交付：素材页（上传 / 列表 / 预览 / 试听 / 删除）+ 图片接入图文发布。音频明确不接入任何流程，并在界面上写清楚，避免误以为已生效。

## 2. 已确认设计决策

| 决策 | 结果 |
| --- | --- |
| 页面位置 | 主导航新增「素材」（与 作品/合集/Skills/发布 同级，属内容资产而非配置） |
| 上传机制 | 后端新增 `multer` 依赖处理 multipart |
| 存储 | `<storage>/assets/{images,audio}/` + `<storage>/cache/assets-index.json` |
| 文件命名 | `randomUUID` + 白名单扩展名；原始文件名存索引元数据 |
| 图片接入图文 | 创建图文包时二选一：自动静帧（默认） / 素材库选图 |
| 音频用途 | **只上传、列表、试听、删除**；不混音、不进 `--bgm` |
| 素材删除的影响 | 不影响已建好的交付包（打包时图片已复制进包） |

## 3. 存储与索引

```
<storage>/assets/images/<uuid>.<ext>
<storage>/assets/audio/<uuid>.<ext>
<storage>/cache/assets-index.json
```

索引与 `collections-index.json` / `jobs-index.json` 同模式（读取时容错、写入走既有原子写路径）：

```ts
interface AssetRecord {
  id: string;
  kind: "image" | "audio";
  filename: string;        // 磁盘上的文件名（uuid + 白名单扩展名）
  originalName: string;    // 用户上传时的原始名，仅用于展示
  bytes: number;
  width?: number;          // 仅图片
  height?: number;         // 仅图片
  durationMs?: number;     // 仅音频，能读到时才写
  createdAt: string;
}
```

## 4. 上传机制

**新增依赖 `multer`**：Express 4 生态标准、体积小；不自写 busboy 解析，也不走 base64（几 MB 音频经 base64 会膨胀约 33%，还要放宽 body 上限）。

```
POST   /api/assets/images        多文件上传 → 返回创建的 AssetRecord[]
POST   /api/assets/audio         同上
GET    /api/assets               列表（可按 kind 过滤）
GET    /api/assets/:id/raw       原文件（图片用于缩略图/预览，音频用于试听）
DELETE /api/assets/:id           删除记录与磁盘文件
```

`GET /api/assets/:id/raw` **必须支持 Range**（音频拖动进度条依赖它）—— 复用 `sendResolvedVideo` 那套 Range/206/HEAD/416 实现，不新写流式逻辑。

**安全要求（必须有测试）**：

- 文件名一律服务端生成（`randomUUID` + 扩展名），**绝不采用用户提供的文件名作为落盘名**；`originalName` 只存进索引且仅用于展示。
- 扩展名白名单：图片 `jpg/jpeg/png/webp`，音频 `mp3/wav/m4a/aac`；白名单外一律 415。
- 单文件大小上限：图片 20MB、音频 50MB；超出 413。
- 单次上传文件数上限 20。
- 删除与读取都必须校验 `id` 在索引内，且解析后的路径落在 `assets/` 目录内（防路径穿越）。

## 5. 图片接入图文（对既有图文 spec 的修正）

`docs/superpowers/specs/2026-09-17-douyin-note-auto-publish-design.md` 第 3 节原写「图文素材 = 自动静帧，零新增渲染」。现修正为**两种来源二选一**：

| 来源 | 说明 |
| --- | --- |
| 自动静帧（默认） | `output/videos/{jobId}/hyperframes/snapshots/frame-*.png`，按场景序，11 张 1080×1920 |
| 素材库选图 | 用户在素材页上传的图片，多选并**按选择顺序**使用 |

两种来源都在打包时**复制进包目录** `images/NN.png`。因此：

- **不需要给 `DeliveryPackage` 增加"来源"字段** —— 来源只在打包那一刻用一次，包保持自包含。
- 事后删除素材**不影响**已建好的图文包（图片已在包内）。
- 抖音图文上限 35 张；两种来源都要在打包前校验张数与顺序。

## 6. 界面

- 素材页分两个分区：**图片** / **音频**；各自网格列表（图片显缩略图与尺寸，音频显文件名与时长 + 播放按钮）。
- 每项：预览、复制文件名、删除（删除需二次确认，沿用现有 `ConfirmDialog`）。
- 空状态给出 CTA 引导上传（对齐既有空状态风格）。
- 音频分区顶部固定提示：**「音频暂未接入成片，本轮仅支持上传与试听」**。
- 上传中显示进度与失败原因（逐文件，而不是整批失败）。

## 7. 限制（先给默认值，后续可调）

| 项 | 值 |
| --- | --- |
| 图片格式 / 上限 | `jpg/jpeg/png/webp` / 单张 20MB |
| 音频格式 / 上限 | `mp3/wav/m4a/aac` / 单个 50MB |
| 单次文件数 | ≤ 20 |
| 图片尺寸 | 不强制；非 9:16 时在 UI 提示"建议 9:16"但不拦截 |

## 8. 明确不做

- 音频混音 / BGM / 配音（`--bgm` 收歌曲名，非文件，本轮不接）
- 素材接入视频渲染（HyperFrames 只用内置 `gsap.min.js`）
- 图片裁剪、压缩、重新编码（保持原始字节，利于哈希稳定）
- 素材分类、打标、搜索、跨设备同步
- 素材的回收站（删除即删，但需二次确认）

## 9. 测试与验证

| 类别 | 内容 |
| --- | --- |
| 上传 | 正常图片/音频落盘 + 索引写入；**路径穿越文件名（`../../evil.png`）必须被拒**；白名单外扩展名 415；超限 413；单次超 20 个被拒 |
| 索引 | 列表按 kind 过滤；删除后索引与磁盘文件**都**消失；索引缺失/损坏时容错不崩 |
| 预览 | `GET /:id/raw` 的 Range：206 + `Content-Range`，HEAD 正常（音频拖进度条依赖） |
| 图文打包 | 两种来源各一例；选素材库时**顺序与选择一致**；超过 35 张被拒；素材被删后既有包不受影响 |
| 前端 | 导航出现「素材」且 active 判定正确；`getPageContext('/assets')` 有标题 |

**验证命令**：`npm run check`、`npm test`、`npm run build:backend`。基线见 `docs/worklog.md`（仅剩 1 个既有失败）。
**上传测试使用临时目录与真实小文件，不碰用户已有素材。**

## 10. 风险

| 风险 | 处理 |
| --- | --- |
| 上传是新的攻击面（路径穿越、超大文件、恶意内容） | 服务端生成文件名 + 白名单扩展名 + 大小/数量上限 + 路径归属校验，全部有测试 |
| 新增 `multer` 依赖 | 体积小、生态标准；仅用于本地 HTTP 服务（不对外暴露） |
| 素材被误删导致图文包缺图 | 打包时复制进包，删除素材不影响既有包；重建包时才受影响 |
| 音频"上传了但没生效"的误解 | UI 固定提示 + 本轮明确不做混音 |
| 与图文 spec 冲突 | 已在本文件第 5 节修正该 spec 的素材来源表述，并同步提交 |

## 11. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/lib/assets-store.ts`（新增） | 索引读写、落盘、删除、白名单与限额校验 |
| `src/lib/assets-routes.ts`（新增） | 上传/列表/预览(Range)/删除 |
| `src/app.ts` | 挂载素材路由；素材目录随 `storagePath` |
| `package.json` | 新增 `multer` 依赖 |
| `src/lib/publishing-assets.ts` | 图文打包的图片来源参数化（静帧 / 素材库） |
| `renderer/src/pages/AssetsPage.tsx`（新增） | 素材页 |
| `renderer/src/components/shell/navigation.ts` | 主导航 + `getPageContext` 增「素材」 |
| `renderer/src/App.tsx` | 新增 `/assets` 路由 |
| `renderer/src/services/api.ts` | 素材相关接口（含 multipart 上传） |
| 测试 | `assets-store` / `assets-routes` / 打包两来源 / 导航 用例 |
