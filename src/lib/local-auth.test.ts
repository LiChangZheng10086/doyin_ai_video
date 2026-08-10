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
import type { ActorSnapshot, LocalUserView } from "../types.js";

const ADMIN: ActorSnapshot = {
  userId: "admin",
  displayName: "管理员",
  role: "admin",
};

type Gate = {
  started: Promise<void>;
  markStarted: () => void;
  release: () => void;
  released: Promise<void>;
};

class GatedLocalUserStore {
  private nextGetActiveGate?: Gate;

  constructor(private readonly activeUsers: Map<string, LocalUserView>) {}

  blockNextGetActive(): Gate {
    let start!: () => void;
    let release!: () => void;
    const gate = {
      started: new Promise<void>((resolve) => { start = resolve; }),
      markStarted: () => start(),
      release: () => release(),
      released: new Promise<void>((resolve) => { release = resolve; }),
    };
    this.nextGetActiveGate = gate;
    return gate;
  }

  async getActive(id: string): Promise<LocalUserView | null> {
    const gate = this.nextGetActiveGate;
    if (gate) {
      this.nextGetActiveGate = undefined;
      gate.markStarted();
      await gate.released;
    }
    return this.activeUsers.get(id) ?? null;
  }

  async verifyPin(): Promise<boolean> {
    return true;
  }
}

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

function publisher(id: string, displayName: string): LocalUserView {
  return {
    id,
    displayName,
    role: "publisher",
    isActive: true,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
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

test("resolve returns null when close invalidates its captured session during user lookup", async () => {
  const activePublisher = publisher("publisher-1", "发布者一");
  const users = new GatedLocalUserStore(new Map([[activePublisher.id, activePublisher]]));
  let nextToken = 0;
  const sessions = new LocalSessionStore(users as unknown as LocalUserStore, () => `token-${++nextToken}`);
  const session = await sessions.open({ userId: activePublisher.id });
  const gate = users.blockNextGetActive();
  const resolving = sessions.resolve(session.token);

  await gate.started;
  sessions.close(session.token);
  gate.release();

  assert.equal(await resolving, null);
});

test("resolve returns null when a switch invalidates its captured session during user lookup", async () => {
  const firstPublisher = publisher("publisher-1", "发布者一");
  const replacementPublisher = publisher("publisher-2", "发布者二");
  const users = new GatedLocalUserStore(new Map([
    [firstPublisher.id, firstPublisher],
    [replacementPublisher.id, replacementPublisher],
  ]));
  let nextToken = 0;
  const sessions = new LocalSessionStore(users as unknown as LocalUserStore, () => `token-${++nextToken}`);
  const firstSession = await sessions.open({ userId: firstPublisher.id });
  const gate = users.blockNextGetActive();
  const resolving = sessions.resolve(firstSession.token);

  await gate.started;
  const replacementSession = await sessions.open({ userId: replacementPublisher.id });
  gate.release();

  assert.equal(await resolving, null);
  assert.equal((await sessions.resolve(replacementSession.token))?.id, replacementPublisher.id);
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
