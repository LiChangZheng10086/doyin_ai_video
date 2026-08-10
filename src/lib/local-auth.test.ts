import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { test } from "node:test";
import { getActor, LocalAuthError, LocalSessionStore, requireActor } from "./local-auth.js";
import { LocalUserStore } from "./local-users.js";
import { LocalStorage } from "./storage.js";
import type { ActorSnapshot } from "../types.js";

const ADMIN: ActorSnapshot = {
  userId: "admin",
  displayName: "管理员",
  role: "admin",
};

async function userFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "local-auth-"));
  const users = new LocalUserStore(new LocalStorage(root));
  await users.init();
  const admin = await users.bootstrap({ displayName: "管理员", pin: "123456" });
  const publisher = await users.create(ADMIN, { displayName: "发布者", role: "publisher" });
  return { users, admin, publisher };
}

async function sessionFixture() {
  const fixture = await userFixture();
  let nextToken = 0;
  return { ...fixture, sessions: new LocalSessionStore(fixture.users, () => `token-${++nextToken}`) };
}

async function authHttpFixture() {
  const { users, publisher, admin } = await userFixture();
  let nextToken = 0;
  const sessions = new LocalSessionStore(users, () => `token-${++nextToken}`);
  const publisherToken = (await sessions.open({ userId: publisher.id })).token;
  const app = express();
  app.use(express.json());
  app.post("/publisher", requireActor(sessions, ["publisher"]), (req, res) => {
    res.json({ actor: getActor(req) });
  });
  app.post("/admin", requireActor(sessions, ["admin"]), (_req, res) => {
    res.json({ ok: true });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof LocalAuthError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ message: "unexpected" });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    users,
    sessions,
    publisher,
    admin,
    publisherToken,
    request(method: string, pathname: string, token?: string, body?: unknown) {
      return fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Local-Session": token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("publisher session opens without pin and admin requires a valid pin", async () => {
  const { users, publisher, admin } = await userFixture();
  const sessions = new LocalSessionStore(users, () => "token-1");

  assert.equal((await sessions.open({ userId: publisher.id })).token, "token-1");
  await assert.rejects(() => sessions.open({ userId: admin.id }), /管理员 PIN/);
  await assert.rejects(() => sessions.open({ userId: admin.id, pin: "000000" }), /PIN 不正确/);
});

test("a failed switch preserves the current session", async () => {
  const { sessions, publisher, admin } = await sessionFixture();
  const publisherSession = await sessions.open({ userId: publisher.id });

  await assert.rejects(() => sessions.open({ userId: admin.id, pin: "000000" }), /PIN 不正确/);
  assert.equal((await sessions.resolve(publisherSession.token))?.id, publisher.id);
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

test("clearAll invalidates the one current session", async () => {
  const { sessions, publisher } = await sessionFixture();
  const session = await sessions.open({ userId: publisher.id });

  sessions.clearAll();

  assert.equal(await sessions.resolve(session.token), null);
});

test("requireActor enforces session and role", async () => {
  const { publisher, publisherToken, request, close } = await authHttpFixture();
  try {
    const missing = await request("POST", "/publisher");
    assert.equal(missing.status, 401);
    assert.equal((await missing.json() as { code: string }).code, "local_session_required");

    const publisherResponse = await request("POST", "/publisher", publisherToken, {
      actor: { userId: "forged", displayName: "伪造管理员", role: "admin" },
    });
    assert.equal(publisherResponse.status, 200);
    assert.deepEqual((await publisherResponse.json() as { actor: ActorSnapshot }).actor, {
      userId: publisher.id,
      displayName: publisher.displayName,
      role: "publisher",
    });

    const denied = await request("POST", "/admin", publisherToken);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { code: string }).code, "local_role_forbidden");
  } finally {
    await close();
  }
});

test("requireActor resolves the active user on every request", async () => {
  const { users, publisher, publisherToken, request, close } = await authHttpFixture();
  try {
    await users.update(ADMIN, publisher.id, { isActive: false });

    const response = await request("POST", "/publisher", publisherToken);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, "local_session_required");
  } finally {
    await close();
  }
});

test("getActor exposes a stable missing-session error", () => {
  assert.throws(
    () => getActor({} as express.Request),
    (error: LocalAuthError) => error.code === "local_session_required"
      && error.status === 401
      && error.message === "请选择当前操作者"
  );
});
