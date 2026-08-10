# 本地用户与权限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为抖创工坊增加本地管理员/发布者档案、管理员 PIN、内存会话、服务端角色校验和操作者切换，为后续发布中心提供可信的本机操作者上下文。

**Architecture:** 后端使用 `LocalUserStore` 持久化本地用户，使用 `LocalSessionStore` 保存进程内会话；Express 中间件从 `X-Local-Session` 解析操作者并执行角色授权。前端使用独立 Zustand store 管理当前操作者，首次无用户时显示管理员初始化，顶部切换器负责发布者直接切换和管理员 PIN 验证。

**Tech Stack:** TypeScript 5、Node.js `crypto.scrypt`、Express 4、React 19、Zustand、现有 `LocalStorage`、Node test runner。

## Global Constraints

- Implements `REQ-012` and identity foundations required by `REQ-008`/`REQ-013` from `docs/superpowers/specs/2026-08-10-publishing-center-design.md`.
- 管理员 PIN 必须为 6-12 位数字，使用随机盐和 `scrypt` 哈希；任何响应、日志和前端状态都不得包含 PIN、盐或哈希。
- 发布者不使用 PIN；管理员会话只存在后端内存中，切换用户、恢复身份或退出进程后失效。
- 至少保留一个启用管理员；最后一个启用管理员不能停用或降级。
- 权限由 Express 服务端强制执行，前端按钮状态只用于体验，不能作为安全边界。
- 本地身份是工作流约束，不宣称抵御拥有本机文件系统或调试权限的用户。
- 所有用户可见文字使用简体中文；不增加第三方运行时依赖。
- 本计划不创建发布包、发布状态或发布中心页面。

## Requirement Coverage

| Requirement | Implemented by |
| --- | --- |
| `REQ-012` | Tasks 2-7: local profiles, PIN, one current session, server authorization, setup/switching, and user management |
| `REQ-008` identity dependency | Tasks 2-4: immutable server-derived `ActorSnapshot` and `SYSTEM_ACTOR` contract |
| `REQ-013` identity dependency | Tasks 4-7: complete identity REST client/UI and stable 401/403 behavior |

---

## File Structure

### Create

- `src/lib/storage.test.ts`：原子 JSON 写入和失败保留旧文件测试。
- `src/lib/local-users.ts`：本地用户持久化、PIN 哈希、用户管理和身份恢复。
- `src/lib/local-users.test.ts`：用户领域规则测试。
- `src/lib/local-auth.ts`：内存会话、操作者解析和 Express 授权中间件。
- `src/lib/local-auth.test.ts`：会话与角色授权测试。
- `src/lib/local-user-routes.ts`：本地用户和会话 REST 路由。
- `renderer/src/store/operator.ts`：当前操作者、用户列表和会话令牌状态。
- `renderer/src/utils/localUsers.ts`：角色文案与纯权限判断。
- `renderer/src/utils/localUsers.test.ts`：前端纯函数测试。
- `renderer/src/components/LocalUserSetup.tsx`：首次管理员初始化和身份恢复表单。
- `renderer/src/components/OperatorSwitcher.tsx`：顶部操作者选择和管理员 PIN 对话框。
- `renderer/src/components/LocalUsersSettings.tsx`：设置页本地用户管理。

### Modify

- `src/types.ts`：新增本地用户、操作者快照和会话公开类型。
- `src/lib/storage.ts`：新增原子 JSON 写入，不改变现有 `writeJson()` 行为。
- `src/app.ts`：初始化身份服务、允许会话请求头并注册路由。
- `src/app.test.ts`：增加身份 API 集成测试。
- `renderer/src/types/index.ts`：新增身份 API 类型。
- `renderer/src/services/api.ts`：会话请求头和身份 API 客户端。
- `renderer/src/App.tsx`：身份初始化、顶部切换器和全局身份状态。
- `renderer/src/pages/SettingsPage.tsx`：增加“本地用户”设置分组。
- `README.md`：记录本地角色边界和管理员恢复方式。

