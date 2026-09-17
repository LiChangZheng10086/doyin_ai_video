# 素材库 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增「素材」页面，让用户手动上传与管理图片、音频；图片可选入图文发布。

**Architecture:** 后端新增 `assets-store.ts`（索引 + 落盘 + 白名单/限额校验）与 `assets-routes.ts`（multipart 上传、列表、带 Range 的预览、删除），用 `multer` 处理 multipart；预览复用既有 `sendResolvedVideo` 的 Range 实现。前端新增 `AssetsPage` 与主导航项。图文打包的图片来源参数化，支持「自动静帧」与「素材库选图」两种。

**Tech Stack:** Node.js + Express 4 + TypeScript、`multer`（新增依赖）、React 19 + Tailwind CSS、Node 内置 test runner（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-17-asset-library-design.md`

## Global Constraints

- **落盘文件名一律服务端生成**（`randomUUID` + 白名单扩展名）；用户提供的文件名只作为 `originalName` 存索引、仅用于展示，**绝不用作路径**。
- 扩展名白名单：图片 `jpg/jpeg/png/webp`，音频 `mp3/wav/m4a/aac`；白名单外返回 415，超限返回 413，单次 >20 个文件被拒。
- 读取与删除都必须校验 `id` 存在于索引，且解析路径落在 `assets/` 内（防路径穿越）。
- `GET /api/assets/:id/raw` **必须支持 Range**（音频进度条依赖），复用既有 Range 实现而非新写。
- 索引读写沿用既有模式：读取容错（缺失/损坏不崩），写入走既有原子写路径。
- 音频本轮**不接入任何流程**（不混音、不进 `--bgm`）；UI 必须有固定提示。
- 打包时图片**复制进包目录**，`DeliveryPackage` 不新增"来源"字段。
- 不改动既有视频交付包行为（`contentType` 缺省 `"video"` 时逐字节不变）。
- 上传测试使用临时目录与真实小文件，**不触碰用户已有素材**。

### Task 1: `assets-store.ts`（测试先行）

**Files:**
- Create: `src/lib/assets-store.ts`
- Test: `src/lib/assets-store.test.ts`

**Interfaces:**
- Consumes: `LocalStorage`（既有）、`randomUUID`
- Produces: `AssetRecord`、`AssetStore.add(kind, { originalName, bytes })`、`list(kind?)`、`get(id)`、`remove(id)`、`resolveFile(id)`

- [ ] **Step 1: 写失败用例**

- `add` 正常写入：索引出现记录，`filename` 为 uuid + 白名单扩展名，`originalName` 保留原名。
- **路径穿越必须被拒**：`originalName` 为 `../../evil.png`、`..\\evil.png`、`/etc/passwd` 时，落盘名仍是 uuid（断言磁盘路径在 `assets/` 内），且不产生越界文件。
- 白名单外扩展名（`.exe`、`.svg`、无扩展名）→ 抛错（映射为 415）。
- 图片 >20MB、音频 >50MB → 抛错（映射为 413）。
- `remove` 后索引与磁盘文件都不存在；对不存在的 id 返回 false 且不抛。
- 索引文件缺失或内容损坏时 `list()` 返回空数组而不抛。
- `resolveFile` 对不存在/越界的 id 返回 null。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/assets-store.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

落盘用流式写入（避免把 50MB 音频整块读进内存）；`assets/` 目录懒创建；索引写入走 `writeJsonAtomic`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/assets-store.test.ts`
Expected: PASS。

### Task 2: 素材路由 + Range 预览（测试先行）

**Files:**
- Create: `src/lib/assets-routes.ts`
- Modify: `src/app.ts`、`package.json`（新增 `multer`）
- Test: `src/app.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AssetStore`；既有 `sendResolvedVideo` 的 Range 实现
- Produces: `POST /api/assets/images`、`POST /api/assets/audio`、`GET /api/assets`、`GET /api/assets/:id/raw`、`DELETE /api/assets/:id`

- [ ] **Step 1: 写失败用例**

沿用 `src/app.test.ts` 既有 `appFixture()` / `serveApp()` 脚手架：

- 上传一张小 PNG（真实字节构造的 multipart 请求）→ 201，返回记录含 `width/height`（图片能读到尺寸时）。
- 上传 `.exe` → 415；上传超限文件 → 413（测试用 `limits` 覆盖或小上限注入，避免造 20MB 文件）。
- `GET /api/assets` 按 `kind` 过滤正确。
- `GET /api/assets/:id/raw`：整文件 200 + `Content-Length`；带 `Range: bytes=2-5` → **206 + `Content-Range`**；`HEAD` → 200 无 body。
- `DELETE /api/assets/:id` → 204，之后 `raw` 返回 404，且磁盘文件消失。
- 未认证/不存在的 id → 404（不泄漏路径信息）。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/app.test.ts`
Expected: FAIL —— 路由不存在。

- [ ] **Step 3: 实现**

`multer` 用 `memoryStorage` + 显式 `limits.fileSize` 与 `files`，再交给 `AssetStore` 落盘（这样白名单/限额校验集中在 store 一层）；错误映射为 413/415；`raw` 复用既有 Range 发送逻辑。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/app.test.ts`
Expected: PASS，且既有 28+ 用例保持通过。

