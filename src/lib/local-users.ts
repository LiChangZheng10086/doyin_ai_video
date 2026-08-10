import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { ActorSnapshot, LocalUserRole, LocalUserView } from "../types.js";
import { LocalStorage } from "./storage.js";

const USERS_INDEX = "cache/local-users.json";
const RECOVERY_CONFIRMATION = "重置本地用户";
const PIN_PATTERN = /^\d{6,12}$/;
const scryptAsync = promisify(scrypt);

type StoredLocalUser = LocalUserView & { pinSalt?: string; pinHash?: string };
type LocalUsersIndex = { schemaVersion: 1; users: Record<string, StoredLocalUser> };

type LocalUserErrorCode =
  | "local_user_admin_pin_required"
  | "local_user_forbidden"
  | "local_user_last_admin"
  | "local_user_not_found"
  | "local_user_pin_invalid"
  | "local_user_publisher_pin_forbidden"
  | "local_user_recovery_confirmation_invalid"
  | "local_users_already_initialized";

export const SYSTEM_ACTOR: ActorSnapshot = {
  userId: "system",
  displayName: "系统",
  role: "system",
};

export class LocalUserError extends Error {
  constructor(readonly code: LocalUserErrorCode) {
    super(code);
    this.name = "LocalUserError";
  }
}