---

### Task 1: 原子 JSON 写入基础

**Files:**
- Modify: `src/lib/storage.ts`
- Create: `src/lib/storage.test.ts`

**Interfaces:**
- Produces: `LocalStorage.writeJsonAtomic(relativePath: string, data: unknown): Promise<string>`.
- Produces: 后续用户索引和发布索引共用的同目录临时文件 + `sync()` + `rename()` 语义。

- [ ] **Step 1: Write failing tests for atomic replacement and cleanup**

```typescript
test("writeJsonAtomic replaces a JSON document", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atomic-json-"));
  const storage = new LocalStorage(root);
  await storage.writeJson("cache/value.json", { version: 1 });

  await storage.writeJsonAtomic("cache/value.json", { version: 2 });

  assert.deepEqual(await storage.readJson("cache/value.json"), { version: 2 });
  assert.deepEqual((await readdir(path.join(root, "cache"))).sort(), ["value.json"]);
});

test("writeJsonAtomic keeps the previous file when rename fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atomic-json-fail-"));
  const storage = new LocalStorage(root, {
    rename: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
  });
  await storage.writeJson("cache/value.json", { version: 1 });

  await assert.rejects(() => storage.writeJsonAtomic("cache/value.json", { version: 2 }), /disk full/);
  assert.deepEqual(await storage.readJson("cache/value.json"), { version: 1 });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --import tsx --test src/lib/storage.test.ts`

Expected: FAIL because `LocalStorage` does not accept file-operation overrides and has no `writeJsonAtomic()`.

- [ ] **Step 3: Add injectable file operations and atomic write**

```typescript
type StorageFileOps = {
  open: typeof open;
  rename: typeof rename;
  rm: typeof rm;
};

export class LocalStorage {
  constructor(
    private readonly baseDir: string,
    private readonly fileOps: StorageFileOps = { open, rename, rm }
  ) {}

  async writeJsonAtomic(relativePath: string, data: unknown) {
    const fullPath = this.resolve(relativePath);
    const tempPath = `${fullPath}.next-${randomUUID()}`;
    await mkdir(path.dirname(fullPath), { recursive: true });
    const handle = await this.fileOps.open(tempPath, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      await handle.sync();
      await handle.close();
      await this.fileOps.rename(tempPath, fullPath);
      return fullPath;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.fileOps.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
```

Keep `writeJson()` unchanged so this foundation does not silently alter existing job/collection persistence.

- [ ] **Step 4: Run focused and existing storage consumers**

Run: `node --import tsx --test src/lib/storage.test.ts src/lib/jobs.test.ts src/lib/collections.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: add atomic local json writes"
```

---

### Task 2: 本地用户存储与 PIN 规则

**Files:**
- Modify: `src/types.ts`
- Create: `src/lib/local-users.ts`
- Create: `src/lib/local-users.test.ts`

**Interfaces:**
- Consumes: `LocalStorage.writeJsonAtomic()` from Task 1.
- Produces: `LocalUserStore`, `LocalUserError`, `SYSTEM_ACTOR`, and sanitized `LocalUserView` values.

- [ ] **Step 1: Add identity types and failing domain tests**

Add to `src/types.ts`:

```typescript
export type LocalUserRole = "admin" | "publisher";
export type ActorRole = LocalUserRole | "system";

export interface LocalUserView {
  id: string;
  displayName: string;
  role: LocalUserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActorSnapshot {
  userId: string;
  displayName: string;
  role: ActorRole;
}

export interface LocalSessionView {
  token: string;
  user: LocalUserView;
}
```

Write these cases in `src/lib/local-users.test.ts`:

