import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  ActorSnapshot,
  DeliveryPackage,
  DueNotification,
  PublishAuditEvent,
  PublishAssetHealth,
  PublishTask,
  PublishTaskStatus,
  PublishingIndex,
  PublishingListFilters,
  PublishingPackageDetail,
  PublishingTombstone,
} from "../types.js";
import { LocalStorage } from "./storage.js";
import { SYSTEM_ACTOR } from "./local-users.js";
import { PUBLISH_PLATFORMS } from "./publishing-platforms.js";

const PUBLISHING_INDEX = "cache/publishing-index.json";
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NO_WRITE = Symbol("publishing-no-write");

type NoWrite<T> = { readonly [NO_WRITE]: true; readonly result: T };

type PublishingCoordinator = {
  writeTail: Promise<void>;
  sourceLocks: Map<string, Promise<void>>;
  index?: PublishingIndex;
  initPromise?: Promise<void>;
  initialized: boolean;
  readOnlyError: PublishingError | null;
};

const COORDINATORS = new Map<string, PublishingCoordinator>();

type PublishingErrorCode =
  | "publish_asset_broken"
  | "publish_index_corrupt"
  | "publish_invalid_transition"
  | "publish_package_not_found"
  | "publish_permission_denied"
  | "publish_revision_conflict"
  | "publish_task_not_found"
  | "publish_validation_failed";

const ERROR_MESSAGES: Record<PublishingErrorCode, string> = {
  publish_asset_broken: "发布包视频资产异常，无法执行发布操作",
  publish_index_corrupt: "发布索引已损坏，当前处于只读保护状态",
  publish_invalid_transition: "当前发布状态不允许执行此操作",
  publish_package_not_found: "未找到发布包",
  publish_permission_denied: "当前操作者无权执行此操作",
  publish_revision_conflict: "发布内容已被修改，请刷新后重试",
  publish_task_not_found: "未找到发布任务",
  publish_validation_failed: "发布数据校验失败",
};

export class PublishingError extends Error {
  constructor(
    readonly code: PublishingErrorCode,
    readonly details?: Record<string, unknown>
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "PublishingError";
  }
}

export interface NewPackageRecord {
  package: DeliveryPackage;
  tasks: PublishTask[];
}

export interface RestorePackageResult {
  package: DeliveryPackage;
  notifications: DueNotification[];
}

export class PublishingStore {
  private readonly coordinator: PublishingCoordinator;

  constructor(
    private readonly storage: LocalStorage,
    private readonly now = () => new Date()
  ) {
    const indexPath = canonicalIndexPath(storage);
    let coordinator = COORDINATORS.get(indexPath);
    if (!coordinator) {
      coordinator = {
        writeTail: Promise.resolve(),
        sourceLocks: new Map(),
        initialized: false,
        readOnlyError: null,
      };
      COORDINATORS.set(indexPath, coordinator);
    }
    this.coordinator = coordinator;
  }

  async init(): Promise<void> {
    if (this.coordinator.initialized) return;
    if (!this.coordinator.initPromise) {
      this.coordinator.initPromise = this.initializeCoordinator();
    }
    const initPromise = this.coordinator.initPromise;
    try {
      await initPromise;
    } finally {
      if (!this.coordinator.initialized && this.coordinator.initPromise === initPromise) {
        this.coordinator.initPromise = undefined;
      }
    }
  }

  async snapshot(): Promise<PublishingIndex> {
    return structuredClone(this.currentIndex());
  }

  async getTask(taskId: string): Promise<PublishTask | null> {
    const task = this.currentIndex().tasks[taskId];
    return task ? structuredClone(task) : null;
  }

  async getPackage(packageId: string): Promise<PublishingPackageDetail | null> {
    const index = this.currentIndex();
    const packageRecord = index.packages[packageId];
    if (!packageRecord) return null;
    return this.packageDetail(index, packageRecord);
  }

