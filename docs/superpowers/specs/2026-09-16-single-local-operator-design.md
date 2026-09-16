# 抖创工坊 单一本机操作者 设计规格

**状态：** APPROVED
**批准日期：** 2026-09-16
**日期：** 2026-09-16
**产品：** 抖创工坊
**范围：** 去除本地用户面向使用者的登录/切换入口，改为启动即自动使用单一「本机操作者」
**实施边界：** 只改「人」这一层的界面与自动会话取得方式；后端 users/sessions/PIN/roles 模型、发布中心权限与审计数据结构全部保持兼容

## 1. 背景与结论

用户反馈：项目只有自己一个人使用，顶部切换账号属于功能冗余，希望去除登录功能。

先纠正一个事实：**桌面端并没有「登录」这一步**。`renderer/src/store/operator.ts` 的 `initialize()` 会自动从 localStorage 恢复上次的**发布者**并直接开会话（`openLocalSession(publisher.id)` 不带 pin，`operator.ts:120-127`），只有切到**管理员**才需要 PIN（`src/lib/local-auth.ts:36-43`：admin 无 PIN 直接 401）。

但它确实是一套本地身份 + 权限系统，真实摩擦点有四处：

| 组件 | 行为 |
| --- | --- |
| 首次启动门 | 用户数为 0 时整个应用被 `LocalUserSetup` 顶掉，强制创建本地管理员（`renderer/src/App.tsx:40`，位于 `<BrowserRouter>` 之前） |
| 顶部操作者 chip | `OperatorSwitcher`，**两个挂载点**：`shell/AppShell.tsx:52` 与 `shell/UtilityBar.tsx:36` |
| 管理员 PIN 与身份恢复 | 切到 admin 需 PIN；另有独立的恢复流程 |
| 设置页用户管理 | `LocalUsersSettings`（`SettingsPage.tsx:361`），可建/改/停用用户、重置 PIN |

**它不只是 UI**：发布中心以此为权限与审计底座 —— `publishing-routes.ts:48-49` 定义 `authenticated` / `admin` 两道门，全部发布接口要求 `authenticated`，其中 `withdraw`、删除发布包、恢复发布包要求 `admin`（同文件 `151,187,192` 行）；`publishing-store.ts` 把 `actor` 写入 `createdBy` 与每条审计事件；`PublishingPage.tsx:346` 按 `currentUser.role` 显隐管理操作。

因此本次采取**方案 A**：把所有面向使用者的登录/切换界面去掉，底层保留身份与权限模型，启动时自动使用单一本机操作者。

本机现状（`~/Library/Application Support/douyin-ai-video/storage/cache/local-users.json`）：2 个用户，`lcz`（admin，有 PIN）与 `lcz_1`（publisher，无 PIN）。

## 2. 已确认设计决策

| 决策 | 结果 |
| --- | --- |
| 去除深度 | 界面上完全去掉登录/切换/用户管理；后端身份与权限模型保留 |
| 自动操作者角色 | 必须是**管理员**，否则会丢掉发布中心三个 admin 专属操作 |
| 首次启动 | 不再出现创建管理员的门；无管理员时静默创建「本机用户」 |
| PIN | 自动会话路径不要求 PIN（见第 8 节风险） |
| 复用已有用户 | 优先复用已有管理员，保持发布审计的历史 actor 连续 |
| 已有用户处置 | 不删除、不改名；`lcz_1` 留在数据中，界面不再出现 |
| 抖音 cookie 登录 | 不属于本系统，完全不动 |
| 发布中心权限与审计 | 数据结构与判定逻辑不动 |

## 3. 后端设计

### 3.1 新增自动会话路由

```
POST /api/local-sessions/auto
```

行为：

1. 选出**本机操作者**：在 `isActive` 的管理员中按 `createdAt` 升序（相同则按 `id` 升序）取第一个，保证同一份数据下每次启动选到同一个人，不依赖对象键顺序。
2. 若不存在任何管理员（全新安装、用户数为 0），就地创建一个：`displayName: "本机用户"`、`role: "admin"`、无 PIN。
3. 为该用户开启会话，返回 `{ user, session }`，与 `POST /api/local-sessions` 响应同形。

### 3.2 不削弱既有 PIN 契约

**不修改** `LocalSessionStore.open()`：管理员无 PIN 仍然抛 `local_user_pin_invalid`（401）。新增一个语义明确的方法 `openLocalOperator(userId)` 承载无 PIN 分支。