```typescript
test("bootstrap creates the first admin without persisting plaintext pin", async () => {
  const { store, storage } = await fixture();
  const admin = await store.bootstrap({ displayName: "管理员", pin: "123456" });
  assert.equal(admin.role, "admin");
  assert.equal(await store.verifyPin(admin.id, "123456"), true);
  const stored = await storage.readJson<{
    users: Record<string, { pinSalt?: string; pinHash?: string }>;
  }>("cache/local-users.json");
  const raw = JSON.stringify(stored);
  assert.doesNotMatch(raw, /123456/);
  assert.ok(stored.users[admin.id].pinSalt);
  assert.ok(stored.users[admin.id].pinHash);
  assert.equal("pinHash" in (await store.list())[0], false);
});

```

Required test matrix:

```typescript
test("rejects invalid pins and a second bootstrap", async () => {
  const { store } = await fixture();
  await assert.rejects(() => store.bootstrap({ displayName: "管理员", pin: "123" }),
    (error: LocalUserError) => error.code === "local_user_pin_invalid");
  await store.bootstrap({ displayName: "管理员", pin: "123456" });
  await assert.rejects(() => store.bootstrap({ displayName: "管理员二", pin: "654321" }),
    (error: LocalUserError) => error.code === "local_users_already_initialized");
});

test("publisher records cannot contain a pin", async () => {
  const { store, storage } = await adminFixture();
  await assert.rejects(() => store.create(ADMIN, { displayName: "发布者", role: "publisher", pin: "123456" }),
    (error: LocalUserError) => error.code === "local_user_publisher_pin_forbidden");
  const publisher = await store.create(ADMIN, { displayName: "发布者", role: "publisher" });
  const stored = await storage.readJson<LocalUsersIndex>("cache/local-users.json");
  assert.equal(stored.users[publisher.id].pinSalt, undefined);
  assert.equal(stored.users[publisher.id].pinHash, undefined);
});

test("keeps the last active administrator", async () => {
  const { store, readIndexBytes, admin } = await adminFixture();
  const before = await readIndexBytes();
  await assert.rejects(() => store.update(ADMIN, admin.id, { isActive: false }),
    (error: LocalUserError) => error.code === "local_user_last_admin");
  assert.deepEqual(await readIndexBytes(), before);
});

test("recovery leaves publishing data byte-for-byte unchanged", async () => {
  const { store, storage, readPublishingBytes } = await adminFixture();
  await storage.writeJsonAtomic("cache/publishing-index.json", { schemaVersion: 1, marker: "keep" });
  const before = await readPublishingBytes();
  await store.recover({ confirmation: "重置本地用户", displayName: "新管理员", pin: "654321" });
  assert.deepEqual(await readPublishingBytes(), before);
});
```

The test may inspect the persisted file through `LocalStorage.readJson()` because it verifies hashing. Production methods and HTTP responses must remain sanitized.

- [ ] **Step 2: Run the domain test and verify failure**

Run: `node --import tsx --test src/lib/local-users.test.ts`

Expected: FAIL because identity types and `LocalUserStore` do not exist.

- [ ] **Step 3: Implement `LocalUserStore`**

```typescript
export const SYSTEM_ACTOR: ActorSnapshot = {
  userId: "system",
  displayName: "系统",
  role: "system",
};

export class LocalUserStore {
  constructor(private readonly storage: LocalStorage) {}

  init(): Promise<void>;
  list(): Promise<LocalUserView[]>;
  hasUsers(): Promise<boolean>;
  bootstrap(input: { displayName: string; pin: string }): Promise<LocalUserView>;
  create(actor: ActorSnapshot, input: { displayName: string; role: LocalUserRole; pin?: string }): Promise<LocalUserView>;
  update(actor: ActorSnapshot, id: string, changes: { displayName?: string; role?: LocalUserRole; isActive?: boolean; pin?: string }): Promise<LocalUserView>;
  resetPin(actor: ActorSnapshot, id: string, pin: string): Promise<void>;
  verifyPin(id: string, pin: string): Promise<boolean>;
  recover(input: { confirmation: string; displayName: string; pin: string }): Promise<LocalUserView>;
  getActive(id: string): Promise<LocalUserView | null>;
}
```