  async reserveVersion(
    sourceJobId: string,
    actor: ActorSnapshot = SYSTEM_ACTOR
  ): Promise<number> {
    return this.withSourceLock(sourceJobId, () => this.mutate((draft) => {
      const version = draft.nextVersionBySource[sourceJobId] ?? 1;
      draft.nextVersionBySource[sourceJobId] = version + 1;
      draft.audit.push(this.auditEvent(`source:${sourceJobId}`, "source.reserve_version", actor, {
        metadata: { sourceJobId, version },
      }));
      return version;
    }));
  }

  async commitPackage(
    input: NewPackageRecord,
    actor: ActorSnapshot
  ): Promise<PublishingPackageDetail> {
    return this.withSourceLock(input.package.sourceJobId, () => this.mutate((draft) => {
      const packageInput = structuredClone(input.package);
      const taskInputs = structuredClone(input.tasks);
      const nextVersion = draft.nextVersionBySource[packageInput.sourceJobId] ?? 1;
      const versionTaken = Object.values(draft.packages).some((item) => (
        item.sourceJobId === packageInput.sourceJobId && item.version === packageInput.version
      ));
      if (
        draft.packages[packageInput.id] ||
        versionTaken ||
        packageInput.version < 1 ||
        packageInput.version >= nextVersion
      ) {
        throw new PublishingError("publish_revision_conflict", {
          sourceJobId: packageInput.sourceJobId,
          version: packageInput.version,
          nextVersion,
        });
      }
      if (packageInput.state !== "active" || taskInputs.length === 0) {
        throw new PublishingError("publish_validation_failed");
      }

      const taskIds = new Set<string>();
      const platforms = new Set<string>();
      const nowMs = this.now().getTime();
      for (const task of taskInputs) {
        if (
          task.packageId !== packageInput.id ||
          draft.tasks[task.id] ||
          taskIds.has(task.id) ||
          platforms.has(task.platform)
        ) {
          throw new PublishingError("publish_revision_conflict", {
            packageId: packageInput.id,
            taskId: task.id,
            platform: task.platform,
          });
        }
        if (!isValidInitialTask(task, nowMs)) {
          throw new PublishingError("publish_validation_failed", {
            taskId: task.id,
            field: "status",
          });
        }
        taskIds.add(task.id);
        platforms.add(task.platform);
      }

      packageInput.createdBy = structuredClone(actor);
      draft.packages[packageInput.id] = packageInput;
      for (const task of taskInputs) draft.tasks[task.id] = task;
      draft.audit.push(this.auditEvent(packageInput.id, "package.create", actor, {
        metadata: { sourceJobId: packageInput.sourceJobId, version: packageInput.version },
      }));
      return this.packageDetail(draft, packageInput);
    }));
  }

  async markPublished(
    taskId: string,
    actor: ActorSnapshot,
    publishedAt = this.timestamp()
  ): Promise<PublishTask> {
    return this.transitionTask(taskId, "published", "task.mark_published", actor, (task) => {
      task.publishedAt = publishedAt;
      delete task.lastError;
    });
  }

  async recordFailure(
    taskId: string,
    reason: string,
    actor: ActorSnapshot
  ): Promise<PublishTask> {
    const safeReason = requireReason(reason);
    return this.transitionTask(taskId, "failed", "task.record_failure", actor, (task) => {
      task.lastError = safeReason;
    }, safeReason);
  }

  async updateSchedule(
    taskId: string,
    scheduledAt: string | null,
    actor: ActorSnapshot
  ): Promise<PublishTask> {
    const targetStatus = scheduleStatus(scheduledAt, this.now());
    return this.mutate((draft) => {
      const task = this.requireMutableTask(draft, taskId);
      const fromStatus = task.status;
      if (
        (fromStatus !== "scheduled" && fromStatus !== "ready") ||
        (fromStatus !== targetStatus && !canTransition(fromStatus, targetStatus))
      ) {
        throw new PublishingError("publish_invalid_transition", {
          currentStatus: fromStatus,
          targetStatus,
          allowedStatuses: ALLOWED_TRANSITIONS[fromStatus],
        });
      }
      task.status = targetStatus;
      if (scheduledAt === null) delete task.scheduledAt;
      else task.scheduledAt = new Date(scheduledAt).toISOString();
      delete task.dueNotifiedAt;
      task.updatedAt = this.timestamp();
      draft.audit.push(this.auditEvent(task.packageId, "task.update_schedule", actor, {
        taskId,
        fromStatus,
        toStatus: targetStatus,
        metadata: scheduledAt === null ? { scheduledAt: null } : { scheduledAt: task.scheduledAt },
      }));
      return task;
    });
  }

