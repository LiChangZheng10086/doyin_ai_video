# 发布中心「渠道」分栏实施计划（抖音图文 / 今日头条文章 / 视频人工交付）

- 日期：2026-09-18
- 规格：`docs/superpowers/specs/2026-09-18-publishing-channel-tabs-design.md`
- 约定：测试先行（先写用例看它红，再实现看它绿）；每步跑 `npm run check`；
  收尾跑全量 `npm test` + `build:backend` + `build:electron`，并在真浏览器里核对界面。

## 约束（动手前先读）

- **`contentType` 是渠道的唯一真源**，服务端只加这一个过滤字段；**不要**引入渠道级接口或渠道字段。
- **状态语义只有服务端一份**：前端只传 `status`，绝不在前端复刻「待处理/资产异常」的判定。
- **不改** `previewRevision` 约束、动作可用性规则、`autoPublish` 不变式。
- 界面文案用简体中文；空态必须给出**可照抄的入口路径**（项目惯例）。

## Task 1：服务端 `contentType` 列表过滤

1. `src/types.ts`：`PublishingListFilters` 增加 `contentType?: PackageContentType`。
2. `src/lib/publishing-store.ts`：`list()` 里按 `packageRecord.contentType ?? "video"` 过滤。
3. `src/lib/publishing-routes.ts`：`listFilters()` 解析 `req.query.contentType`，
   非法值 `invalid("发布内容类型筛选无效")`（复用已有 `contentType()` 校验的允许值集合）。
4. 用例（先红）：
   - `publishing-store.test.ts`：建 note/article/video 三种包，断言各自过滤只回自己；
     不传 `contentType` 时三种都回（**回归保护**）。
   - `app.test.ts`：`GET /api/publishing/packages?contentType=article` 只回文章包；
     `?contentType=bogus` → 400 且 `code: publish_validation_failed`。

## Task 2：渠道数据与纯函数（渲染层，全部可测）

`renderer/src/utils/publishing.ts` 新增：

- `PUBLISH_CHANNELS`（三个渠道：id/label/contentType/platforms/hint/emptyHint）；
- `publishChannelOf(detail): PublishChannel`（按包的内容类型定位渠道）；
- `selectChannelPackages(details, channelId)`；
- `countChannelPackages(details): Record<PublishChannelId, number>`（渠道页签计数）；
- `countStatusesInChannel(details, channelId): Record<PublishingListStatus, number>`
  （状态页签计数，含 `action`/`broken`/`trash`/`all` 的既有口径）；
- `channelPlatformOptions(channel)`（单平台渠道返回空数组 → 界面隐藏下拉）；
- `channelEmptyHint(channel)`。

用例（先红）：`renderer/src/utils/publishing.test.ts` 覆盖上面每个函数，
含「垃圾桶包只出现在垃圾桶计数」「视频包不被算进抖音图文」这类边界。

## Task 3：`PublishingPage` 接入渠道页签

1. 渠道状态进 `useSearchParams`（`?channel=`），缺省 `douyin-note`；非法值回落缺省。
2. 顶部渲染渠道页签（带计数）+ 该渠道的 `hint`。
3. `filters` 增加 `contentType: channel.contentType`；加载时**额外**取一次
   `{status:'all'}`（不带渠道）用于两份计数。
4. 单平台渠道隐藏平台下拉；空态用 `channelEmptyHint`。
5. 用例：`renderer/src/components/PublishingChannelTabs.test.tsx`（新组件，纯展示：
   渲染三个页签、计数、选中态回调、hint 文案）。

## Task 4：真浏览器验证

- 用隔离实例（开发后端 + 仓库 storage）造三种包（note/article/video）各一个，
  核对：切换渠道只显示对应包、计数正确、单平台渠道无下拉、空渠道显示入口文案、
  URL 带回 `?channel=` 可还原视图、控制台无异常。

## Task 5：文档与收尾

- `AGENTS.md` / `CLAUDE.md`（**逐字节一致**）：发布中心小节补「渠道分栏」一条
  （渠道=内容类型的界面投影、状态语义仍在服务端、计数取自 `status=all` 的那次请求）。
- `docs/worklog.md` 追加本轮记录；本文件补执行记录。
- 全量验证：`npm run check` 双端 0、`npm test`、`npm run build:backend`、`npm run build:electron`。

## 执行记录（2026-09-18）

- **Task 1（服务端）**：`PublishingListFilters` 加 `contentType`；`PublishingStore.list()` 按
  `contentType ?? "video"` 过滤；`listFilters()` 解析 `?contentType=`，非法值 400。
  用例先红后绿：store 的渠道过滤（含「不传时三种都回」的回归保护、垃圾桶在渠道内）、
  路由层 `?contentType=video|note` 与非法值 400。
- **Task 2（渲染层纯函数）**：`PUBLISH_CHANNELS` + `findPublishChannel` / `publishChannelOf` /
  `selectChannelPackages` / `countChannelPackages` / `countStatusesInChannel` /
  `channelPlatformOptions` / `channelEmptyHint`，7 条用例（41/41 通过）。
  顺带修掉「局部计数」：状态计数改由 `status=all` 那次请求算，不再只数当前视图。
- **Task 3（页面接入）**：新增 `PublishingChannelTabs`（3 条静态渲染用例），
  页面里渠道走 URL（`?channel=`）、`setView()` 让渠道与状态互不冲掉、
  单平台渠道隐藏平台下拉、空态按渠道给入口。
- **Task 4（真浏览器）**：造了三种包（note/article/video 各一个，见下）后跑 20 条断言，**全部通过**：
  三个页签与计数、缺省落在抖音图文、各渠道只显示自己的包、单平台无下拉/视频渠道有 4 平台下拉、
  说明文案随渠道变化、状态计数完整（待发布 1 来自 `status=all`）、
  切状态不丢渠道（URL 同时带 `channel=toutiao-article&status=ready`）、带 `?channel=video-manual`
  直接访问能还原视图、空态与「清空筛选」提示、请求确实带上 `contentType`、无 JS 异常。
- **Task 5（文档与收尾）**：`AGENTS.md` / `CLAUDE.md` 发布中心小节补「渠道分栏」；worklog 追加；
  全量 `npm run check`（双端 0）、`npm test`、`build:backend` + `build:electron`。

### 本轮用到的联调数据（仓库 `storage/`，只在开发后端可见）

| 渠道 | 包 | 说明 |
| --- | --- | --- |
| 抖音图文 | `devnotev1` | 早先那条图文联调包 |
| 今日头条文章 | `ttarticlev1` | 头条文章联调包（含 `article.html` + `cover.jpg`） |
| 视频人工交付 | `ttvideov1` | 本轮新造：`video.mp4` + `cover.jpg` + 两个平台任务（抖音/小红书） |

### 未做（留待评估）

- 渠道级批量操作（例如「把本渠道待发布的一次性排期」）；
- 渠道内自定义列（头条显示字数/首发项，视频显示封面与时长）—— 现在两类共用同一行布局。