Implementation rules:

```typescript
const USERS_INDEX = "cache/local-users.json";
const RECOVERY_CONFIRMATION = "重置本地用户";
const PIN_PATTERN = /^\d{6,12}$/;

type StoredLocalUser = LocalUserView & { pinSalt?: string; pinHash?: string };
type LocalUsersIndex = { schemaVersion: 1; users: Record<string, StoredLocalUser> };
```

Use `randomBytes(16)`, promisified `scrypt(pin, salt, 64)`, and `timingSafeEqual`. `list()` and all returned values must strip `pinSalt`/`pinHash`. `create()` requires `actor.role === "admin"`; admins require a valid PIN, publishers reject `pin`. `update()` requires a valid new PIN when changing `publisher -> admin`, removes PIN data for `admin -> publisher`, and rejects `pin` when the role is not becoming/staying admin. `recover()` atomically replaces only the users index. Serialize every mutating method through one store-local promise queue so concurrent user API calls cannot overwrite one another.

- [ ] **Step 4: Run tests and inspect the persisted fixture**

Run: `node --import tsx --test src/lib/local-users.test.ts`

Expected: PASS, including plaintext PIN absence and last-admin protection.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/local-users.ts src/lib/local-users.test.ts
git commit -m "feat: add local user identities"
```

---

### Task 3: 内存会话与服务端角色授权

**Files:**
- Create: `src/lib/local-auth.ts`
- Create: `src/lib/local-auth.test.ts`

**Interfaces:**
- Consumes: `LocalUserStore.getActive()` and `verifyPin()`.
- Produces: `LocalSessionStore`, `requireActor()`, `getActor()`, and `AuthedRequest`.

- [ ] **Step 1: Write failing session and middleware tests**

```typescript
test("publisher session opens without pin and admin requires a valid pin", async () => {
  const { users, publisher, admin } = await userFixture();
  const sessions = new LocalSessionStore(users, () => "token-1");
  assert.equal((await sessions.open({ userId: publisher.id })).token, "token-1");
  await assert.rejects(() => sessions.open({ userId: admin.id }), /管理员 PIN/);
  await assert.rejects(() => sessions.open({ userId: admin.id, pin: "000000" }), /PIN 不正确/);
});

```

```typescript
test("requireActor enforces session and role", async () => {
  const { sessions, publisherToken, request } = await authHttpFixture();
  assert.equal((await request("POST", "/publisher")).status, 401);
  assert.equal((await request("POST", "/publisher", publisherToken)).status, 200);
  assert.equal((await request("POST", "/admin", publisherToken)).status, 403);
});