  async cancel(taskId: string, actor: ActorSnapshot): Promise<PublishTask> {
    return this.transitionTask(taskId, "cancelled", "task.cancel", actor);
  }

  async restoreTask(
    taskId: string,
    scheduledAt: string | null,
    actor: ActorSnapshot
  ): Promise<PublishTask> {
    const targetStatus = scheduleStatus(scheduledAt, this.now());
    return this.transitionTask(taskId, targetStatus, "task.restore", actor, (task) => {
      if (scheduledAt === null) delete task.scheduledAt;
      else task.scheduledAt = new Date(scheduledAt).toISOString();
      delete task.dueNotifiedAt;
      delete task.lastError;
    });
  }

  async withdraw(
    taskId: string,
    reason: string,
    actor: ActorSnapshot
  ): Promise<PublishTask> {
    if (actor.role !== "admin") throw new PublishingError("publish_permission_denied");
    const safeReason = requireReason(reason);
    return this.transitionTask(taskId, "ready", "task.withdraw", actor, (task) => {
      delete task.publishedAt;
      delete task.lastError;
      delete task.dueNotifiedAt;
    }, safeReason);
  }

  async updateContent(
    taskId: string,
    input: {
      title: string;
      description: string;
      hashtags: string[];
      expectedRevision: number;
    },
    actor: ActorSnapshot
  ): Promise<PublishTask> {
    return this.mutate((draft) => {
      const task = this.requireMutableTask(draft, taskId);
      if (task.status === "published") {
        throw new PublishingError("publish_invalid_transition", {
          currentStatus: task.status,
          allowedActions: ["withdraw"],
        });
      }
      if (task.contentRevision !== input.expectedRevision) {
        throw new PublishingError("publish_revision_conflict", {
          expectedRevision: input.expectedRevision,
          currentRevision: task.contentRevision,
        });
      }

      task.title = input.title;
      task.description = input.description;
      task.hashtags = [...input.hashtags];
      task.copySource = "user_edited";
      task.contentRevision += 1;
      task.updatedAt = this.timestamp();
      draft.audit.push(this.auditEvent(task.packageId, "task.update_content", actor, {
        taskId,
        fromStatus: task.status,
        toStatus: task.status,
        metadata: { contentRevision: task.contentRevision },
      }));
      return task;
    });
  }

  async recordActionError(
    taskId: string,
    action: "open_platform" | "show_in_finder",
    message: string,
    actor: ActorSnapshot
  ): Promise<void> {
    await this.mutate((draft) => {
      const task = this.requireMutableTask(draft, taskId);
      draft.audit.push(this.auditEvent(task.packageId, "task.action_error", actor, {
        taskId,
        reason: message,
        metadata: { action },
      }));
    });
  }

  async processDue(now = this.now()): Promise<DueNotification[]> {
    return this.mutate((draft) => {
      const notifications = this.processDueInDraft(draft, now);
      return notifications.length > 0 ? notifications : noWrite(notifications);
    });
  }

  async trashPackage(packageId: string, actor: ActorSnapshot): Promise<DeliveryPackage> {
    return this.mutate((draft) => {
      const packageRecord = this.requirePackage(draft, packageId);
      if (packageRecord.state !== "active") {
        throw new PublishingError("publish_invalid_transition", {
          packageState: packageRecord.state,
          targetState: "trashed",
        });
      }
      const deletedAt = this.now();
      packageRecord.state = "trashed";
      packageRecord.deletedAt = deletedAt.toISOString();
      packageRecord.purgeAt = new Date(deletedAt.getTime() + TRASH_RETENTION_MS).toISOString();
      packageRecord.updatedAt = packageRecord.deletedAt;
      draft.audit.push(this.auditEvent(packageId, "package.trash", actor, {
        metadata: { fromState: "active", toState: "trashed" },
      }));
      return packageRecord;
    });
  }

