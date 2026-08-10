import { Router, type Express, type NextFunction, type Request, type Response } from "express";
import { getActor, LocalAuthError, LocalSessionStore, requireActor } from "./local-auth.js";
import { LocalUserError, LocalUserStore } from "./local-users.js";
import type { LocalUserRole } from "../types.js";

type LocalUserRouteDeps = {
  users: LocalUserStore;
  sessions: LocalSessionStore;
};

class LocalUserRouteError extends Error {
  constructor() {
    super("请求参数无效");
    this.name = "LocalUserRouteError";
  }
}

export function registerLocalUserRoutes(app: Express, deps: LocalUserRouteDeps): void {
  const router = Router();

  router.get("/local-users", async (_req, res, next) => {
    try {
      const users = await deps.users.list();
      res.json({ users, needsBootstrap: users.length === 0 });
    } catch (error) {
      next(error);
    }
  });

  router.post("/local-users/bootstrap", async (req, res, next) => {
    try {
      const input = bootstrapInput(req);
      const user = await deps.users.bootstrap(input);
      const session = await deps.sessions.open({ userId: user.id, pin: input.pin });
      res.status(201).json({ user, session });
    } catch (error) {
      next(error);
    }
  });

  router.post("/local-users/recover", async (req, res, next) => {
    try {
      const input = recoveryInput(req);
      const user = await deps.users.recover(input);
      deps.sessions.clearAll();
      const session = await deps.sessions.open({ userId: user.id, pin: input.pin });
      res.status(201).json({ user, session });
    } catch (error) {
      next(error);
    }
  });

  router.post("/local-users", requireActor(deps.sessions, ["admin"]), async (req, res, next) => {
    try {
      const user = await deps.users.create(getActor(req), createInput(req));
      res.status(201).json({ user });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/local-users/:id", requireActor(deps.sessions, ["admin"]), async (req, res, next) => {
    try {
      const user = await deps.users.update(getActor(req), requiredString(req.params.id), updateInput(req));
      res.json({ user });
    } catch (error) {
      next(error);
    }
  });

  router.post("/local-users/:id/reset-pin", requireActor(deps.sessions, ["admin"]), async (req, res, next) => {
    try {
      await deps.users.resetPin(getActor(req), requiredString(req.params.id), requiredString(body(req).pin));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/local-sessions", async (req, res, next) => {
    try {
      const input = body(req);
      const session = await deps.sessions.open({
        userId: requiredString(input.userId),
        pin: optionalString(input.pin),
      });
      res.status(201).json({ session });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/local-sessions/current", (req, res) => {
    deps.sessions.close(req.header("X-Local-Session") ?? undefined);
    res.status(204).end();
  });

  router.get("/local-sessions/current", requireActor(deps.sessions), async (req, res, next) => {
    try {
      const user = await deps.users.getActive(getActor(req).userId);
      if (!user) throw new LocalAuthError("local_session_required", 401, "请选择当前操作者");
      res.json({ user });
    } catch (error) {
      next(error);
    }
  });

  router.use(identityErrorMapper);
  app.use("/api", router);
}

function identityErrorMapper(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof LocalAuthError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof LocalUserError) {
    res.status(localUserErrorStatus(error)).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof LocalUserRouteError) {
    res.status(400).json({ code: "local_user_invalid_input", message: error.message });
    return;
  }
  next(error);
}

function localUserErrorStatus(error: LocalUserError): number {
  switch (error.code) {
    case "local_users_already_initialized":
    case "local_user_last_admin":
      return 409;
    case "local_user_not_found":
      return 404;
    case "local_user_forbidden":
      return 403;
    default:
      return 400;
  }
}

function bootstrapInput(req: Request): { displayName: string; pin: string } {
  const input = body(req);
  return { displayName: requiredString(input.displayName), pin: requiredString(input.pin) };
}

function recoveryInput(req: Request): { confirmation: string; displayName: string; pin: string } {
  const input = body(req);
  return {
    confirmation: requiredString(input.confirmation),
    displayName: requiredString(input.displayName),
    pin: requiredString(input.pin),
  };
}

function createInput(req: Request): { displayName: string; role: LocalUserRole; pin?: string } {
  const input = body(req);
  return {
    displayName: requiredString(input.displayName),
    role: userRole(input.role),
    pin: optionalString(input.pin),
  };
}

function updateInput(req: Request): { displayName?: string; role?: LocalUserRole; isActive?: boolean; pin?: string } {
  const input = body(req);
  return {
    displayName: optionalString(input.displayName),
    role: input.role === undefined ? undefined : userRole(input.role),
    isActive: input.isActive === undefined ? undefined : requiredBoolean(input.isActive),
    pin: optionalString(input.pin),
  };
}

function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new LocalUserRouteError();
  return req.body as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new LocalUserRouteError();
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value);
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new LocalUserRouteError();
  return value;
}

function userRole(value: unknown): LocalUserRole {
  if (value === "admin" || value === "publisher") return value;
  throw new LocalUserRouteError();
}
