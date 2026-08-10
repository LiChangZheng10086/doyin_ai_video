import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalUserError, LocalUserStore } from "./local-users.js";
import { LocalStorage } from "./storage.js";
import type { ActorSnapshot, LocalUserView } from "../types.js";

type StoredLocalUser = LocalUserView & { pinSalt?: string; pinHash?: string };
type LocalUsersIndex = { schemaVersion: 1; users: Record<string, StoredLocalUser> };

const ADMIN: ActorSnapshot = {
  userId: "admin",
  displayName: "管理员",
  role: "admin",
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "local-users-"));
  const storage = new LocalStorage(root);
  const store = new LocalUserStore(storage);
  await store.init();
  return { root, storage, store };
}

async function adminFixture() {
  const result = await fixture();
  const admin = await result.store.bootstrap({ displayName: "管理员", pin: "123456" });
  return {
    ...result,
    admin,
    async readIndexBytes() {
      return readFile(path.join(result.root, "cache", "local-users.json"));
    },
    async readPublishingBytes() {
      return readFile(path.join(result.root, "cache", "publishing-index.json"));
    },
  };
}

test("LocalUserError keeps stable codes with safe Simplified Chinese messages", () => {
  const invalidPin = new LocalUserError("local_user_pin_invalid");
  const forbidden = new LocalUserError("local_user_forbidden");

  assert.equal(invalidPin.code, "local_user_pin_invalid");
  assert.equal(invalidPin.message, "PIN 必须为 6 到 12 位数字");
  assert.equal(forbidden.code, "local_user_forbidden");
  assert.equal(forbidden.message, "仅管理员可以执行此操作");
});

test("bootstrap creates the first admin without persisting plaintext pin", async () => {
  const { store, storage } = await fixture();
  const admin = await store.bootstrap({ displayName: "管理员", pin: "123456" });

  assert.equal(admin.role, "admin");
  assert.equal(await store.verifyPin(admin.id, "123456"), true);
  const stored = await storage.readJson<LocalUsersIndex>("cache/local-users.json");
  const raw = JSON.stringify(stored);
  assert.doesNotMatch(raw, /123456/);
  assert.ok(stored.users[admin.id].pinSalt);
  assert.ok(stored.users[admin.id].pinHash);
  assert.equal("pinHash" in (await store.list())[0], false);
});