  async restorePackage(
    packageId: string,
    actor: ActorSnapshot
  ): Promise<RestorePackageResult> {
    const restoredAt = this.now();
    return this.mutate((draft) => {
      const packageRecord = this.requirePackage(draft, packageId);
      if (packageRecord.state !== "trashed") {
        throw new PublishingError("publish_invalid_transition", {
          packageState: packageRecord.state,
          targetState: "active",
        });
      }
      packageRecord.state = "active";
      delete packageRecord.deletedAt;
      delete packageRecord.purgeAt;
      delete packageRecord.purgedAt;
      packageRecord.updatedAt = restoredAt.toISOString();
      draft.audit.push(this.auditEvent(
        packageId,
        "package.restore",
        actor,
        { metadata: { fromState: "trashed", toState: "active" } },
        restoredAt.toISOString()
      ));
      const notifications = this.processDueInDraft(draft, restoredAt, packageId);
      return { package: packageRecord, notifications };
    });
  }

  async setAssetHealth(
    packageId: string,
    health: PublishAssetHealth,
    actor: ActorSnapshot
  ): Promise<DeliveryPackage> {
    return this.mutate((draft) => {
      const packageRecord = this.requirePackage(draft, packageId);
      if (packageRecord.state !== "active") {
        throw new PublishingError("publish_invalid_transition", {
          packageState: packageRecord.state,
        });
      }
      const previousHealth = packageRecord.assetHealth;
      packageRecord.assetHealth = health;
      packageRecord.updatedAt = this.timestamp();
      draft.audit.push(this.auditEvent(packageId, "package.asset_health", actor, {
        metadata: { fromState: previousHealth, toState: health },
      }));
      return packageRecord;
    });
  }

  async markPurged(
    packageId: string,
    actor: ActorSnapshot = SYSTEM_ACTOR
  ): Promise<PublishingTombstone> {
    return this.mutate((draft) => {
      const packageRecord = this.requirePackage(draft, packageId);
      if (packageRecord.state !== "trashed") {
        throw new PublishingError("publish_invalid_transition", {
          packageState: packageRecord.state,
          targetState: "purged",
        });
      }
      const purgedAt = this.now();
      const purgeAtMs = packageRecord.purgeAt
        ? new Date(packageRecord.purgeAt).getTime()
        : Number.NaN;
      if (!packageRecord.deletedAt || !Number.isFinite(purgeAtMs)) {
        throw new PublishingError("publish_validation_failed", { packageId });
      }
      if (purgeAtMs > purgedAt.getTime()) {
        throw new PublishingError("publish_invalid_transition", {
          packageState: packageRecord.state,
          purgeAt: packageRecord.purgeAt,
        });
      }

      const tasks = Object.values(draft.tasks).filter((task) => task.packageId === packageId);
      const purgeAudit = this.auditEvent(packageId, "package.purge", actor, {
        metadata: { fromState: "trashed", toState: "purged" },
      }, purgedAt.toISOString());
      draft.audit.push(purgeAudit);
      const publishedAt = tasks
        .flatMap((task) => task.publishedAt ? [task.publishedAt] : [])
        .sort()
        .at(-1);
      const tombstone: PublishingTombstone = {
        packageId,
        sourceJobId: packageRecord.sourceJobId,
        version: packageRecord.version,
        platforms: tasks.map((task) => ({
          platform: task.platform,
          finalStatus: task.status,
        })),
        createdAt: packageRecord.createdAt,
        deletedAt: packageRecord.deletedAt,
        purgedAt: purgedAt.toISOString(),
        videoSha256: packageRecord.videoSha256,
        auditSummary: draft.audit
          .filter((event) => event.packageId === packageId)
          .map((event) => ({
            action: event.action,
            actor: structuredClone(event.actor),
            createdAt: event.createdAt,
          })),
      };
      if (publishedAt) tombstone.publishedAt = publishedAt;

      packageRecord.state = "purged";
      packageRecord.purgedAt = purgedAt.toISOString();
      packageRecord.updatedAt = purgedAt.toISOString();
      for (const task of tasks) delete draft.tasks[task.id];
      draft.tombstones[packageId] = tombstone;
      return tombstone;
    });
  }