### Task 3: 图文打包支持两种图片来源（测试先行）

**Files:**
- Modify: `src/lib/publishing-assets.ts`
- Test: `src/lib/publishing-assets.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AssetStore`、既有静帧收集逻辑
- Produces: 图文打包的 `imageSource: "frames" | "library"` 分支

- [ ] **Step 1: 写失败用例**

- `imageSource: "frames"`（默认）→ 按场景序收集静帧，行为与既有实现一致（回归断言）。
- `imageSource: "library"` + 给定 assetId 列表 → 包内 `images/NN.png` **顺序与选择顺序一致**（刻意传入与 id 排序不同的顺序来验证）。
- 选图超过 35 张 → 报错（抖音图文上限）。
- 选图数量为 0 → 报错。
- **素材被删除后**：已建好的包内图片仍存在（断言包目录里的文件），重建包时才失败。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-assets.test.ts`
Expected: FAIL —— 尚无来源分支。

- [ ] **Step 3: 实现**

把图片收集抽成按来源分派的函数，其余打包/哈希/健康判定逻辑保持不变。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/publishing-assets.test.ts`
Expected: PASS，既有视频打包用例保持通过。

### Task 4: 素材页与导航（测试先行）

**Files:**
- Create: `renderer/src/pages/AssetsPage.tsx`
- Modify: `renderer/src/components/shell/navigation.ts`、`renderer/src/App.tsx`、`renderer/src/services/api.ts`
- Test: `renderer/src/components/shell/navigation.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的接口
- Produces: `/assets` 路由与主导航项；`getPageContext('/assets')` 标题；`apiClient` 的素材方法

- [ ] **Step 1: 写失败用例**

- 主导航包含「素材」且 `to === '/assets'`。
- `isNavigationItemActive('/assets', 素材项)` 为 true；`/assets/xxx` 之类子路径按需（本页无子路由，保持精确匹配即可）。
- `getPageContext('/assets')` 返回非空 title/subtitle。
- **移动端导航项数量断言**：`MOBILE_NAV_ITEMS` 长度（确认从 4 变 5 是有意的，防止以后无意改动）。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test renderer/src/components/shell/navigation.test.ts`
Expected: FAIL —— 导航项不存在。

- [ ] **Step 3: 实现页面与导航**

素材页：图片/音频两个分区、网格列表、缩略图（走 `/raw`）、音频用 `<audio controls>` 试听、删除走既有 `ConfirmDialog`、空状态给上传 CTA、音频分区固定提示「音频暂未接入成片，本轮仅支持上传与试听」、逐文件失败的提示。`api.ts` 用 `FormData` 上传（不要手写 `Content-Type`，让浏览器带 boundary）。

- [ ] **Step 4: 运行确认通过 + 类型检查**

Run: `node --import tsx --test renderer/src/components/shell/navigation.test.ts && npm run check`
Expected: 用例通过、`tsc` 双端退出码 0。

### Task 5: 全量验证、编译与人工复核

- [ ] **Step 1: 全量测试与类型检查**

Run: `npm run check && npm test`
Expected: 仅剩既有失败 `src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge`（以实际基线为准，见 `docs/worklog.md`）。

- [ ] **Step 2: 编译并重启**

Run: `npm run build:backend`，随后重启独立后端与 Electron（`multer` 是新依赖，需确认 `npm install` 已执行）。

- [ ] **Step 3: 人工复核**

1. 导航出现「素材」，页面可打开。
2. 上传一张 PNG 与一个 MP3 → 列表出现、图片有缩略图、音频能试听且进度条可拖动（验证 Range）。
3. 上传一个 `.exe` 与一个超大文件 → 分别看到 415/413 的明确提示。
4. 删除一项 → 二次确认后消失，刷新页面仍是删除后状态。
5. 创建图文包时能切换图片来源，选素材库时按选择顺序记住。

- [ ] **Step 4: 只暂存本特性文件并提交**

```bash
git add package.json package-lock.json \
        src/lib/assets-store.ts src/lib/assets-store.test.ts \
        src/lib/assets-routes.ts src/app.ts src/app.test.ts \
        src/lib/publishing-assets.ts src/lib/publishing-assets.test.ts \
        renderer/src/pages/AssetsPage.tsx renderer/src/App.tsx \
        renderer/src/components/shell/navigation.ts renderer/src/components/shell/navigation.test.ts \
        renderer/src/services/api.ts
git commit -m "feat: 素材库页面（上传/管理图片与音频，图片可选入图文）"
```
