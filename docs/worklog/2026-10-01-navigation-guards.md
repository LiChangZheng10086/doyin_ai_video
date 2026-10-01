# 导航拦截与弹窗：修掉三处「界面把自己锁死」

2026-10-01。用户报「我现在处于文章创作这里，无法切换到其他页面，比如发布」。排查确认**不是页面故障**，而是三处拦截器/弹窗**缺了出口** —— 症状完全一致：页面看上去正常、没有任何提示，但点导航毫无反应。

## 根因

**用户实际所在的界面是 `/articles/benchmarks`（对标研究），不是文章创作页。** 侧栏「文章创作」指向 `/articles`，而**导航标题对 `/articles*` 全部显示「文章创作」**（`renderer/src/components/shell/navigation.ts:64`），从那里再点「寻找同赛道对标账号」就进了对标页、标题却仍是「文章创作」。磁盘上 `cache/articles.json` **根本不存在**（一篇文章都没建过），也印证了不在文章详情页。

1. **对标页把「折叠起来的」新建对标组表单也当成未保存编辑。**
   原判定 `dirty=!!settings||!!editor||!!newName.trim()||!!newAudience.trim()||!!newKeywords.trim()`。这三项输入**已逐字进 sessionStorage**（重新展开即可恢复），但只要表单里留过字（例如展开后点了「新建对标组」把它收起、或上次遗留被自动恢复后又收起），`dirty` 就恒为真，而页面上**看不到任何待保存内容**。
   于是 `useBlocker(dirty && pathname 变化)` 会拦下**每一次**导航。
2. **唯一的解除入口会滚出视野。** 解除按钮只在页面顶部一条 `role="alert"` 横幅里，它是**普通文档流、没有 sticky/fixed**；用户滚在下方时完全看不到 ⇒ 表现就是「点了没反应」。
   对照：文章详情页 / 素材页 / 热点页 / 图集页在同样情况下都用 `window.confirm(...)`（不可能看不见）—— **只有对标页用页内横幅**，所以只有它会静默卡住。
3. **另两处同类缺陷（本次未触发，但同因）：**
   - `ArticleDetailPage`：blocked 时 `if (busy) return;` —— 既不 `proceed()` 也不 `reset()`，blocker **永远停在 blocked**，此后每次导航都被静默吞掉且不弹提示。（全仓库唯一这样写；素材页/热点页都是 `else blocker.reset()`。）
   - `CreateToutiaoArticleDialog`：`close()` 在 busy 时直接 `return`，而 `Modal` 打开时会给 `#root` 设 **`inert`**（整个应用不可点），且 Esc（`Modal.tsx:144`）、点遮罩（`:202`）、右上角 X（`disabled={busy}`）三条退路在忙时都被封 —— 只剩 footer 的「取消」也无效。请求一挂住（`api.ts` 默认超时 **960000ms ＝ 16 分钟**）应用就成了死胡同。

## 改动

- 新增 `renderer/src/utils/navigationGuards.ts`：三个纯函数 `benchmarkDirty` / `blockedNavigationAction` / `articleDialogCloseDecision`，各写明不变式。
  ⚠️ 最初把这三个函数直接 export 在**组件文件**里，Vite 立刻报 `Could not Fast Refresh (... export is incompatible)` —— 组件文件导出非组件值会破坏 Fast Refresh。已挪进独立模块（也符合仓库「纯函数放 `utils/`」的既有约定，如 `utils/publishing.ts`）。
- `WechatBenchmarksPage.tsx`：`dirty` 改走 `benchmarkDirty`（**折叠的新建组表单不再算未保存编辑**）；拦截横幅改 `sticky top-14 z-40`（顶栏是 `fixed top-0 h-14 z-30`，故取 `top-14`），不再被滚走；文案补「已拦下本次跳转」。
- `ArticleDetailPage.tsx`：blocked 时改走 `blockedNavigationAction` —— busy 时**一定 `reset`**（与素材页/热点页同口径），绝不把 blocker 挂在 blocked 上。
- `CreateToutiaoArticleDialog.tsx`：`close()` 改走 `articleDialogCloseDecision` —— busy 时**显式确认后可关**（后台请求不中断，结果仍可在发布中心查看），保证任何状态下都有出口。
- 新增 `renderer/src/utils/navigationGuards.test.ts`（3 条用例，各守一条不变式），并在用例注释里点明「核心回归」是哪一条。

## 验证

- `check:renderer` / `check:backend` 通过；全量 `npm test` **1120 通过、1 跳过、0 失败**。
- 三处都是 renderer，Vite HMR 已生效；HMR 日志确认重构后不再有 Fast Refresh 警告；内嵌后端 61825 与 Vite 5173 均 200。
- ⚠️ **未做浏览器交互验收**：仓库没有 jsdom / testing-library，renderer 用例一律是 `renderToStaticMarkup`（无 DOM），`useBlocker` 的真实交互无法用现有测试覆盖。这三处靠「纯函数 + 用例 + 代码证据」保证，端到端以用户实际点击为准。

## 未修 / 遗留

- 用户当时那次会话的 blocker 停在旧代码造成的 `blocked` 状态，需**刷新一次**（Cmd+R）才恢复；修复本身已 HMR 到位。
- **`busy` 为何会长时间为真未深究**：`api.ts` 默认超时 16 分钟，超时前没有任何中断手段。要不要给「创建文章包」这类操作加显式取消，待定。
- `AssetsPage` / `HotspotsPage` 的 busy 分支同样是 `reset()`（即忙时点导航会被取消），行为与本次已统一，但它们没有「忙时也能离开」的出口；本次未改。
