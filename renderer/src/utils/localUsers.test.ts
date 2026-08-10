import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperatorStore, type LocalIdentityClient } from "../store/operator.js";
import type { LocalSession, LocalUser } from "../types/index.js";
import { canManageUsers, canWithdrawPublished } from "./localUsers.js";

const admin: LocalUser = {
  id: "admin-1",
  displayName: "管理员",
  role: "admin",
  isActive: true,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const publisher: LocalUser = {
  id: "publisher-1",
  displayName: "发布员",
  role: "publisher",
  isActive: true,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const publisherSession: LocalSession = { token: "publisher-token", user: publisher };

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function identityClient(overrides: Partial<LocalIdentityClient> = {}): LocalIdentityClient {
  return {
    setLocalSession: () => undefined,
    getLocalUsers: async () => ({ users: [admin, publisher], needsBootstrap: false }),
    bootstrapLocalAdmin: async () => ({ user: admin, session: { token: "admin-token", user: admin } }),
    recoverLocalIdentity: async () => ({ user: admin, session: { token: "admin-token", user: admin } }),
    openLocalSession: async () => ({ session: publisherSession }),
    closeLocalSession: async () => undefined,
    createLocalUser: async () => ({ user: publisher }),
    updateLocalUser: async () => ({ user: publisher }),
    resetLocalUserPin: async () => undefined,
    ...overrides,
  };
}

test("admin-only permissions stay server-aligned", () => {
  assert.equal(canManageUsers(admin), true);
  assert.equal(canManageUsers(publisher), false);
  assert.equal(canWithdrawPublished(admin), true);
  assert.equal(canWithdrawPublished(publisher), false);
});

test("initialization auto-opens only the saved active publisher", async () => {
  const storage = memoryStorage({ "douyin-ai-video.last-publisher-id": publisher.id });
  const opened: string[] = [];
  const store = createOperatorStore(identityClient({
    openLocalSession: async (userId) => {
      opened.push(userId);
      return { session: publisherSession };
    },
  }), storage);

  await store.getState().initialize();

  assert.deepEqual(opened, [publisher.id]);
  assert.equal(store.getState().currentUser, publisher);
  assert.equal(store.getState().token, publisherSession.token);
});

test("initialization never reopens a saved admin session", async () => {
  const storage = memoryStorage({ "douyin-ai-video.last-publisher-id": admin.id });
  let opened = false;
  const store = createOperatorStore(identityClient({
    openLocalSession: async () => {
      opened = true;
      return { session: { token: "admin-token", user: admin } };
    },
  }), storage);

  await store.getState().initialize();

  assert.equal(opened, false);
  assert.equal(store.getState().currentUser, null);
  assert.equal(store.getState().token, null);
});

test("a failed PIN switch preserves the current session and user", async () => {
  const localSessionChanges: Array<string | null> = [];
  const store = createOperatorStore(identityClient({
    setLocalSession: (token) => localSessionChanges.push(token),
    openLocalSession: async () => { throw new Error("PIN 不正确"); },
  }), memoryStorage());
  await store.getState().bootstrap("管理员", "123456");
  const before = store.getState();

  await assert.rejects(() => store.getState().switchUser(publisher.id, "wrong"), /PIN 不正确/);

  assert.equal(store.getState().currentUser, before.currentUser);
  assert.equal(store.getState().token, before.token);
  assert.deepEqual(localSessionChanges, ["admin-token"]);
});

test("a successful switch replaces the session only after its response arrives", async () => {
  const localSessionChanges: Array<string | null> = [];
  let resolveSession: ((response: { session: LocalSession }) => void) | undefined;
  const pendingSession = new Promise<{ session: LocalSession }>((resolve) => {
    resolveSession = resolve;
  });
  const store = createOperatorStore(identityClient({
    setLocalSession: (token) => localSessionChanges.push(token),
    openLocalSession: async () => pendingSession,
  }), memoryStorage());
  await store.getState().bootstrap("管理员", "123456");

  const switching = store.getState().switchUser(publisher.id);
  assert.equal(store.getState().currentUser, admin);
  assert.equal(store.getState().token, "admin-token");

  resolveSession!({ session: publisherSession });
  await switching;

  assert.equal(store.getState().currentUser, publisher);
  assert.equal(store.getState().token, publisherSession.token);
  assert.deepEqual(localSessionChanges, ["admin-token", publisherSession.token]);
});

test("sign-out clears local session state when the server close fails", async () => {
  const storage = memoryStorage();
  const localSessionChanges: Array<string | null> = [];
  const store = createOperatorStore(identityClient({
    setLocalSession: (token) => localSessionChanges.push(token),
    closeLocalSession: async () => { throw new Error("offline"); },
  }), storage);
  await store.getState().switchUser(publisher.id);

  await store.getState().signOut();

  assert.equal(store.getState().currentUser, null);
  assert.equal(store.getState().token, null);
  assert.equal(storage.getItem("douyin-ai-video.last-publisher-id"), null);
  assert.deepEqual(localSessionChanges, [publisherSession.token, null]);
});