这样「普通 open 必须验 PIN」这条规则继续被 `src/lib/local-auth.test.ts` 的既有用例守着，PIN 绕过只存在于一条被显式命名的路径上，而不是把 `open()` 放宽成两种语义。

### 3.3 为什么自动操作者必须是管理员

发布中心的 `withdraw`（`publishing-routes.ts:151`）、删除发布包（`:187`）、恢复发布包（`:192`）是 `admin` 专属。若自动会话返回发布者，单用户场景下这三个操作会直接 403，属于功能倒退。

## 4. 前端设计

| 位置 | 改动 |
| --- | --- |
| `store/operator.ts` | `initialize()` 改为调用自动会话；删除 `bootstrap` / `recover` / `switchUser` / `signOut` / `refreshUsers` / `syncUser` 与 `needsBootstrap` 字段；`LocalIdentityClient` 收敛为 `setLocalSession` + 自动会话两项 |
| `App.tsx` | 删除 `LocalUserSetup` 门、`needsBootstrap` 分支、`recoveryRequested` 与 `onRequestRecovery` |
| `shell/AppShell.tsx`、`shell/UtilityBar.tsx` | 两处挂载点均摘除 `OperatorSwitcher` 与 `onRequestRecovery` 传参 |
| `pages/SettingsPage.tsx` | 删除 `users` 分组与 `LocalUsersSettings` |
| 新增 `utils/settingsSections.ts` | 承接原 `utils/localUsers.ts` 的 `settingsSections`，并从列表中移除 `users` 项 |
| 删除 | `components/LocalUserSetup.tsx`、`components/OperatorSwitcher.tsx`、`components/LocalUsersSettings.tsx`、`utils/localUsers.ts` |

### 4.1 保留不动的部分

`currentUser` 的角色判定全部保留：`PublishingPage.tsx:346` 的 `role={currentUser.role}`、`PublishingPage.tsx:92,106,266,283` 与 `JobDetailPage.tsx:429` 的 `currentUser` 判空**分支逻辑**、`utils/publishing.ts` 中按角色显隐的操作。这些判空分支的**存在**保留（自动会话失败时仍需要降级表现），只有其中的提示文案按 4.2 修改。

### 4.2 需要顺带修正的文案

`currentUser` 为空时共有三处面向用户的文案，其中两处明确要求用户「在顶部选择」：

| 位置 | 现文案 | 改为 |
| --- | --- | --- |
| `features/jobs/artifacts/VideoArtifact.tsx:60` | 需要选择操作者 | 本机操作者未就绪 |
| `pages/JobDetailPage.tsx:430` | 请先在顶部选择操作者 | 本机操作者未就绪，请重试 |
| `pages/PublishingPage.tsx:299` | 请选择操作者 / 在顶部选择发布者或管理员后查看发布任务。 | 本机操作者未就绪 / 请重试后再查看发布任务。 |

顶部切换入口被移除后，原文案里的「在顶部选择」已无对应操作，会变成误导。这些文案现在只会在自动会话失败（例如后端不可达）时出现。**分支逻辑与角色判定保持不动，只替换文案字符串**。

### 4.3 顺带清理的死代码

`utils/localUsers.ts` 中的 `canWithdrawPublished` 与 `LocalUserMutationOutcome` **在本改动之前就已无任何消费者**；`canManageUsers`、`runLocalUserMutation`、`createLocalUserMutationLock`、`canRestoreLocalUserDialogFocus`、`validateAdminSetup`、`localIdentityErrorMessage`、`findRestorablePublisher` 的消费者只有本次要删除的组件与 store 逻辑。因此删除该文件后不需要保留任何导出（`settingsSections` 已迁出）。

## 5. 数据策略

- **复用已有管理员**：存在 `isActive` 的管理员时直接使用它，不新建用户。发布中心审计里的历史 `actor` 因此保持指向同一用户 id，历史记录不断裂。
- **不删除、不改名**任何已有用户。`lcz_1`（发布者）留在数据中，界面不再出现。
- 仅在**不存在任何管理员**时创建「本机用户」。
- 不做「把已有管理员改名成『本机用户』」：那会写入用户数据文件，而收益仅是顶栏少一个名字 —— 而顶栏该区域本次整体移除。

## 6. 明确不做

- 抖音 cookie 登录与顶栏「抖音已登录」状态（爬取依赖，与本系统无关）
- 后端 `local-users.ts` / `local-auth.ts` / `local-user-routes.ts` 的身份与权限模型
- 发布中心的权限判定、审计事件结构与 `actor` 字段
- `local-users.json` 中的历史用户数据
- 多人协作、角色细分等未来可能的扩展（本次只服务单用户场景）

