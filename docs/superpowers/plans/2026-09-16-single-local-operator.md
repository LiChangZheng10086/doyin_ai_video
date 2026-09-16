# 单一本机操作者 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 去掉所有面向使用者的登录/切换/用户管理界面，改为启动即自动使用单一「本机操作者」（管理员），同时完整保留后端身份、权限与发布审计模型。

**Architecture:** 后端新增一条语义明确的「本机操作者」路径 —— `LocalUserStore.ensureLocalOperator()` 负责选取或创建（无管理员时）该用户，`LocalSessionStore.openLocalOperator()` 负责在不修改 `open()` PIN 契约的前提下开启会话，`POST /api/local-sessions/auto` 把两者暴露给前端。前端 `operator.ts` 的 `initialize()` 改为调用该自动会话，并卸载 `LocalUserSetup` / `OperatorSwitcher` / `LocalUsersSettings` 三处 UI 与随之失效的工具代码。

**Tech Stack:** Node.js + Express 4 + TypeScript（后端）、React 19 + Zustand + Tailwind CSS（前端）、Node 内置 test runner（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-16-single-local-operator-design.md`

## Global Constraints

- 不修改 `LocalSessionStore.open()`：管理员无 PIN 仍必须抛 `local_user_pin_invalid`（401）。无 PIN 分支只允许存在于新增的 `openLocalOperator()`。
- 不修改 `LocalUserStore.bootstrap()` 与 `create()` 的既有校验（`create()` 对 admin 无 PIN 必须继续抛 `local_user_admin_pin_required`）。无 PIN 的管理员创建只允许通过新增的 `ensureLocalOperator()`。
- 不删除、不改名 `local-users.json` 中任何已有用户；不新建用户除非不存在任何 `isActive` 的管理员。
- 发布中心的权限判定、审计事件结构与 `actor` 字段一律不动；`currentUser` 的角色判定全部保留。
- 抖音 cookie 登录与顶栏连接状态不属于本系统，不得改动。
- 后端改动必须 `npm run build:backend` 并重启进程才生效；Electron 需整个重启。
- 提交时只暂存本特性的文件：工作区已有其他未提交改动（P0 昵称/日期兜底、走查产物），不得混入。

### Task 1: 后端「本机操作者」的选取/创建与会话

**Files:**
- Modify: `src/lib/local-users.ts`（新增 `ensureLocalOperator()` 与展示名常量）
- Modify: `src/lib/local-auth.ts`（抽出私有 `startSession()`，新增 `openLocalOperator()`）
- Test: `src/lib/local-users.test.ts`、`src/lib/local-auth.test.ts`

**Interfaces:**
- Consumes: 既有 `LocalUserStore.list/getActive/newUser/mutate`、既有 `LocalSessionStore.clearAll/createToken`
- Produces: `LocalUserStore.ensureLocalOperator(): Promise<LocalUserView>`；`LocalSessionStore.openLocalOperator(userId: string): Promise<LocalSessionView>`

- [ ] **Step 1: 写 `ensureLocalOperator` 的失败用例**

在 `src/lib/local-users.test.ts` 追加：

- 存在两个 `isActive` 管理员时，返回 `createdAt` 升序第一个；`createdAt` 相同时按 `id` 升序（构造一个 `createdAt` 相同的用例，断言结果确定）。
- 已存在管理员时**不新建**：断言调用前后 `list()` 长度不变。
- 无管理员（0 用户，或只有一个发布者）时创建：`role === "admin"`、`displayName === "本机用户"`、`isActive === true`，且**不含** `pinSalt` / `pinHash`（`newUser` 对 `pin === undefined` 本就不写凭据）。
- 已停用（`isActive: false`）的管理员不参与选取；若只有停用管理员，则新建「本机用户」。

- [ ] **Step 2: 写 `openLocalOperator` 的失败用例**

在 `src/lib/local-auth.test.ts` 追加：

- `openLocalOperator(adminId)` 在未提供任何 PIN 的情况下成功，返回 `{ token, user }`，且 `resolve(token)` 能取回同一用户。
- 打开会话会清空其它会话（与 `open()` 的 `clearAll()` 行为一致）。
- 对不存在或已停用的用户抛 `local_user_not_found`（404）。
- **对照断言（PIN 契约不能被放宽）**：同一管理员调用普通 `open({ userId })` 不带 PIN 仍抛 `local_user_pin_invalid`（401），带 PIN 成功。

- [ ] **Step 3: 运行聚焦测试确认失败**

Run: `node --import tsx --test src/lib/local-users.test.ts src/lib/local-auth.test.ts`
Expected: FAIL —— `ensureLocalOperator` / `openLocalOperator` 尚不存在。

- [ ] **Step 4: 实现 `ensureLocalOperator()`**

在 `LocalUserStore` 内新增（复用私有 `newUser` 与 `mutate`）：读取索引，筛出 `role === "admin" && isActive` 的用户，按 `createdAt` 升序、再按 `id` 升序取第一个并返回；集合为空时用 `newUser(LOCAL_OPERATOR_DISPLAY_NAME, "admin")`（不传 pin）创建、写入索引并返回。

- [ ] **Step 5: 实现 `openLocalOperator()`**

把 `open()` 中「`clearAll()` → `createToken()` → 写入 sessions」这段抽成私有 `startSession(user)`，让 `open()` 与新的 `openLocalOperator(userId)` 共用；`openLocalOperator` 只做 `getActive` 校验（失败抛 `local_user_not_found`）后调用 `startSession`，**不进入** admin 的 PIN 分支。

- [ ] **Step 6: 运行聚焦测试与回归门禁确认通过**

Run: `node --import tsx --test src/lib/local-users.test.ts src/lib/local-auth.test.ts`
Expected: PASS —— 新用例通过，既有 `local-users.test.ts`（15）与 `local-auth.test.ts`（9）用例全部保持通过。

### Task 2: 后端 `POST /api/local-sessions/auto` 路由

**Files:**
- Modify: `src/lib/local-user-routes.ts`
- Test: `src/app.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ensureLocalOperator()` 与 `openLocalOperator()`
- Produces: `POST /api/local-sessions/auto` → `201 { user, session }`（与 `POST /local-sessions` 同形）

- [ ] **Step 1: 写失败的路由用例**

沿用 `src/app.test.ts` 既有 `appFixture()` / `jsonFetch()` 脚手架追加：

- 空数据目录下调用自动会话 → `201`，`body.user.role === "admin"`、`body.user.displayName === "本机用户"`、`body.session.token` 非空。
- 用返回的 token 作为 `X-Local-Session` 调用一个 `requireActor` 接口（`GET /api/local-sessions/current`）→ `200` 且返回同一用户，证明该会话真的能通过鉴权。
- 已有管理员的数据目录（先 bootstrap 一个）→ 自动会话复用该管理员，且 `GET /api/local-users` 的用户数不变。

- [ ] **Step 2: 运行聚焦测试确认失败**

Run: `node --import tsx --test src/app.test.ts`
Expected: FAIL —— 路由不存在，返回 404。

- [ ] **Step 3: 实现路由**

在 `registerLocalUserRoutes` 中新增 `router.post("/local-sessions/auto", …)`：`const user = await deps.users.ensureLocalOperator()` → `const session = await deps.sessions.openLocalOperator(user.id)` → `res.status(201).json({ user, session })`，错误走既有 `next(error)` 通道。

- [ ] **Step 4: 运行聚焦测试确认通过**

Run: `node --import tsx --test src/app.test.ts`
Expected: PASS —— 新用例通过，既有 26 个用例（含 16 个身份/权限契约用例）全部保持通过。

### Task 3: 前端自动会话与 UI 卸载

**Files:**
- Modify: `renderer/src/store/operator.ts`、`renderer/src/services/api.ts`、`renderer/src/App.tsx`
- Modify: `renderer/src/components/shell/AppShell.tsx`、`renderer/src/components/shell/UtilityBar.tsx`
- Modify: `renderer/src/pages/SettingsPage.tsx`、`renderer/src/pages/JobDetailPage.tsx`、`renderer/src/pages/PublishingPage.tsx`
- Modify: `renderer/src/features/jobs/artifacts/VideoArtifact.tsx`（仅 Step 7 的文案）
- Create: `renderer/src/utils/settingsSections.ts`
- Delete: `renderer/src/components/LocalUserSetup.tsx`、`renderer/src/components/OperatorSwitcher.tsx`、`renderer/src/components/LocalUsersSettings.tsx`、`renderer/src/utils/localUsers.ts`
- Delete tests: `renderer/src/components/OperatorSwitcher.test.tsx`、`renderer/src/components/LocalUsersSettings.test.tsx`、`renderer/src/utils/localUsers.test.ts`
- Test: `renderer/src/store/operator.test.ts`（重写）

**Interfaces:**
- Consumes: `apiClient.openLocalOperatorSession(): Promise<LocalUserSessionResponse>`
- Produces: `createOperatorStore()` 仅保留 `initialize` / `currentUser` / `token` / `initialized`；不再读写 localStorage

- [ ] **Step 1: 重写 `operator.test.ts` 为失败用例**

替换文件内容（删除 recovery/restoration/sync/refresh 相关用例），覆盖：

- `initialize()` 调用自动会话并把 `currentUser`、`token`、`initialized: true` 落地，同时调用 `setLocalSession(token)`。
- 自动会话抛错时 `initialized` 保持 `true` 且 `currentUser` 为 `null`（降级，不把应用卡在初始化态）。
- store 不再依赖 localStorage：注入一个「一旦被访问就抛错」的 storage 存根，断言初始化仍成功。

- [ ] **Step 2: 运行聚焦测试确认失败**

Run: `node --import tsx --test renderer/src/store/operator.test.ts`
Expected: FAIL —— 现有 store 仍走 `getLocalUsers` + `findRestorablePublisher` 路径，且会读 localStorage。

- [ ] **Step 3: 收敛 `operator.ts`**

`initialize()` 改为单一自动会话调用；删除 `bootstrap` / `recover` / `switchUser` / `signOut` / `refreshUsers` / `syncUser` / `users` / `needsBootstrap` 与 `LAST_PUBLISHER_ID_KEY`、`findRestorablePublisher`、localStorage 读写辅助；`LocalIdentityClient` 收敛为 `setLocalSession` + `openLocalOperatorSession`。

- [ ] **Step 4: `api.ts` 新增自动会话方法并清理已无消费者的身份方法**

新增 `openLocalOperatorSession()`（`POST /api/local-sessions/auto`）。随后**逐个 grep 确认**再删除已无消费者的方法（`getLocalUsers` / `bootstrapLocalAdmin` / `recoverLocalIdentity` / `openLocalSession` / `closeLocalSession` / `createLocalUser` / `updateLocalUser` / `resetLocalUserPin`）；`setLocalSession` 必须保留。

- [ ] **Step 5: 迁出 `settingsSections` 并去掉 `users` 分组**

新建 `renderer/src/utils/settingsSections.ts` 承接该数组（移除 `users` 项），`SettingsPage.tsx` 改为从新路径导入；随后删除 `renderer/src/utils/localUsers.ts`。

- [ ] **Step 6: 卸载三处 UI 并删除组件**

`App.tsx` 去掉 `LocalUserSetup` 分支、`needsBootstrap`、`recoveryRequested`、`onRequestRecovery`；`AppShell.tsx` 与 `UtilityBar.tsx` 摘除 `OperatorSwitcher` 与 `onRequestRecovery` 传参；`SettingsPage.tsx` 删除 `LocalUsersSettings` 渲染。删除四个源文件与三个测试文件。

- [ ] **Step 7: 修正未就绪文案**

`currentUser` 为空时共有三处面向用户的文案，其中两处明确要求用户「在顶部选择」——而顶部切换入口本次被移除，不改就会变成误导：

| 位置 | 现文案 | 改为 |
| --- | --- | --- |
| `features/jobs/artifacts/VideoArtifact.tsx:60` | 需要选择操作者 | 本机操作者未就绪 |
| `pages/JobDetailPage.tsx:430` | 请先在顶部选择操作者 | 本机操作者未就绪，请重试 |
| `pages/PublishingPage.tsx:299` | 请选择操作者 / 在顶部选择发布者或管理员后查看发布任务。 | 本机操作者未就绪 / 请重试后再查看发布任务。 |

**分支逻辑与角色判定保持不动**，只替换文案字符串。

- [ ] **Step 8: 运行聚焦测试与类型检查确认通过**

Run: `node --import tsx --test renderer/src/store/operator.test.ts && npm run check`
Expected: 用例通过；`tsc` 双端无输出（若仍有文件引用已删除模块，`check:renderer` 会直接报错，据此清干净）。

### Task 4: 全量验证与生效

**Files:**
- 无源码改动（验证与部署步骤）

- [ ] **Step 1: 类型检查**

Run: `npm run check`
Expected: 后端与渲染器均退出码 0。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 删除 21 个 UI 专属用例（`OperatorSwitcher` 1 + `LocalUsersSettings` 3 + `localUsers` 17）、重写 6 个（`operator`），新增后端与 store 用例；除既有失败 `src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge` 外无新增失败。当前基线 385 项（383 通过 / 1 跳过 / 1 失败）。

- [ ] **Step 3: 编译后端产物**

Run: `npm run build:backend`
Expected: 退出码 0。

- [ ] **Step 4: 重启 3100 后端与 Electron**

两个进程都必须重启才会加载新 `dist`；Electron 在 dev 模式从 `dist/app.js` 加载后端。

- [ ] **Step 5: 接口层自证**

```bash
curl -s -X POST http://localhost:3100/api/local-sessions/auto
curl -s http://localhost:3100/api/local-users
```

Expected: 第一条返回 `201` 与 `{ user, session }`，`user.role === "admin"`；第二条的用户数**与改动前一致**（复用已有管理员，未新增用户）。

- [ ] **Step 6: 人工视觉复核**

（`cdp_*` / `computer_*` 在本 DSH 版本无法挂载，见 `docs/handoff-2026-09-15-ui-audit.md` 第 9 节）

1. 顶栏不再出现操作者 chip（桌面与窄屏两个断点都要看：`AppShell` 与 `UtilityBar` 各有一处挂载点）。
2. 设置页左侧不再有「用户」分组，其余分组可正常切换。
3. 用一份**全新数据目录**启动后端（例如 `PORT=3101` 指向空目录）打开页面，确认不再出现「创建本地管理员」。
4. 发布中心可正常进入，且 `withdraw` / 删除发布包 / 恢复发布包三个 admin 专属操作可见可用。

- [ ] **Step 7: 只暂存本特性文件并提交**

```bash
git add src/lib/local-users.ts src/lib/local-auth.ts src/lib/local-user-routes.ts \
        src/lib/local-users.test.ts src/lib/local-auth.test.ts src/app.test.ts \
        renderer/src/store/operator.ts renderer/src/store/operator.test.ts \
        renderer/src/services/api.ts renderer/src/App.tsx \
        renderer/src/components/shell/AppShell.tsx renderer/src/components/shell/UtilityBar.tsx \
        renderer/src/pages/SettingsPage.tsx renderer/src/pages/JobDetailPage.tsx \
        renderer/src/pages/PublishingPage.tsx renderer/src/utils/settingsSections.ts \
        renderer/src/features/jobs/artifacts/VideoArtifact.tsx \
        renderer/src/components/LocalUserSetup.tsx renderer/src/components/OperatorSwitcher.tsx \
        renderer/src/components/LocalUsersSettings.tsx renderer/src/utils/localUsers.ts \
        renderer/src/components/OperatorSwitcher.test.tsx \
        renderer/src/components/LocalUsersSettings.test.tsx renderer/src/utils/localUsers.test.ts
git commit -m "feat: 去除登录/切换入口，改为单一本机操作者"
```

工作区中的 P0 昵称/日期兜底改动与走查产物不得进入本次提交。