  async recordPurgeFailure(
    packageId: string,
    message: string,
    actor: ActorSnapshot
  ): Promise<void> {
    const safeMessage = requireReason(message);
    await this.mutate((draft) => {
      const packageRecord = this.requirePackage(draft, packageId);
      if (packageRecord.state !== "trashed") {
        throw new PublishingError("publish_invalid_transition", {
          packageState: packageRecord.state,
        });
      }
      draft.audit.push(this.auditEvent(packageId, "package.purge_failed", actor, {
        reason: safeMessage,
      }));
    });
  }

  async list(filters: PublishingListFilters): Promise<PublishingPackageDetail[]> {
    const index = this.currentIndex();
    const status = filters.status ?? "action";
    return Object.values(index.packages)
      .filter((packageRecord) => {
        const tasks = Object.values(index.tasks).filter((task) => task.packageId === packageRecord.id);
        if (status === "trash") {
          if (packageRecord.state !== "trashed") return false;
        } else {
          if (packageRecord.state !== "active") return false;
          if (status === "action") {
            if (
              packageRecord.assetHealth !== "broken_video" &&
              !tasks.some((task) => task.status === "ready" || task.status === "failed")
            ) return false;
          } else if (status === "broken") {
            if (packageRecord.assetHealth === "healthy") return false;
          } else if (status !== "all" && !tasks.some((task) => task.status === status)) {
            return false;
          }
        }
        if (filters.platform && !tasks.some((task) => task.platform === filters.platform)) return false;
        if (filters.sourceJobId && packageRecord.sourceJobId !== filters.sourceJobId) return false;
        if (filters.version !== undefined && packageRecord.version !== filters.version) return false;
        if (filters.createdBy && packageRecord.createdBy.userId !== filters.createdBy) return false;
        if (filters.search && !matchesSearch(packageRecord, tasks, filters.search)) return false;
        return true;
      })
      .sort((a, b) => (
        b.createdAt.localeCompare(a.createdAt) ||
        b.version - a.version ||
        a.id.localeCompare(b.id)
      ))
      .map((packageRecord) => this.packageDetail(index, packageRecord));
  }

  private processDueInDraft(
    draft: PublishingIndex,
    now: Date,
    onlyPackageId?: string
  ): DueNotification[] {
    const nowMs = now.getTime();
    const becameReadyAt = now.toISOString();
    const notifications: DueNotification[] = [];
    for (const task of Object.values(draft.tasks)) {
      const packageRecord = draft.packages[task.packageId];
      if (
        (onlyPackageId && task.packageId !== onlyPackageId) ||
        packageRecord?.state !== "active" ||
        task.status !== "scheduled" ||
        !task.scheduledAt ||
        task.dueNotifiedAt
      ) {
        continue;
      }
      const scheduledMs = new Date(task.scheduledAt).getTime();
      if (!Number.isFinite(scheduledMs) || scheduledMs > nowMs) continue;

      task.status = "ready";
      task.dueNotifiedAt = becameReadyAt;
      task.updatedAt = becameReadyAt;
      draft.audit.push(this.auditEvent(task.packageId, "task.due", SYSTEM_ACTOR, {
        taskId: task.id,
        fromStatus: "scheduled",
        toStatus: "ready",
        metadata: { scheduledAt: task.scheduledAt, overdueMs: nowMs - scheduledMs },
      }, becameReadyAt));
      notifications.push({
        taskId: task.id,
        packageId: task.packageId,
        platform: task.platform,
        platformLabel: PUBLISH_PLATFORMS[task.platform].label,
        title: task.title,
        scheduledAt: task.scheduledAt,
        becameReadyAt,
        overdueMs: nowMs - scheduledMs,
      });
    }
    return notifications;
  }