test("a successful switch invalidates the previous token", async () => {
  const { sessions, admin, publisher } = await sessionFixture();
  const adminSession = await sessions.open({ userId: admin.id, pin: "123456" });
  const publisherSession = await sessions.open({ userId: publisher.id });
  assert.equal(await sessions.resolve(adminSession.token), null);
  assert.equal((await sessions.resolve(publisherSession.token))?.id, publisher.id);
  sessions.close(publisherSession.token);
  assert.equal(await sessions.resolve(publisherSession.token), null);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test src/lib/local-auth.test.ts`

Expected: FAIL because `local-auth.ts` does not exist.

- [ ] **Step 3: Implement sessions and middleware**

```typescript
export class LocalSessionStore {
  private readonly sessions = new Map<string, { userId: string; createdAt: string }>();

  constructor(
    private readonly users: LocalUserStore,
    private readonly createToken: () => string = () => randomBytes(32).toString("base64url")
  ) {}

  async open(input: { userId: string; pin?: string }): Promise<LocalSessionView>;
  async resolve(token?: string): Promise<LocalUserView | null>;
  close(token?: string): void;
  clearAll(): void;
}

export type AuthedRequest = Request & { localActor?: ActorSnapshot };

export function requireActor(
  sessions: LocalSessionStore,
  roles: LocalUserRole[] = ["admin", "publisher"]
): RequestHandler;

export function getActor(req: Request): ActorSnapshot {
  const actor = (req as AuthedRequest).localActor;
  if (!actor) throw new LocalAuthError("local_session_required", 401, "请选择当前操作者");
  return actor;
}
```

`open()` first validates the target user and administrator PIN; only after validation succeeds does it clear every previous token and create the single current session. A failed switch leaves the current session valid. `requireActor()` reads `X-Local-Session`, resolves a currently active user on every request, attaches a fresh `ActorSnapshot`, and returns stable codes `local_session_required` or `local_role_forbidden`. Never trust role/name fields from the request body.

- [ ] **Step 4: Run focused tests**

Run: `node --import tsx --test src/lib/local-auth.test.ts src/lib/local-users.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-auth.ts src/lib/local-auth.test.ts
git commit -m "feat: enforce local user sessions"
```

---

### Task 4: 本地用户 REST API

**Files:**
- Create: `src/lib/local-user-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/app.test.ts`

**Interfaces:**
- Consumes: `LocalUserStore`, `LocalSessionStore`, `requireActor()`.
- Produces: identity routes from specification section 15.1 and `app.locals.localUsers/localSessions` for publishing registration.

- [ ] **Step 1: Add failing API integration tests**

Add a reusable server fixture to `src/app.test.ts`, then cover:

```typescript
test("local user api bootstraps once and switches publisher/admin sessions", async () => {
  const { baseUrl } = await appFixture();
  const boot = await jsonFetch(baseUrl, "/api/local-users/bootstrap", {
    method: "POST",
    body: { displayName: "主管", pin: "123456" },
  });
  assert.equal(boot.response.status, 201);
  assert.equal(boot.body.user.role, "admin");
  assert.ok(boot.body.session.token);

  const duplicate = await jsonFetch(baseUrl, "/api/local-users/bootstrap", {
    method: "POST",
    body: { displayName: "第二位主管", pin: "654321" },
  });
  assert.equal(duplicate.response.status, 409);
});
```

```typescript
test("publisher cannot manage users and admin can", async () => {
  const { baseUrl, publisherToken, adminToken } = await identityApiFixture();
  const denied = await jsonFetch(baseUrl, "/api/local-users", { method: "POST", token: publisherToken, body: { displayName: "新用户", role: "publisher" } });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.code, "local_role_forbidden");
  const created = await jsonFetch(baseUrl, "/api/local-users", { method: "POST", token: adminToken, body: { displayName: "新用户", role: "publisher" } });
  assert.equal(created.response.status, 201);
});

test("recovery invalidates the old session and preserves publishing bytes", async () => {
  const fixture = await identityApiFixture({ publishingIndex: { marker: "keep" } });
  const before = await fixture.readPublishingBytes();
  const recovered = await jsonFetch(fixture.baseUrl, "/api/local-users/recover", {
    method: "POST", body: { confirmation: "重置本地用户", displayName: "恢复管理员", pin: "654321" },
  });
  assert.equal(recovered.response.status, 201);
  assert.equal((await fixture.getCurrent(fixture.adminToken)).response.status, 401);
  assert.deepEqual(await fixture.readPublishingBytes(), before);
});

test("identity responses never expose pin secrets", async () => {
  const responses = await collectIdentityResponses();
  for (const body of responses) {
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /123456|pinHash|pinSalt/);
  }
});
```

- [ ] **Step 2: Run the API tests and verify failure**

Run: `node --import tsx --test src/app.test.ts`

Expected: FAIL with 404 for `/api/local-users/bootstrap`.

- [ ] **Step 3: Register identity services before business routes**

In `createExpressApp()`:

```typescript
const localUsers = new LocalUserStore(storage);
await localUsers.init();
const localSessions = new LocalSessionStore(localUsers);