test("created user profiles have unique ids and complete timestamped fields", async () => {
  const { store } = await adminFixture();
  const firstPublisher = await store.create(ADMIN, { displayName: "发布者一", role: "publisher" });
  const secondPublisher = await store.create(ADMIN, { displayName: "发布者二", role: "publisher" });
  const users = await store.list();

  assert.equal(new Set(users.map((user) => user.id)).size, users.length);
  assert.notEqual(firstPublisher.id, secondPublisher.id);
  for (const user of users) {
    assert.equal(typeof user.id, "string");
    assert.notEqual(user.id, "");
    assert.equal(typeof user.displayName, "string");
    assert.ok(user.role === "admin" || user.role === "publisher");
    assert.equal(typeof user.isActive, "boolean");
    assert.match(user.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(user.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(user.createdAt).toISOString(), user.createdAt);
    assert.equal(new Date(user.updatedAt).toISOString(), user.updatedAt);
  }
});

test("rejects invalid pins and a second bootstrap", async () => {
  const { store } = await fixture();

  await assert.rejects(
    () => store.bootstrap({ displayName: "管理员", pin: "123" }),
    (error: LocalUserError) => error.code === "local_user_pin_invalid"
  );
  await store.bootstrap({ displayName: "管理员", pin: "123456" });
  await assert.rejects(
    () => store.bootstrap({ displayName: "管理员二", pin: "654321" }),
    (error: LocalUserError) => error.code === "local_users_already_initialized"
  );
});

test("publisher records cannot contain a pin", async () => {
  const { store, storage } = await adminFixture();

  await assert.rejects(
    () => store.create(ADMIN, { displayName: "发布者", role: "publisher", pin: "123456" }),
    (error: LocalUserError) => error.code === "local_user_publisher_pin_forbidden"
  );
  const publisher = await store.create(ADMIN, { displayName: "发布者", role: "publisher" });
  const stored = await storage.readJson<LocalUsersIndex>("cache/local-users.json");
  assert.equal(stored.users[publisher.id].pinSalt, undefined);
  assert.equal(stored.users[publisher.id].pinHash, undefined);
});

test("only administrators can create users", async () => {
  const { store } = await adminFixture();
  const publisher: ActorSnapshot = { userId: "publisher", displayName: "发布者", role: "publisher" };

  await assert.rejects(
    () => store.create(publisher, { displayName: "另一位发布者", role: "publisher" }),
    (error: LocalUserError) => error.code === "local_user_forbidden"
  );
});

test("keeps the last active administrator", async () => {
  const { store, readIndexBytes, admin } = await adminFixture();
  const before = await readIndexBytes();

  await assert.rejects(
    () => store.update(ADMIN, admin.id, { isActive: false }),
    (error: LocalUserError) => error.code === "local_user_last_admin"
  );
  assert.deepEqual(await readIndexBytes(), before);
});

test("publisher promotion requires a new valid pin", async () => {
  const { store } = await adminFixture();
  const publisher = await store.create(ADMIN, { displayName: "发布者", role: "publisher" });

  await assert.rejects(
    () => store.update(ADMIN, publisher.id, { role: "admin" }),
    (error: LocalUserError) => error.code === "local_user_admin_pin_required"
  );
  await assert.rejects(
    () => store.update(ADMIN, publisher.id, { role: "admin", pin: "123" }),
    (error: LocalUserError) => error.code === "local_user_pin_invalid"
  );

  const promoted = await store.update(ADMIN, publisher.id, { role: "admin", pin: "654321" });
  assert.equal(promoted.role, "admin");
  assert.equal(await store.verifyPin(promoted.id, "654321"), true);
});

test("administrator demotion removes credentials", async () => {
  const { store, storage } = await adminFixture();
  const secondAdmin = await store.create(ADMIN, { displayName: "第二管理员", role: "admin", pin: "654321" });

  const publisher = await store.update(ADMIN, secondAdmin.id, { role: "publisher" });
  const stored = await storage.readJson<LocalUsersIndex>("cache/local-users.json");
  assert.equal(publisher.role, "publisher");
  assert.equal(stored.users[secondAdmin.id].pinSalt, undefined);
  assert.equal(stored.users[secondAdmin.id].pinHash, undefined);
  assert.equal(await store.verifyPin(secondAdmin.id, "654321"), false);
});

test("publisher updates reject pins", async () => {
  const { store } = await adminFixture();
  const publisher = await store.create(ADMIN, { displayName: "发布者", role: "publisher" });

  await assert.rejects(
    () => store.update(ADMIN, publisher.id, { displayName: "新发布者", pin: "654321" }),
    (error: LocalUserError) => error.code === "local_user_publisher_pin_forbidden"
  );
});

test("resetting an administrator pin changes its verification result", async () => {
  const { store } = await adminFixture();
  const secondAdmin = await store.create(ADMIN, { displayName: "第二管理员", role: "admin", pin: "654321" });

  await store.resetPin(ADMIN, secondAdmin.id, "111111");
  assert.equal(await store.verifyPin(secondAdmin.id, "654321"), false);
  assert.equal(await store.verifyPin(secondAdmin.id, "111111"), true);
});

test("concurrent user mutations retain each created user", async () => {
  const { store } = await adminFixture();

  const users = await Promise.all([
    store.create(ADMIN, { displayName: "发布者一", role: "publisher" }),
    store.create(ADMIN, { displayName: "发布者二", role: "publisher" }),
  ]);
  const ids = new Set((await store.list()).map((user) => user.id));
  assert.ok(users.every((user) => ids.has(user.id)));
  assert.equal(ids.size, 3);
});

test("recovery leaves publishing data byte-for-byte unchanged", async () => {
  const { store, storage, readPublishingBytes } = await adminFixture();
  const originalActor: ActorSnapshot = {
    userId: "publisher-original",
    displayName: "原发布者",
    role: "publisher",
  };
  await storage.writeJsonAtomic("cache/publishing-index.json", {
    schemaVersion: 1,
    packages: {
      "package-1": {
        id: "package-1",
        audit: [{
          id: "audit-1",
          action: "created",
          actor: originalActor,
          createdAt: "2026-08-09T12:00:00.000Z",
        }],
      },
    },
  });
  const before = await readPublishingBytes();

  const admin = await store.recover({ confirmation: "重置本地用户", displayName: "新管理员", pin: "654321" });
  assert.equal(admin.role, "admin");
  assert.deepEqual(await readPublishingBytes(), before);
});

test("recovery requires its exact confirmation and a valid pin", async () => {
  const { store } = await adminFixture();

  await assert.rejects(
    () => store.recover({ confirmation: "重置", displayName: "新管理员", pin: "654321" }),
    (error: LocalUserError) => error.code === "local_user_recovery_confirmation_invalid"
  );
  await assert.rejects(
    () => store.recover({ confirmation: "重置本地用户", displayName: "新管理员", pin: "123" }),
    (error: LocalUserError) => error.code === "local_user_pin_invalid"
  );
});

test("getActive excludes inactive users", async () => {
  const { store } = await adminFixture();
  const publisher = await store.create(ADMIN, { displayName: "发布者", role: "publisher" });
  await store.update(ADMIN, publisher.id, { isActive: false });

  assert.equal(await store.getActive(publisher.id), null);
});