  private async transitionTask(
    taskId: string,
    toStatus: PublishTaskStatus,
    action: string,
    actor: ActorSnapshot,
    update?: (task: PublishTask) => void,
    reason?: string
  ): Promise<PublishTask> {
    return this.mutate((draft) => {
      const task = this.requireMutableTask(draft, taskId);
      const fromStatus = task.status;
      if (!canTransition(fromStatus, toStatus)) {
        throw new PublishingError("publish_invalid_transition", {
          currentStatus: fromStatus,
          targetStatus: toStatus,
          allowedStatuses: ALLOWED_TRANSITIONS[fromStatus],
        });
      }
      if (toStatus === "published") {
        const packageRecord = draft.packages[task.packageId];
        if (packageRecord.assetHealth === "broken_video") {
          throw new PublishingError("publish_asset_broken");
        }
      }

      task.status = toStatus;
      task.updatedAt = this.timestamp();
      update?.(task);
      draft.audit.push(this.auditEvent(task.packageId, action, actor, {
        taskId,
        fromStatus,
        toStatus,
        reason,
      }));
      return task;
    });
  }

  private requireMutableTask(index: PublishingIndex, taskId: string): PublishTask {
    const task = index.tasks[taskId];
    if (!task) throw new PublishingError("publish_task_not_found");
    const packageRecord = index.packages[task.packageId];
    if (!packageRecord) throw new PublishingError("publish_package_not_found");
    if (packageRecord.state !== "active") {
      throw new PublishingError("publish_invalid_transition", { packageState: packageRecord.state });
    }
    return task;
  }

  private requirePackage(index: PublishingIndex, packageId: string): DeliveryPackage {
    const packageRecord = index.packages[packageId];
    if (!packageRecord) throw new PublishingError("publish_package_not_found");
    return packageRecord;
  }