app.locals.localUsers = localUsers;
app.locals.localSessions = localSessions;
registerLocalUserRoutes(app, { users: localUsers, sessions: localSessions });
```

Update CORS:

```typescript
res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Local-Session");
```

Register routes with exact behavior:

```typescript
export function registerLocalUserRoutes(
  app: Express,
  deps: { users: LocalUserStore; sessions: LocalSessionStore }
): void;
```

- `GET /api/local-users` returns sanitized users and `needsBootstrap`.
- `POST /bootstrap` is allowed only when no users and returns the new admin plus a session.
- `POST /recover` validates `confirmation`, creates the replacement admin, calls `sessions.clearAll()`, then returns a new admin session.
- User create/update/reset routes require admin.
- Session open returns 404 for missing/inactive users and a generic 401 for invalid admin PIN.
- Session close is idempotent.

Add one Express error mapper for `LocalUserError`/`LocalAuthError`; do not scatter status mapping through handlers.

- [ ] **Step 4: Run API and full backend tests**

Run: `node --import tsx --test src/app.test.ts src/lib/local-users.test.ts src/lib/local-auth.test.ts`

Expected: PASS.

- [ ] **Step 5: Run type check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/app.test.ts src/lib/local-user-routes.ts
git commit -m "feat: expose local user api"
```

---

### Task 5: 前端身份客户端与状态

**Files:**
- Modify: `renderer/src/types/index.ts`
- Modify: `renderer/src/services/api.ts`
- Create: `renderer/src/store/operator.ts`
- Create: `renderer/src/utils/localUsers.ts`
- Create: `renderer/src/utils/localUsers.test.ts`

**Interfaces:**
- Consumes: identity REST API from Task 4.
- Produces: `useOperatorStore`, `canManageUsers()`, `canWithdrawPublished()`, and API session header injection.

- [ ] **Step 1: Add frontend identity types and failing pure tests**

```typescript
export type LocalUserRole = "admin" | "publisher";
export interface LocalUser { id: string; displayName: string; role: LocalUserRole; isActive: boolean; createdAt: string; updatedAt: string }
export interface LocalSession { token: string; user: LocalUser }
```

```typescript
test("admin-only permissions stay server-aligned", () => {
  assert.equal(canManageUsers(admin), true);
  assert.equal(canManageUsers(publisher), false);
  assert.equal(canWithdrawPublished(admin), true);
  assert.equal(canWithdrawPublished(publisher), false);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test renderer/src/utils/localUsers.test.ts`

Expected: FAIL because helpers/types do not exist.

- [ ] **Step 3: Add `ApiClient` session support**

```typescript
class ApiClient {
  private localSessionToken: string | null = null;

  setLocalSession(token: string | null) {
    this.localSessionToken = token;
  }
}
```

Install an Axios request interceptor once in `initialize()`:

```typescript
this.client.interceptors.request.use((request) => {
  if (this.localSessionToken) request.headers.set("X-Local-Session", this.localSessionToken);
  return request;
});
```

Add typed methods `getLocalUsers`, `bootstrapLocalAdmin`, `recoverLocalIdentity`, `openLocalSession`, `closeLocalSession`, `createLocalUser`, `updateLocalUser`, and `resetLocalUserPin`.

- [ ] **Step 4: Implement the operator Zustand store**

```typescript
type OperatorState = {
  users: LocalUser[];
  currentUser: LocalUser | null;
  token: string | null;
  needsBootstrap: boolean;
  initialized: boolean;
  initialize(): Promise<void>;
  bootstrap(displayName: string, pin: string): Promise<void>;
  switchUser(userId: string, pin?: string): Promise<void>;
  signOut(): Promise<void>;
  refreshUsers(): Promise<void>;
};
```