export class LocalUserStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: LocalStorage) {}

  async init(): Promise<void> {
    await this.mutate(async () => {
      try {
        await this.readIndex();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.writeIndex(this.emptyIndex());
      }
    });
  }

  async list(): Promise<LocalUserView[]> {
    const index = await this.readIndex();
    return Object.values(index.users).map(toView);
  }

  async hasUsers(): Promise<boolean> {
    const index = await this.readIndex();
    return Object.keys(index.users).length > 0;
  }

  async bootstrap(input: { displayName: string; pin: string }): Promise<LocalUserView> {
    return this.mutate(async () => {
      const index = await this.readIndex();
      if (Object.keys(index.users).length > 0) {
        throw new LocalUserError("local_users_already_initialized");
      }
      validatePin(input.pin);

      const user = await this.newUser(input.displayName, "admin", input.pin);
      index.users[user.id] = user;
      await this.writeIndex(index);
      return toView(user);
    });
  }

  async create(
    actor: ActorSnapshot,
    input: { displayName: string; role: LocalUserRole; pin?: string }
  ): Promise<LocalUserView> {
    return this.mutate(async () => {
      requireAdmin(actor);
      if (input.role === "publisher" && input.pin !== undefined) {
        throw new LocalUserError("local_user_publisher_pin_forbidden");
      }
      if (input.role === "admin") {
        if (input.pin === undefined) throw new LocalUserError("local_user_admin_pin_required");
        validatePin(input.pin);
      }

      const index = await this.readIndex();
      const user = await this.newUser(input.displayName, input.role, input.pin);
      index.users[user.id] = user;
      await this.writeIndex(index);
      return toView(user);
    });
  }

  async update(
    actor: ActorSnapshot,
    id: string,
    changes: { displayName?: string; role?: LocalUserRole; isActive?: boolean; pin?: string }
  ): Promise<LocalUserView> {
    return this.mutate(async () => {
      requireAdmin(actor);
      const index = await this.readIndex();
      const existing = index.users[id];
      if (!existing) throw new LocalUserError("local_user_not_found");

      const role = changes.role ?? existing.role;
      if (role === "publisher" && changes.pin !== undefined) {
        throw new LocalUserError("local_user_publisher_pin_forbidden");
      }
      if (existing.role === "publisher" && role === "admin" && changes.pin === undefined) {
        throw new LocalUserError("local_user_admin_pin_required");
      }
      if (role === "admin" && changes.pin !== undefined) validatePin(changes.pin);

      const removesActiveAdmin = existing.role === "admin"
        && existing.isActive
        && (role !== "admin" || changes.isActive === false);
      if (removesActiveAdmin && this.activeAdminCount(index) === 1) {
        throw new LocalUserError("local_user_last_admin");
      }

      const updated: StoredLocalUser = {
        id: existing.id,
        displayName: changes.displayName ?? existing.displayName,
        role,
        isActive: changes.isActive ?? existing.isActive,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      if (role === "admin") {
        if (changes.pin !== undefined) {
          Object.assign(updated, await credentialsFor(changes.pin));
        } else {
          updated.pinSalt = existing.pinSalt;
          updated.pinHash = existing.pinHash;
        }
      }

      index.users[id] = updated;
      await this.writeIndex(index);
      return toView(updated);
    });
  }

  async resetPin(actor: ActorSnapshot, id: string, pin: string): Promise<void> {
    await this.mutate(async () => {
      requireAdmin(actor);
      const index = await this.readIndex();
      const user = index.users[id];
      if (!user) throw new LocalUserError("local_user_not_found");
      if (user.role !== "admin") throw new LocalUserError("local_user_admin_pin_required");
      validatePin(pin);

      Object.assign(user, await credentialsFor(pin), { updatedAt: new Date().toISOString() });
      await this.writeIndex(index);
    });
  }

  async verifyPin(id: string, pin: string): Promise<boolean> {
    const user = (await this.readIndex()).users[id];
    if (user?.role !== "admin" || !user.pinSalt || !user.pinHash) return false;

    const expected = Buffer.from(user.pinHash, "base64url");
    const actual = await hashPin(pin, user.pinSalt);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async recover(input: { confirmation: string; displayName: string; pin: string }): Promise<LocalUserView> {
    return this.mutate(async () => {
      if (input.confirmation !== RECOVERY_CONFIRMATION) {
        throw new LocalUserError("local_user_recovery_confirmation_invalid");
      }
      validatePin(input.pin);

      const user = await this.newUser(input.displayName, "admin", input.pin);
      const index = this.emptyIndex();
      index.users[user.id] = user;
      await this.writeIndex(index);
      return toView(user);
    });
  }

  async getActive(id: string): Promise<LocalUserView | null> {
    const user = (await this.readIndex()).users[id];
    return user?.isActive ? toView(user) : null;
  }

  private async newUser(displayName: string, role: LocalUserRole, pin?: string): Promise<StoredLocalUser> {
    const now = new Date().toISOString();
    const user: StoredLocalUser = {
      id: randomUUID(),
      displayName,
      role,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    if (role === "admin" && pin !== undefined) Object.assign(user, await credentialsFor(pin));
    return user;
  }

  private activeAdminCount(index: LocalUsersIndex): number {
    return Object.values(index.users).filter((user) => user.role === "admin" && user.isActive).length;
  }

  private emptyIndex(): LocalUsersIndex {
    return { schemaVersion: 1, users: {} };
  }

  private async readIndex(): Promise<LocalUsersIndex> {
    return this.storage.readJson<LocalUsersIndex>(USERS_INDEX);
  }

  private async writeIndex(index: LocalUsersIndex): Promise<void> {
    await this.storage.writeJsonAtomic(USERS_INDEX, index);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function requireAdmin(actor: ActorSnapshot): void {
  if (actor.role !== "admin") throw new LocalUserError("local_user_forbidden");
}

function validatePin(pin: string): void {
  if (!PIN_PATTERN.test(pin)) throw new LocalUserError("local_user_pin_invalid");
}

async function credentialsFor(pin: string): Promise<{ pinSalt: string; pinHash: string }> {
  const pinSalt = randomBytes(16).toString("base64url");
  const pinHash = (await hashPin(pin, pinSalt)).toString("base64url");
  return { pinSalt, pinHash };
}

async function hashPin(pin: string, salt: string): Promise<Buffer> {
  return Buffer.from((await scryptAsync(pin, salt, 64)) as Buffer);
}

function toView(user: StoredLocalUser): LocalUserView {
  const { pinSalt: _pinSalt, pinHash: _pinHash, ...view } = user;
  return view;
}