  private packageDetail(
    index: PublishingIndex,
    packageRecord: DeliveryPackage
  ): PublishingPackageDetail {
    const detail: PublishingPackageDetail = {
      package: structuredClone(packageRecord),
      tasks: Object.values(index.tasks)
        .filter((task) => task.packageId === packageRecord.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((task) => structuredClone(task)),
      audit: index.audit
        .filter((event) => event.packageId === packageRecord.id)
        .map((event) => structuredClone(event)),
    };
    const tombstone = index.tombstones[packageRecord.id];
    if (tombstone) detail.tombstone = structuredClone(tombstone);
    return detail;
  }

  private auditEvent(
    packageId: string,
    action: string,
    actor: ActorSnapshot,
    fields: Partial<PublishAuditEvent> = {},
    createdAt = this.timestamp()
  ): PublishAuditEvent {
    const event: PublishAuditEvent = {
      id: randomUUID(),
      packageId,
      action,
      actor: structuredClone(actor),
      createdAt,
    };
    if (fields.taskId !== undefined) event.taskId = fields.taskId;
    if (fields.fromStatus !== undefined) event.fromStatus = fields.fromStatus;
    if (fields.toStatus !== undefined) event.toStatus = fields.toStatus;
    if (fields.reason !== undefined) event.reason = fields.reason;
    if (fields.metadata !== undefined) event.metadata = structuredClone(fields.metadata);
    return event;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async mutate<T>(change: (draft: PublishingIndex) => T | NoWrite<T>): Promise<T> {
    return this.enqueueWrite(async () => {
      if (this.coordinator.readOnlyError) throw this.coordinator.readOnlyError;
      const draft = structuredClone(this.currentIndex());
      const result = change(draft);
      if (isNoWrite(result)) return structuredClone(result.result);
      draft.revision += 1;
      await this.storage.writeJsonAtomic(PUBLISHING_INDEX, draft);
      this.coordinator.index = draft;
      return structuredClone(result);
    });
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.coordinator.writeTail.then(operation, operation);
    this.coordinator.writeTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async withSourceLock<T>(sourceJobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.coordinator.sourceLocks.get(sourceJobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.coordinator.sourceLocks.set(sourceJobId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.coordinator.sourceLocks.get(sourceJobId) === tail) {
        this.coordinator.sourceLocks.delete(sourceJobId);
      }
    }
  }

  private async initializeCoordinator(): Promise<void> {
    try {
      const index = await this.storage.readJson<PublishingIndex>(PUBLISHING_INDEX);
      if (!isPublishingIndex(index)) throw new InvalidPublishingIndexError();
      this.coordinator.index = index;
      this.coordinator.readOnlyError = null;
      this.coordinator.initialized = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const index = emptyIndex();
        await this.storage.writeJsonAtomic(PUBLISHING_INDEX, index);
        this.coordinator.index = index;
        this.coordinator.readOnlyError = null;
        this.coordinator.initialized = true;
        return;
      }
      if (error instanceof SyntaxError || error instanceof InvalidPublishingIndexError) {
        this.coordinator.index = emptyIndex();
        this.coordinator.readOnlyError = new PublishingError("publish_index_corrupt");
        this.coordinator.initialized = true;
        return;
      }
      throw error;
    }
  }

  private currentIndex(): PublishingIndex {
    if (this.coordinator.index) return this.coordinator.index;
    throw this.coordinator.readOnlyError ?? new PublishingError("publish_index_corrupt");
  }
}

class InvalidPublishingIndexError extends Error {}

function canonicalIndexPath(storage: LocalStorage): string {
  const basePath = path.resolve(storage.resolve());
  try {
    return path.join(realpathSync.native(basePath), PUBLISHING_INDEX);
  } catch {
    return path.resolve(storage.resolve(PUBLISHING_INDEX));
  }
}

const ALLOWED_TRANSITIONS: Record<PublishTaskStatus, readonly PublishTaskStatus[]> = {
  scheduled: ["ready", "cancelled", "failed"],
  ready: ["scheduled", "published", "failed", "cancelled"],
  failed: ["ready", "scheduled", "cancelled"],
  cancelled: ["ready", "scheduled"],
  published: ["ready"],
};

function canTransition(from: PublishTaskStatus, to: PublishTaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function scheduleStatus(scheduledAt: string | null, now: Date): "scheduled" | "ready" {
  if (scheduledAt === null) return "ready";
  const scheduledMs = new Date(scheduledAt).getTime();
  if (!Number.isFinite(scheduledMs)) {
    throw new PublishingError("publish_validation_failed", { field: "scheduledAt" });
  }
  return scheduledMs > now.getTime() ? "scheduled" : "ready";
}

function requireReason(reason: string): string {
  const safeReason = reason.trim();
  if (!safeReason) {
    throw new PublishingError("publish_validation_failed", { field: "reason" });
  }
  return safeReason;
}

function isValidInitialTask(task: PublishTask, nowMs: number): boolean {
  if (task.publishedAt || task.dueNotifiedAt || task.lastError) return false;
  if (task.status === "ready") return task.scheduledAt === undefined;
  if (task.status !== "scheduled" || !task.scheduledAt) return false;
  const scheduledMs = new Date(task.scheduledAt).getTime();
  return Number.isFinite(scheduledMs) && scheduledMs > nowMs;
}

function matchesSearch(
  packageRecord: DeliveryPackage,
  tasks: PublishTask[],
  search: string
): boolean {
  const needle = search.trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  const values = [
    packageRecord.title,
    packageRecord.sourceJobId,
    ...tasks.flatMap((task) => [
      task.title,
      task.description,
      task.platform,
      ...task.hashtags,
    ]),
  ];
  return values.some((value) => value.toLocaleLowerCase("zh-CN").includes(needle));
}

function noWrite<T>(result: T): NoWrite<T> {
  return { [NO_WRITE]: true, result };
}

function isNoWrite<T>(value: T | NoWrite<T>): value is NoWrite<T> {
  return !!value && typeof value === "object" && NO_WRITE in value;
}

function emptyIndex(): PublishingIndex {
  return {
    schemaVersion: 1,
    revision: 0,
    nextVersionBySource: {},
    packages: {},
    tasks: {},
    audit: [],
    tombstones: {},
  };
}

function isPublishingIndex(value: unknown): value is PublishingIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<PublishingIndex>;
  if (!(
    index.schemaVersion === 1 &&
    Number.isInteger(index.revision) &&
    (index.revision ?? -1) >= 0 &&
    isRecord(index.nextVersionBySource) &&
    isRecord(index.packages) &&
    isRecord(index.tasks) &&
    Array.isArray(index.audit) &&
    isRecord(index.tombstones)
  )) return false;

  if (!Object.values(index.nextVersionBySource).every(isPositiveInteger)) return false;
  if (!Object.entries(index.packages).every(([id, item]) => isDeliveryPackage(item, id))) return false;
  if (!Object.entries(index.tasks).every(([id, item]) => isPublishTask(item, id))) return false;
  if (!index.audit.every(isAuditEvent)) return false;
  if (!Object.entries(index.tombstones).every(([id, item]) => isTombstone(item, id))) return false;
  return Object.values(index.tasks).every((task) => !!index.packages?.[task.packageId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isActor(value: unknown): value is ActorSnapshot {
  if (!isRecord(value)) return false;
  return (
    isString(value.userId) &&
    isString(value.displayName) &&
    (value.role === "admin" || value.role === "publisher" || value.role === "system")
  );
}

function isDeliveryPackage(value: unknown, key: string): value is DeliveryPackage {
  if (!isRecord(value)) return false;
  return (
    value.id === key &&
    isString(value.sourceJobId) &&
    isPositiveInteger(value.version) &&
    (value.state === "active" || value.state === "trashed" || value.state === "purged") &&
    isString(value.title) &&
    isString(value.packagePath) &&
    isOptionalString(value.videoPath) &&
    isOptionalString(value.coverPath) &&
    isString(value.videoSha256) &&
    typeof value.videoSize === "number" &&
    Number.isFinite(value.videoSize) &&
    (value.videoMethod === "clone" || value.videoMethod === "copy") &&
    (value.assetHealth === "healthy" || value.assetHealth === "missing_cover" || value.assetHealth === "broken_video") &&
    isActor(value.createdBy) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isOptionalString(value.deletedAt) &&
    isOptionalString(value.purgeAt) &&
    isOptionalString(value.purgedAt)
  );
}

function isPublishTask(value: unknown, key: string): value is PublishTask {
  if (!isRecord(value)) return false;
  return (
    value.id === key &&
    isString(value.packageId) &&
    isPlatform(value.platform) &&
    isString(value.title) &&
    isString(value.description) &&
    Array.isArray(value.hashtags) &&
    value.hashtags.every(isString) &&
    (value.copySource === "ai" || value.copySource === "cleaned_fallback" || value.copySource === "user_edited") &&
    isTaskStatus(value.status) &&
    isOptionalString(value.scheduledAt) &&
    isOptionalString(value.dueNotifiedAt) &&
    isOptionalString(value.publishedAt) &&
    isOptionalString(value.lastError) &&
    isPositiveInteger(value.contentRevision) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

function isAuditEvent(value: unknown): value is PublishAuditEvent {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.packageId) &&
    isOptionalString(value.taskId) &&
    isString(value.action) &&
    isActor(value.actor) &&
    (value.fromStatus === undefined || isTaskStatus(value.fromStatus)) &&
    (value.toStatus === undefined || isTaskStatus(value.toStatus)) &&
    isOptionalString(value.reason) &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    isString(value.createdAt)
  );
}

function isTombstone(value: unknown, key: string): value is PublishingTombstone {
  if (!isRecord(value)) return false;
  return (
    value.packageId === key &&
    isString(value.sourceJobId) &&
    isPositiveInteger(value.version) &&
    Array.isArray(value.platforms) &&
    value.platforms.every((item) => (
      isRecord(item) && isPlatform(item.platform) && isTaskStatus(item.finalStatus)
    )) &&
    isString(value.createdAt) &&
    isOptionalString(value.publishedAt) &&
    isString(value.deletedAt) &&
    isString(value.purgedAt) &&
    isString(value.videoSha256) &&
    Array.isArray(value.auditSummary) &&
    value.auditSummary.every((item) => (
      isRecord(item) && isString(item.action) && isActor(item.actor) && isString(item.createdAt)
    ))
  );
}

function isTaskStatus(value: unknown): value is PublishTaskStatus {
  return (
    value === "scheduled" ||
    value === "ready" ||
    value === "published" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isPlatform(value: unknown): value is PublishTask["platform"] {
  return (
    value === "douyin" ||
    value === "xiaohongshu" ||
    value === "wechat_channels" ||
    value === "bilibili"
  );
}