Persist only the last publisher `userId` in `localStorage`. On initialize, automatically open a fresh publisher session if that active profile still exists. Never persist an admin token or automatically reopen an admin session.

`switchUser()` first opens the replacement session. Because the backend permits only one current session, a successful response invalidates the previous token; a failed PIN attempt preserves the current token and current-user UI.

- [ ] **Step 5: Run tests and renderer build**

Run: `node --import tsx --test renderer/src/utils/localUsers.test.ts && npm run build:renderer`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/types/index.ts renderer/src/services/api.ts renderer/src/store/operator.ts renderer/src/utils/localUsers.ts renderer/src/utils/localUsers.test.ts
git commit -m "feat: add local operator client state"
```

---

### Task 6: 首次管理员初始化与顶部操作者切换

**Files:**
- Create: `renderer/src/components/LocalUserSetup.tsx`
- Create: `renderer/src/components/OperatorSwitcher.tsx`
- Modify: `renderer/src/App.tsx`

**Interfaces:**
- Consumes: `useOperatorStore` from Task 5.
- Produces: a global identity bootstrap/switch experience without blocking read-only creative pages after setup.

- [ ] **Step 1: Add pure form validation cases**

Extend `renderer/src/utils/localUsers.test.ts`:

```typescript
test("validateAdminSetup requires a name, matching 6-12 digit pins", () => {
  assert.deepEqual(validateAdminSetup("", "123456", "123456"), { displayName: "请输入管理员姓名" });
  assert.deepEqual(validateAdminSetup("主管", "123", "123"), { pin: "PIN 必须为 6 至 12 位数字" });
  assert.deepEqual(validateAdminSetup("主管", "123456", "654321"), { confirmation: "两次 PIN 不一致" });
  assert.equal(validateAdminSetup("主管", "123456", "123456"), null);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --import tsx --test renderer/src/utils/localUsers.test.ts`

Expected: FAIL because `validateAdminSetup()` does not exist.

- [ ] **Step 3: Build `LocalUserSetup`**

The component must render:

```tsx
<form onSubmit={handleBootstrap}>
  <input aria-label="管理员姓名" autoComplete="name" />
  <input aria-label="管理员 PIN" type="password" inputMode="numeric" autoComplete="new-password" />
  <input aria-label="确认 PIN" type="password" inputMode="numeric" autoComplete="new-password" />
  <button type="submit">创建本地管理员</button>
</form>
```

Show the local-workflow boundary in concise text. Do not show the app navigation behind an uninitialized identity form. Add a collapsed recovery form that requires exact confirmation text `重置本地用户`, a new admin name, and a new PIN.

- [ ] **Step 4: Build `OperatorSwitcher` and integrate `App`**

- Display current name and role in the header.
- Selecting an active publisher immediately calls `switchUser(id)`.
- Selecting an admin opens a modal with one PIN field; submit calls `switchUser(id, pin)`.
- Incorrect PIN stays in the modal with `local_user_pin_invalid` message.
- Signing out clears the token but keeps creative pages readable.
- `App` calls `initialize()` once and shows a compact loading surface until identity state is known.
- When `needsBootstrap` is true, render `LocalUserSetup`; otherwise render normal navigation plus `OperatorSwitcher`.

- [ ] **Step 5: Build and manually inspect both paths**

Run: `npm run build:renderer`

Expected: PASS.

Manual: temporarily use an empty storage directory, verify bootstrap; add a publisher via API fixture, verify direct switch; verify admin switch requires PIN and admin token disappears after sign-out.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/LocalUserSetup.tsx renderer/src/components/OperatorSwitcher.tsx renderer/src/App.tsx renderer/src/utils/localUsers.ts renderer/src/utils/localUsers.test.ts
git commit -m "feat: add local operator switching"
```

---

### Task 7: 设置页用户管理

**Files:**
- Create: `renderer/src/components/LocalUsersSettings.tsx`
- Modify: `renderer/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: identity API and operator role helpers.
- Produces: admin user CRUD, PIN reset, last-admin feedback, and publisher read-only view.

- [ ] **Step 1: Add settings-section metadata test**

Move settings section metadata into an exported pure array and test:

```typescript
test("settings includes local users without changing existing sections", () => {
  assert.deepEqual(settingsSections.map((item) => item.id), [
    "models", "douyin", "asr", "storage", "users", "advanced"
  ]);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test renderer/src/utils/localUsers.test.ts`

Expected: FAIL until the settings metadata/helper is exported.

- [ ] **Step 3: Implement `LocalUsersSettings`**

Required states and controls:

- Publisher: list active/inactive users, role labels and current-user marker; no management buttons.
- Admin: “新建用户” form with name, role, and conditional admin PIN.
- Row actions: rename, enable/disable, change role, reset admin PIN. Promoting a publisher opens a required new-PIN field; demoting an administrator requires confirmation and removes the PIN.
- Disable/demote last admin: show backend message inline; do not optimistically mutate the row.
- Current admin cannot disable their own profile while its session is active.
- Recovery is not shown during a valid admin session; it remains in `LocalUserSetup` only.

Use standard icons (`UserPlus`, `ShieldCheck`, `KeyRound`, `UserX`) and confirm dialogs for disable/role changes. Never render stored PIN information.

- [ ] **Step 4: Wire the section into SettingsPage**

Add `users` to `SettingsSection`, add the navigation item after Storage, and render:

```tsx
{activeSection === "users" && <LocalUsersSettings />}
```

Keep the existing models, Douyin, ASR, storage, and advanced sections unchanged.

- [ ] **Step 5: Run renderer and full type builds**

Run: `npm run build:renderer && npm run build:electron && npm run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/LocalUsersSettings.tsx renderer/src/pages/SettingsPage.tsx renderer/src/utils/localUsers.ts renderer/src/utils/localUsers.test.ts
git commit -m "feat: manage local app users"
```

---

### Task 8: 身份阶段文档与完整验证

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: independently releasable local identity foundation for the publishing plan.

- [ ] **Step 1: Document the local role model**

Add a “本地用户与权限” section covering:

```text
发布者无需 PIN，可创建和维护未发布内容。
管理员切换需要 6-12 位数字 PIN，拥有用户管理、发布撤回和发布包清理权限。
本地角色用于工作流和审计，不是云端账号或强安全边界。
遗忘唯一管理员 PIN 时使用“重置本地用户”，发布数据和历史操作者快照不会删除。
```

- [ ] **Step 2: Run all automated gates**

Run:

```bash
npm run check
npm test
npm run build:backend
npm run build:renderer
npm run build:electron
```

Expected: all commands PASS. Existing video, collection, API key, ASR and HyperFrames tests remain green.

- [ ] **Step 3: Run Electron acceptance flow**

Run: `npm run dev`

Verify in a temporary storage path:

1. Empty storage displays administrator setup.
2. Invalid PIN formats are rejected without writing a user.
3. Admin can create a publisher and another admin.
4. Publisher switches without PIN; admin requires correct PIN.
5. Publisher sees user management read-only and receives 403 from direct admin API calls.
6. Last active admin cannot be disabled or demoted.
7. Sign-out or app restart invalidates admin session.
8. Identity recovery replaces profiles but leaves a seeded `publishing-index.json` unchanged.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain local publishing roles"
```

---

## Completion Gate

Do not start the publishing-center plan until all of the following are true:

- `AC-084` through `AC-094` pass with automated evidence.
- Server-side 401/403 behavior is verified, not inferred from hidden buttons.
- No persisted file or API response contains plaintext PIN, salt, hash, or admin session token.
- Identity recovery preserves unrelated publishing data.
- Full project tests and all three builds pass.