## 7. 测试与验证

| 类别 | 内容 |
| --- | --- |
| 删除 | 21 个 UI 专属用例：`OperatorSwitcher.test.tsx` 1 + `LocalUsersSettings.test.tsx` 3 + `localUsers.test.ts` 17 |
| 重写 | `store/operator.test.ts` 6 个用例改为覆盖自动会话（不再覆盖 bootstrap/recover/switchUser） |
| 保留 | 46 个：`local-users.test.ts` 15 + `local-auth.test.ts` 9 + `app.test.ts` 中 16 个权限契约用例 + `publishing-store.test.ts` 相关用例 |
| 新增 | 后端：自动会话路由（复用管理员 / 无管理员时创建 / **普通 `POST /local-sessions` 对 admin 无 PIN 仍返回 401** 的对照断言）；前端：store 自动会话与 `currentUser` 落地 |

**验证命令**：`npm run check`、`npm test`、`npm run build:backend`。
**测试基线**：当前全量 385 项 / 383 通过 / 1 跳过 / 1 既有失败（`src/lib/publishing-service.test.ts` 的 `startup recovery reports asset phases before due handling and purge`，与本特性无关）。

**生效条件**：后端改动必须 `npm run build:backend` 并重启进程；Electron 需整个重启才会重新加载 `dist/app.js`。

**人工验证**（`cdp_*` / `computer_*` 在本 DSH 版本下无法挂载，见 `docs/handoff-2026-09-15-ui-audit.md` 第 9 节）：重启后顶栏不再有操作者 chip、设置页不再有「用户」分组、全新数据目录下不再出现「创建本地管理员」，且发布中心可正常建包与执行 admin 专属操作。

## 8. 风险

| 风险 | 说明与处理 |
| --- | --- |
| **绕过管理员 PIN** | 自动会话路径不验 PIN，等于任何能打开本机应用的人都拥有完整管理权限（含删除发布包）。这是单用户本机场景的既定取舍，已与用户确认。数据仍只在本机 `storage/` 下，不新增外部暴露面 |
| PIN 契约被无意放宽 | 通过新增 `openLocalOperator()` 而非修改 `open()` 来控制影响面，并以对照断言守护原契约 |
| 自动会话失败导致发布不可用 | 前端保留 `currentUser` 判空分支，但把文案改为「本机操作者未就绪，请重试」，避免出现「需要选择操作者」这种已无操作可选的误导 |
| 删除 UI 组件时误删仍被引用的工具函数 | 删除前逐个核对消费者：`settingsSections` 迁出后，其余导出确认只被待删组件引用 |
| 历史审计归属变化 | 复用已有管理员即保持 `actor` 连续；不新建用户 |

## 9. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/lib/local-auth.ts` | 新增 `openLocalOperator(userId)`（不改 `open()`） |
| `src/lib/local-user-routes.ts` | 新增 `POST /local-sessions/auto` 与「本机操作者」选取/创建逻辑 |
| `src/lib/local-auth.test.ts` | 新增 `openLocalOperator` 的单元用例（管理员无 PIN 可开会话；普通 `open()` 对管理员无 PIN 仍 401 的对照断言） |
| `src/app.test.ts` | 新增路由用例：复用已有管理员、无管理员时创建「本机用户」、响应形状与 `/local-sessions` 一致 |
| `renderer/src/store/operator.ts` | `initialize()` 改用自动会话；删除登录态相关 action 与 `needsBootstrap` |
| `renderer/src/store/operator.test.ts` | 重写为覆盖自动会话 |
| `renderer/src/App.tsx` | 删除 `LocalUserSetup` 门与恢复入口 |
| `renderer/src/components/shell/AppShell.tsx`、`UtilityBar.tsx` | 摘除 `OperatorSwitcher` 与 `onRequestRecovery` |
| `renderer/src/pages/SettingsPage.tsx` | 删除 `users` 分组与 `LocalUsersSettings` |
| `renderer/src/utils/settingsSections.ts` | 新增，承接 `settingsSections`（去掉 `users`） |
| `renderer/src/pages/JobDetailPage.tsx`、`PublishingPage.tsx`、`renderer/src/features/jobs/artifacts/VideoArtifact.tsx` | 仅按 4.2 修正未就绪文案，角色判定与分支逻辑不变 |
| 删除 | `LocalUserSetup.tsx`、`OperatorSwitcher.tsx`、`LocalUsersSettings.tsx`、`utils/localUsers.ts` 及对应 21 个用例 |
