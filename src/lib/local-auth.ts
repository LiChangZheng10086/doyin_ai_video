import { randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { ActorSnapshot, LocalSessionView, LocalUserRole, LocalUserView } from "../types.js";
import { LocalUserStore } from "./local-users.js";

type LocalAuthErrorCode =
  | "local_role_forbidden"
  | "local_session_required"
  | "local_user_not_found"
  | "local_user_pin_invalid";

export class LocalAuthError extends Error {
  constructor(
    readonly code: LocalAuthErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "LocalAuthError";
  }
}

export class LocalSessionStore {
  private readonly sessions = new Map<string, { userId: string; createdAt: string }>();

  constructor(
    private readonly users: LocalUserStore,
    private readonly createToken: () => string = () => randomBytes(32).toString("base64url")
  ) {}

  async open(input: { userId: string; pin?: string }): Promise<LocalSessionView> {
    const user = await this.users.getActive(input.userId);
    if (!user) {
      throw new LocalAuthError("local_user_not_found", 404, "未找到可用的本地用户");
    }
    if (user.role === "admin") {
      if (!input.pin) {
        throw new LocalAuthError("local_user_pin_invalid", 401, "管理员 PIN 为必填项");
      }
      if (!await this.users.verifyPin(user.id, input.pin)) {
        throw new LocalAuthError("local_user_pin_invalid", 401, "PIN 不正确");
      }
    }

    this.clearAll();
    const token = this.createToken();
    this.sessions.set(token, { userId: user.id, createdAt: new Date().toISOString() });
    return { token, user };
  }

  async resolve(token?: string): Promise<LocalUserView | null> {
    if (!token) return null;

    const session = this.sessions.get(token);
    if (!session) return null;

    const user = await this.users.getActive(session.userId);
    if (this.sessions.get(token) !== session) return null;
    if (!user) this.sessions.delete(token);
    return user;
  }

  close(token?: string): void {
    if (token) this.sessions.delete(token);
  }

  clearAll(): void {
    this.sessions.clear();
  }
}

export type AuthedRequest = Request & { localActor?: ActorSnapshot };

export function requireActor(
  sessions: LocalSessionStore,
  roles: LocalUserRole[] = ["admin", "publisher"]
): RequestHandler {
  return async (req, _res, next) => {
    try {
      const user = await sessions.resolve(req.header("X-Local-Session") ?? undefined);
      if (!user) {
        next(new LocalAuthError("local_session_required", 401, "请选择当前操作者"));
        return;
      }
      if (!roles.includes(user.role)) {
        next(new LocalAuthError("local_role_forbidden", 403, "当前操作者无权执行此操作"));
        return;
      }

      (req as AuthedRequest).localActor = {
        userId: user.id,
        displayName: user.displayName,
        role: user.role,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function getActor(req: Request): ActorSnapshot {
  const actor = (req as AuthedRequest).localActor;
  if (!actor) throw new LocalAuthError("local_session_required", 401, "请选择当前操作者");
  return actor;
}
