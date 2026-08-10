import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  ActorSnapshot,
  DeliveryPackage,
  DueNotification,
  PackageVideoMethod,
  PublishAssetHealth,
  PublishingIndex,
  PublishingPackageDetail,
  PublishTask,
} from "../types.js";
import { buildPublishText } from "./publishing-platforms.js";

const APPROVED_PLATFORMS = new Set(["douyin", "xiaohongshu", "wechat_channels", "bilibili"]);
const TEMP_STALE_MS = 60 * 60 * 1000;
const ASSET_LOCKS = new Map<string, Promise<void>>();
const PROJECTION_GENERATIONS = new Map<string, number>();
const LIVE_TEMP_PATHS = new Set<string>();

export type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface PackageAssetInput {
  packageId: string;
  sourceJobId: string;
  version: number;
  sourceVideoPath: string;
  sourceCoverPath?: string;
  title: string;
  tasks: PublishTask[];
  actor: ActorSnapshot;
}

export interface PackageAssetResult {
  packagePath: string;
  videoPath: string;
  coverPath?: string;
  videoSha256: string;
  videoSize: number;
  videoMethod: PackageVideoMethod;
  assetHealth: PublishAssetHealth;
  rollback(): Promise<void>;
}

export interface ProjectionTransaction {
  commit(): Promise<void>;
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PublishingRecoveryFailure {
  packageId?: string;
  path?: string;
  code: string;
  message: string;
}

export interface PublishingRecoveryReport {
  removedTempPaths: string[];
  orphanPaths: string[];
  repairedPackageIds: string[];
  brokenPackageIds: string[];
  repairFailures: PublishingRecoveryFailure[];
  scanFailures: PublishingRecoveryFailure[];
  notifications: DueNotification[];
  purgedPackageIds: string[];
  purgeFailures: Array<{ packageId: string; message: string }>;
}

type PublishingAssetErrorCode =
  | "publish_clone_failed"
  | "publish_revision_conflict"
  | "publish_storage_full"
  | "publish_video_missing"
  | "publish_video_unreadable";

const ERROR_MESSAGES: Record<PublishingAssetErrorCode, string> = {
  publish_clone_failed: "成片复制失败，请检查磁盘空间和文件权限",
  publish_revision_conflict: "发布投影已被其他操作修改，请刷新后重试",
  publish_storage_full: "存储空间不足，无法创建发布包",
  publish_video_missing: "未找到可用成片，请重新生成视频",
  publish_video_unreadable: "成片文件不可读取，请检查文件权限后重试",
};

export class PublishingAssetError extends Error {
  readonly status = 422;

  constructor(readonly code: PublishingAssetErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PublishingAssetError";
  }
}

type AssetDependencies = {
  storageRoot: string;
  copyFile?: typeof copyFile;
  rename?: typeof rename;
  rm?: typeof rm;
  runCommand?: CommandRunner;
  now?: () => Date;
};

type FileIdentity = Pick<Stats, "dev" | "ino">;

type DirectorySnapshot = {
  directories: string[];
  files: Map<string, Buffer>;
};

type RootContext = {
  storageRoot: string;
  publishingRoot: string;
  publishingIdentity: FileIdentity;
};

type OpenSourceVideo = {
  path: string;
  handle: FileHandle;
  initialStats: Stats;
  initialSha256: string;
};

export class PublishingAssetService {
  private readonly copyFile: typeof copyFile;
  private readonly rename: typeof rename;
  private readonly rm: typeof rm;
  private readonly runCommand: CommandRunner;
  private readonly now: () => Date;

  constructor(private readonly deps: AssetDependencies) {
    this.copyFile = deps.copyFile ?? copyFile;
    this.rename = deps.rename ?? rename;
    this.rm = deps.rm ?? rm;
    this.runCommand = deps.runCommand ?? runCommand;
    this.now = deps.now ?? (() => new Date());
  }

  async createPackageAssets(input: PackageAssetInput): Promise<PackageAssetResult> {
    validateSegment(input.packageId);
    validateSegment(input.sourceJobId);
    validateVersion(input.version);
    validateProjectionTasks(input.packageId, input.tasks);

    return this.withAssetLock(async (context) => {
      const source = await this.openSourceVideo(input.sourceVideoPath, context.storageRoot);
      const sourceDirectory = path.join(context.publishingRoot, input.sourceJobId);
      const tempPath = path.join(sourceDirectory, `.next-${input.packageId}`);
      const packagePath = expectedPackagePath(context.publishingRoot, input.sourceJobId, input.version, input.packageId);
      let tempIdentity: FileIdentity | undefined;
      let packageIdentity: FileIdentity | undefined;
      let promoted = false;
      LIVE_TEMP_PATHS.add(tempPath);

      try {
        const sourceIdentity = await ensureDirectDirectory(
          context.publishingRoot,
          context.publishingIdentity,
          input.sourceJobId,
        );
        await this.safeRemoveDirect(context, sourceDirectory, sourceIdentity, tempPath);
        await this.assertRootAndDirectory(context, sourceDirectory, sourceIdentity);
        await mkdir(tempPath);
        tempIdentity = await requireDirectoryIdentity(tempPath);
        await this.assertRootAndDirectory(context, sourceDirectory, sourceIdentity);

        const stagedVideoPath = path.join(tempPath, "video.mp4");
        const videoMethod = await this.cloneOrCopyVerified(source, stagedVideoPath, context, tempIdentity);
        const videoStats = await stat(stagedVideoPath);
        const videoSha256 = await hashFilePath(stagedVideoPath);
        const stagedCoverPath = await this.prepareCover(
          input.sourceCoverPath,
          source.path,
          tempPath,
          context,
          tempIdentity,
        );
        const assetHealth: PublishAssetHealth = stagedCoverPath ? "healthy" : "missing_cover";

        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
        await writePlatformProjection(path.join(tempPath, "platforms"), input.tasks);
        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
        await writeFile(path.join(tempPath, "manifest.json"), JSON.stringify({
          schemaVersion: 1,
          package: {
            id: input.packageId,
            sourceJobId: input.sourceJobId,
            version: input.version,
            title: input.title,
            createdBy: {
              userId: input.actor.userId,
              displayName: input.actor.displayName,
              role: input.actor.role,
            },
            createdAt: this.now().toISOString(),
          },
          video: {
            path: "video.mp4",
            sha256: videoSha256,
            size: videoStats.size,
            method: videoMethod,
          },
          cover: stagedCoverPath ? { path: "cover.jpg" } : null,
          assetHealth,
          tasks: input.tasks.map((task) => ({
            id: task.id,
            platform: task.platform,
            videoPath: "video.mp4",
            title: task.title,
            description: task.description,
            hashtags: [...task.hashtags],
            copySource: task.copySource,
            status: task.status,
            scheduledAt: task.scheduledAt,
            contentRevision: task.contentRevision,
          })),
        }, null, 2), "utf8");

        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
        if (await pathExistsNoFollow(packagePath)) {
          throw new PublishingAssetError("publish_clone_failed");
        }
        await this.safeRenameDirect(context, sourceDirectory, sourceIdentity, tempPath, packagePath, tempIdentity);
        packageIdentity = await requireDirectoryIdentity(packagePath);
        promoted = true;
        LIVE_TEMP_PATHS.delete(tempPath);

        const videoPath = path.join(packagePath, "video.mp4");
        const coverPath = stagedCoverPath ? path.join(packagePath, "cover.jpg") : undefined;
        let rolledBack = false;
        const promotedIdentity = packageIdentity;

        return {
          packagePath,
          videoPath,
          coverPath,
          videoSha256,
          videoSize: videoStats.size,
          videoMethod,
          assetHealth,
          rollback: async () => {
            if (rolledBack) return;
            await this.withAssetLock(async (currentContext) => {
              const expected = expectedPackagePath(
                currentContext.publishingRoot,
                input.sourceJobId,
                input.version,
                input.packageId,
              );
              if (expected !== packagePath) throw new PublishingAssetError("publish_revision_conflict");
              const currentSourceIdentity = await requireDirectDirectory(
                currentContext.publishingRoot,
                currentContext.publishingIdentity,
                input.sourceJobId,
              );
              if (!await pathExistsNoFollow(packagePath)) {
                rolledBack = true;
                return;
              }
              await requireMatchingDirectory(packagePath, promotedIdentity);
              await this.safeRemoveDirect(currentContext, sourceDirectory, currentSourceIdentity, packagePath, promotedIdentity);
              rolledBack = true;
            });
          },
        };
      } catch (error) {
        if (promoted && packageIdentity) {
          await this.safeRemoveDirect(context, sourceDirectory, undefined, packagePath, packageIdentity).catch(() => undefined);
        } else if (tempIdentity) {
          await this.safeRemoveDirect(context, sourceDirectory, undefined, tempPath, tempIdentity).catch(() => undefined);
        }
        throw normalizeAssetError(error);
      } finally {
        LIVE_TEMP_PATHS.delete(tempPath);
        await source.handle.close().catch(() => undefined);
      }
    });
  }

  async stageTextProjection(detail: PublishingPackageDetail): Promise<ProjectionTransaction> {
    validateProjectionTasks(detail.package.id, detail.tasks);

    return this.withAssetLock(async (context) => {
      const packageBinding = await requireExpectedPackage(context, detail.package, true);
      const packagePath = packageBinding.path;
      const targetPath = path.join(packagePath, "platforms");
      const transactionId = randomUUID();
      const tempPath = path.join(packagePath, `.next-platforms-${transactionId}`);
      const backupPath = path.join(packagePath, `.previous-platforms-${transactionId}`);
      const previousSnapshot = await snapshotManagedDirectory(packagePath, packageBinding.identity, targetPath);
      const stagedFingerprint = fingerprintSnapshot(previousSnapshot);
      const stagedGeneration = PROJECTION_GENERATIONS.get(packagePath) ?? 0;

      await this.safeRemoveDirect(context, packagePath, packageBinding.identity, tempPath);
      await this.assertRootAndDirectory(context, packagePath, packageBinding.identity);
      await mkdir(tempPath);
      const tempIdentity = await requireDirectoryIdentity(tempPath);
      LIVE_TEMP_PATHS.add(tempPath);
      try {
        await writePlatformProjection(tempPath, detail.tasks);
        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
      } catch (error) {
        await this.safeRemoveDirect(context, packagePath, packageBinding.identity, tempPath, tempIdentity).catch(() => undefined);
        LIVE_TEMP_PATHS.delete(tempPath);
        throw normalizeAssetError(error);
      }

      let state: "staged" | "committed" | "finalized" | "rolled_back" = "staged";
      let backupIdentity: FileIdentity | undefined;
      let committedGeneration: number | undefined;
      let committedFingerprint: string | undefined;
      const hadPrevious = previousSnapshot !== undefined;

      return {
        commit: async () => {
          await this.withAssetLock(async (currentContext) => {
            if (state === "committed") return;
            if (state !== "staged") throw new PublishingAssetError("publish_revision_conflict");
            const currentPackage = await requireExpectedPackage(currentContext, detail.package, true);
            await requireMatchingDirectory(packagePath, packageBinding.identity);
            const currentGeneration = PROJECTION_GENERATIONS.get(packagePath) ?? 0;
            const currentSnapshot = await snapshotManagedDirectory(packagePath, currentPackage.identity, targetPath);
            if (currentGeneration !== stagedGeneration || fingerprintSnapshot(currentSnapshot) !== stagedFingerprint) {
              await this.safeRemoveDirect(currentContext, packagePath, currentPackage.identity, tempPath, tempIdentity).catch(() => undefined);
              LIVE_TEMP_PATHS.delete(tempPath);
              state = "rolled_back";
              throw new PublishingAssetError("publish_revision_conflict");
            }

            let targetIdentity: FileIdentity | undefined;
            if (currentSnapshot) targetIdentity = await requireDirectoryIdentity(targetPath);
            try {
              if (targetIdentity) {
                await this.safeRenameDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  targetPath,
                  backupPath,
                  targetIdentity,
                );
                backupIdentity = targetIdentity;
              }
              await this.safeRenameDirect(
                currentContext,
                packagePath,
                currentPackage.identity,
                tempPath,
                targetPath,
                tempIdentity,
              );
              LIVE_TEMP_PATHS.delete(tempPath);
              committedGeneration = stagedGeneration + 1;
              PROJECTION_GENERATIONS.set(packagePath, committedGeneration);
              committedFingerprint = fingerprintSnapshot(
                await snapshotManagedDirectory(packagePath, currentPackage.identity, targetPath),
              );
              state = "committed";
            } catch (error) {
              if (backupIdentity && await pathExistsNoFollow(backupPath) && !await pathExistsNoFollow(targetPath)) {
                await this.safeRenameDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  backupPath,
                  targetPath,
                  backupIdentity,
                ).catch(() => undefined);
              }
              throw normalizeAssetError(error);
            }
          });
        },
        finalize: async () => {
          await this.withAssetLock(async (currentContext) => {
            if (state === "finalized") return;
            if (state !== "committed") throw new PublishingAssetError("publish_revision_conflict");
            const currentPackage = await requireExpectedPackage(currentContext, detail.package, true);
            if (backupIdentity && await pathExistsNoFollow(backupPath)) {
              await this.safeRemoveDirect(
                currentContext,
                packagePath,
                currentPackage.identity,
                backupPath,
                backupIdentity,
              );
            }
            state = "finalized";
          });
        },
        rollback: async () => {
          await this.withAssetLock(async (currentContext) => {
            if (state === "rolled_back") return;
            const currentPackage = await requireExpectedPackage(currentContext, detail.package, true);
            if (state === "staged") {
              await this.safeRemoveDirect(
                currentContext,
                packagePath,
                currentPackage.identity,
                tempPath,
                tempIdentity,
              );
              LIVE_TEMP_PATHS.delete(tempPath);
              state = "rolled_back";
              return;
            }
            if (state !== "committed") throw new PublishingAssetError("publish_revision_conflict");

            const currentGeneration = PROJECTION_GENERATIONS.get(packagePath) ?? 0;
            const currentFingerprint = fingerprintSnapshot(
              await snapshotManagedDirectory(packagePath, currentPackage.identity, targetPath),
            );
            if (currentGeneration !== committedGeneration || currentFingerprint !== committedFingerprint) {
              throw new PublishingAssetError("publish_revision_conflict");
            }

            const targetIdentity = await requireDirectoryIdentity(targetPath);
            const displacedPath = path.join(packagePath, `.previous-platforms-rollback-${transactionId}`);
            await this.safeRenameDirect(
              currentContext,
              packagePath,
              currentPackage.identity,
              targetPath,
              displacedPath,
              targetIdentity,
            );
            try {
              if (hadPrevious && backupIdentity) {
                await this.safeRenameDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  backupPath,
                  targetPath,
                  backupIdentity,
                );
              }
              await this.safeRemoveDirect(
                currentContext,
                packagePath,
                currentPackage.identity,
                displacedPath,
                targetIdentity,
              );
              PROJECTION_GENERATIONS.set(packagePath, currentGeneration + 1);
              state = "rolled_back";
            } catch (error) {
              if (!await pathExistsNoFollow(targetPath) && await pathExistsNoFollow(displacedPath)) {
                await this.safeRenameDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  displacedPath,
                  targetPath,
                  targetIdentity,
                ).catch(() => undefined);
              }
              throw normalizeAssetError(error);
            }
          });
        },
      };
    });
  }

  async verifyPackageVideo(pkg: DeliveryPackage): Promise<PublishAssetHealth> {
    return this.withAssetLock((context) => this.verifyPackageVideoUnlocked(context, pkg));
  }

  async purgeAssets(pkg: DeliveryPackage): Promise<void> {
    await this.withAssetLock(async (context) => {
      const expected = expectedPackagePathFromRecord(context.publishingRoot, pkg);
      assertDeclaredPackagePaths(expected, pkg);
      if (!await pathExistsNoFollow(expected)) return;
      const binding = await requireExpectedPackage(context, pkg, true);
      const sourceDirectory = path.dirname(expected);
      const sourceIdentity = await requireDirectoryIdentity(sourceDirectory);
      await this.safeRemoveDirect(context, sourceDirectory, sourceIdentity, expected, binding.identity);
      PROJECTION_GENERATIONS.delete(expected);
    });
  }

  async scanAndRepair(index: PublishingIndex): Promise<PublishingRecoveryReport> {
    return this.withAssetLock(async (context) => {
      const report: PublishingRecoveryReport = {
        removedTempPaths: [],
        orphanPaths: [],
        repairedPackageIds: [],
        brokenPackageIds: [],
        repairFailures: [],
        scanFailures: [],
        notifications: [],
        purgedPackageIds: [],
        purgeFailures: [],
      };

      try {
        report.removedTempPaths = await this.removeStaleTemporaryPaths(context, report.scanFailures);
      } catch (error) {
        report.scanFailures.push(recoveryFailure(error, { path: context.publishingRoot }));
      }

      try {
        report.orphanPaths = await findOrphanPackages(context, index, report.scanFailures);
      } catch (error) {
        report.scanFailures.push(recoveryFailure(error, { path: context.publishingRoot }));
      }

      const packageIds = Object.keys(index.packages).sort();
      for (const packageId of packageIds) {
        const pkg = index.packages[packageId];
        if (pkg.state !== "active") continue;
        try {
          const health = await this.verifyPackageVideoUnlocked(context, pkg);
          pkg.assetHealth = health;
          if (health === "broken_video") report.brokenPackageIds.push(packageId);
        } catch (error) {
          pkg.assetHealth = "broken_video";
          report.brokenPackageIds.push(packageId);
          report.scanFailures.push(recoveryFailure(error, { packageId }));
        }
      }

      for (const packageId of packageIds) {
        const pkg = index.packages[packageId];
        if (pkg.state !== "active") continue;
        const tasks = Object.values(index.tasks)
          .filter((task) => task.packageId === packageId)
          .sort((a, b) => a.platform.localeCompare(b.platform));
        try {
          const repaired = await this.repairProjectionUnlocked(context, pkg, tasks);
          if (repaired) report.repairedPackageIds.push(packageId);
        } catch (error) {
          report.repairFailures.push(recoveryFailure(error, { packageId }));
        }
      }

      report.removedTempPaths.sort();
      report.orphanPaths.sort();
      report.repairedPackageIds.sort();
      report.brokenPackageIds = [...new Set(report.brokenPackageIds)].sort();
      return report;
    });
  }

  private async verifyPackageVideoUnlocked(context: RootContext, pkg: DeliveryPackage): Promise<PublishAssetHealth> {
    try {
      const binding = await requireExpectedPackage(context, pkg, true);
      const expectedVideoPath = path.join(binding.path, "video.mp4");
      const videoStats = await lstat(expectedVideoPath);
      if (videoStats.isSymbolicLink() || !videoStats.isFile() || videoStats.size === 0 || videoStats.size !== pkg.videoSize) {
        return "broken_video";
      }
      const canonicalVideoPath = await realpath(expectedVideoPath);
      if (canonicalVideoPath !== expectedVideoPath || await hashFilePath(expectedVideoPath) !== pkg.videoSha256) {
        return "broken_video";
      }
      if (!pkg.coverPath) return "missing_cover";
      const expectedCoverPath = path.join(binding.path, "cover.jpg");
      if (path.resolve(pkg.coverPath) !== expectedCoverPath) return "missing_cover";
      return await isReadableDirectFile(binding.path, binding.identity, expectedCoverPath) ? "healthy" : "missing_cover";
    } catch {
      return "broken_video";
    }
  }

  private async repairProjectionUnlocked(
    context: RootContext,
    pkg: DeliveryPackage,
    tasks: PublishTask[],
  ): Promise<boolean> {
    validateProjectionTasks(pkg.id, tasks);
    const binding = await requireExpectedPackage(context, pkg, true);
    const targetPath = path.join(binding.path, "platforms");
    const current = await snapshotManagedDirectory(binding.path, binding.identity, targetPath);
    if (projectionMatchesSnapshot(current, tasks)) return false;

    const transactionId = randomUUID();
    const tempPath = path.join(binding.path, `.next-platforms-scan-${transactionId}`);
    const backupPath = path.join(binding.path, `.previous-platforms-scan-${transactionId}`);
    await mkdir(tempPath);
    const tempIdentity = await requireDirectoryIdentity(tempPath);
    LIVE_TEMP_PATHS.add(tempPath);
    let backupIdentity: FileIdentity | undefined;
    try {
      await writePlatformProjection(tempPath, tasks);
      if (current) {
        const targetIdentity = await requireDirectoryIdentity(targetPath);
        await this.safeRenameDirect(context, binding.path, binding.identity, targetPath, backupPath, targetIdentity);
        backupIdentity = targetIdentity;
      }
      await this.safeRenameDirect(context, binding.path, binding.identity, tempPath, targetPath, tempIdentity);
      LIVE_TEMP_PATHS.delete(tempPath);
      if (backupIdentity) {
        await this.safeRemoveDirect(context, binding.path, binding.identity, backupPath, backupIdentity);
      }
      PROJECTION_GENERATIONS.set(binding.path, (PROJECTION_GENERATIONS.get(binding.path) ?? 0) + 1);
      return true;
    } catch (error) {
      if (backupIdentity && await pathExistsNoFollow(backupPath) && !await pathExistsNoFollow(targetPath)) {
        await this.safeRenameDirect(context, binding.path, binding.identity, backupPath, targetPath, backupIdentity).catch(() => undefined);
      }
      await this.safeRemoveDirect(context, binding.path, binding.identity, tempPath, tempIdentity).catch(() => undefined);
      LIVE_TEMP_PATHS.delete(tempPath);
      throw error;
    }
  }

  private async openSourceVideo(candidate: string, storageRoot: string): Promise<OpenSourceVideo> {
    if (typeof candidate !== "string" || path.extname(candidate).toLowerCase() !== ".mp4") {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    const candidatePath = path.resolve(candidate);

    let handle: FileHandle | undefined;
    try {
      const canonicalPath = await realpath(candidatePath);
      if (!isInside(storageRoot, canonicalPath, false)) throw new PublishingAssetError("publish_video_unreadable");
      handle = await open(canonicalPath, "r");
      const initialStats = await handle.stat();
      const pathStats = await lstat(canonicalPath);
      if (
        pathStats.isSymbolicLink()
        || !initialStats.isFile()
        || initialStats.size === 0
        || !sameIdentity(initialStats, pathStats)
      ) {
        throw new PublishingAssetError(initialStats.size === 0 ? "publish_video_missing" : "publish_video_unreadable");
      }
      return {
        path: canonicalPath,
        handle,
        initialStats,
        initialSha256: await hashFileHandle(handle, initialStats.size),
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof PublishingAssetError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PublishingAssetError("publish_video_missing");
      }
      throw new PublishingAssetError("publish_video_unreadable");
    }
  }

  private async cloneOrCopyVerified(
    source: OpenSourceVideo,
    destination: string,
    context: RootContext,
    destinationParentIdentity: FileIdentity,
  ): Promise<PackageVideoMethod> {
    await this.assertRootAndDirectory(context, path.dirname(destination), destinationParentIdentity);
    try {
      await this.copyFile(source.path, destination, constants.COPYFILE_FICLONE_FORCE);
    } catch {
      await this.assertRootAndDirectory(context, path.dirname(destination), destinationParentIdentity);
      try {
        await this.copyFile(source.path, destination);
      } catch (error) {
        throw normalizeAssetError(error, "publish_clone_failed");
      }
      await this.verifyCopiedVideo(source, destination, context, destinationParentIdentity);
      return "copy";
    }
    await this.verifyCopiedVideo(source, destination, context, destinationParentIdentity);
    return "clone";
  }

  private async verifyCopiedVideo(
    source: OpenSourceVideo,
    destination: string,
    context: RootContext,
    destinationParentIdentity: FileIdentity,
  ): Promise<void> {
    await this.assertRootAndDirectory(context, path.dirname(destination), destinationParentIdentity);
    const currentSourceStats = await source.handle.stat();
    const sourcePathStats = await lstat(source.path);
    if (
      !sameIdentity(source.initialStats, currentSourceStats)
      || !sameIdentity(source.initialStats, sourcePathStats)
      || sourceMetadataChanged(source.initialStats, currentSourceStats)
    ) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    const currentSourceHash = await hashFileHandle(source.handle, currentSourceStats.size);
    const destinationHash = await hashFilePath(destination);
    if (currentSourceHash !== source.initialSha256 || destinationHash !== source.initialSha256) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    await this.assertRootAndDirectory(context, path.dirname(destination), destinationParentIdentity);
  }

  private async prepareCover(
    sourceCoverPath: string | undefined,
    sourceVideoPath: string,
    tempPath: string,
    context: RootContext,
    tempIdentity: FileIdentity,
  ): Promise<string | undefined> {
    const coverPath = path.join(tempPath, "cover.jpg");
    if (sourceCoverPath) {
      try {
        const source = await resolveReadableFile(context.storageRoot, sourceCoverPath);
        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
        await this.copyFile(source, coverPath);
        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
        return coverPath;
      } catch {
        await this.safeRemoveDirect(context, tempPath, tempIdentity, coverPath).catch(() => undefined);
      }
    }

    try {
      await this.assertRootAndDirectory(context, tempPath, tempIdentity);
      await this.runCommand("ffmpeg", [
        "-y", "-ss", "1", "-i", sourceVideoPath,
        "-frames:v", "1", "-q:v", "2", coverPath,
      ], { timeoutMs: 30_000 });
      await this.assertRootAndDirectory(context, tempPath, tempIdentity);
      const coverStats = await lstat(coverPath);
      await access(coverPath, constants.R_OK);
      if (coverStats.isSymbolicLink() || !coverStats.isFile() || coverStats.size === 0) throw new Error("empty cover");
      return coverPath;
    } catch {
      await this.safeRemoveDirect(context, tempPath, tempIdentity, coverPath).catch(() => undefined);
      return undefined;
    }
  }

  private async removeStaleTemporaryPaths(
    context: RootContext,
    failures: PublishingRecoveryFailure[],
  ): Promise<string[]> {
    const candidates: Array<{ path: string; identity: FileIdentity; parent: string; parentIdentity: FileIdentity }> = [];
    await walkManagedDirectories(context.publishingRoot, async (directory, entry, parentIdentity) => {
      if (!entry.name.startsWith(".next-")) return;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        failures.push(recoveryFailure(new PublishingAssetError("publish_video_unreadable"), { path: candidate }));
        return;
      }
      if (!entry.isDirectory() || LIVE_TEMP_PATHS.has(candidate)) return;
      const candidateStats = await lstat(candidate);
      if (this.now().getTime() - candidateStats.mtimeMs < TEMP_STALE_MS) return;
      candidates.push({ path: candidate, identity: candidateStats, parent: directory, parentIdentity });
    });

    candidates.sort((a, b) => b.path.length - a.path.length);
    const removed: string[] = [];
    for (const candidate of candidates) {
      try {
        await this.safeRemoveDirect(
          context,
          candidate.parent,
          candidate.parentIdentity,
          candidate.path,
          candidate.identity,
        );
        removed.push(candidate.path);
      } catch (error) {
        failures.push(recoveryFailure(error, { path: candidate.path }));
      }
    }
    return removed;
  }

  private async withAssetLock<T>(operation: (context: RootContext) => Promise<T>): Promise<T> {
    const storageRoot = await realpath(this.deps.storageRoot);
    return withProcessLock(storageRoot, async () => {
      const context = await prepareRootContext(storageRoot);
      return operation(context);
    });
  }

  private async assertRootAndDirectory(
    context: RootContext,
    directory: string,
    identity: FileIdentity,
  ): Promise<void> {
    await requireMatchingDirectory(context.publishingRoot, context.publishingIdentity);
    await requireSafeDirectoryChain(context.publishingRoot, directory);
    await requireMatchingDirectory(directory, identity);
  }

  private async safeRenameDirect(
    context: RootContext,
    parent: string,
    parentIdentity: FileIdentity,
    source: string,
    destination: string,
    sourceIdentity: FileIdentity,
  ): Promise<void> {
    assertDirectChild(parent, source);
    assertDirectChild(parent, destination);
    await this.assertRootAndDirectory(context, parent, parentIdentity);
    await requireMatchingDirectory(source, sourceIdentity);
    if (await pathExistsNoFollow(destination)) throw new PublishingAssetError("publish_revision_conflict");
    await this.rename(source, destination);
    await this.assertRootAndDirectory(context, parent, parentIdentity);
    await requireMatchingDirectory(destination, sourceIdentity);
  }

  private async safeRemoveDirect(
    context: RootContext,
    parent: string,
    parentIdentity: FileIdentity | undefined,
    target: string,
    targetIdentity?: FileIdentity,
  ): Promise<void> {
    assertDirectChild(parent, target);
    await requireMatchingDirectory(context.publishingRoot, context.publishingIdentity);
    await requireSafeDirectoryChain(context.publishingRoot, parent);
    const currentParentIdentity = parentIdentity ?? await requireDirectoryIdentity(parent);
    await requireMatchingDirectory(parent, currentParentIdentity);
    const targetStats = await optionalLstat(target);
    if (targetStats?.isSymbolicLink()) throw new PublishingAssetError("publish_video_unreadable");
    if (targetStats && targetIdentity && !sameIdentity(targetStats, targetIdentity)) {
      throw new PublishingAssetError("publish_revision_conflict");
    }
    await this.rm(target, { recursive: true, force: true });
    await requireMatchingDirectory(context.publishingRoot, context.publishingIdentity);
    await requireMatchingDirectory(parent, currentParentIdentity);
  }
}

async function prepareRootContext(storageRoot: string): Promise<RootContext> {
  const storageStats = await lstat(storageRoot);
  if (storageStats.isSymbolicLink() || !storageStats.isDirectory()) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  const output = await ensureDirectDirectory(storageRoot, storageStats, "output");
  const outputPath = path.join(storageRoot, "output");
  const publishingIdentity = await ensureDirectDirectory(outputPath, output, "publishing");
  return {
    storageRoot,
    publishingRoot: path.join(outputPath, "publishing"),
    publishingIdentity,
  };
}

async function ensureDirectDirectory(
  parent: string,
  parentIdentity: FileIdentity,
  name: string,
): Promise<FileIdentity> {
  validateSegment(name);
  await requireMatchingDirectory(parent, parentIdentity);
  const target = path.join(parent, name);
  let targetStats = await optionalLstat(target);
  if (!targetStats) {
    await mkdir(target);
    targetStats = await lstat(target);
  }
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory() || await realpath(target) !== target) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  await requireMatchingDirectory(parent, parentIdentity);
  return targetStats;
}

async function requireDirectDirectory(
  parent: string,
  parentIdentity: FileIdentity,
  name: string,
): Promise<FileIdentity> {
  validateSegment(name);
  await requireMatchingDirectory(parent, parentIdentity);
  const target = path.join(parent, name);
  const targetStats = await lstat(target);
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory() || await realpath(target) !== target) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  return targetStats;
}

async function requireExpectedPackage(
  context: RootContext,
  pkg: DeliveryPackage,
  mustExist: boolean,
): Promise<{ path: string; identity: FileIdentity }> {
  const expected = expectedPackagePathFromRecord(context.publishingRoot, pkg);
  assertDeclaredPackagePaths(expected, pkg);
  if (!mustExist && !await pathExistsNoFollow(expected)) {
    return { path: expected, identity: { dev: -1, ino: -1 } };
  }
  const sourceIdentity = await requireDirectDirectory(
    context.publishingRoot,
    context.publishingIdentity,
    pkg.sourceJobId,
  );
  await requireMatchingDirectory(context.publishingRoot, context.publishingIdentity);
  const packageStats = await lstat(expected);
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory() || await realpath(expected) !== expected) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  await requireMatchingDirectory(path.dirname(expected), sourceIdentity);
  if (path.resolve(pkg.packagePath) !== expected && await realpath(pkg.packagePath) !== expected) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  const expectedVideo = path.join(expected, "video.mp4");
  if (!pkg.videoPath || path.resolve(pkg.videoPath) !== expectedVideo) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  return { path: expected, identity: packageStats };
}

function expectedPackagePathFromRecord(publishingRoot: string, pkg: DeliveryPackage): string {
  validateSegment(pkg.sourceJobId);
  validateSegment(pkg.id);
  validateVersion(pkg.version);
  return expectedPackagePath(publishingRoot, pkg.sourceJobId, pkg.version, pkg.id);
}

function expectedPackagePath(
  publishingRoot: string,
  sourceJobId: string,
  version: number,
  packageId: string,
): string {
  return path.join(publishingRoot, sourceJobId, `v${version}-${packageId}`);
}

function assertDeclaredPackagePaths(expected: string, pkg: DeliveryPackage): void {
  const declaredPackage = path.resolve(pkg.packagePath);
  const declaredVideo = pkg.videoPath ? path.resolve(pkg.videoPath) : "";
  if (declaredPackage !== expected || declaredVideo !== path.join(expected, "video.mp4")) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
}

async function writePlatformProjection(root: string, tasks: PublishTask[]): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const task of tasks) {
    const platformPath = path.join(root, task.platform);
    await mkdir(platformPath);
    await Promise.all([
      writeFile(path.join(platformPath, "title.txt"), task.title, "utf8"),
      writeFile(path.join(platformPath, "description.txt"), task.description, "utf8"),
      writeFile(path.join(platformPath, "hashtags.txt"), task.hashtags.map((tag) => `#${tag}`).join(" "), "utf8"),
      writeFile(path.join(platformPath, "publish.txt"), buildPublishText(task), "utf8"),
    ]);
  }
}

function projectionContents(tasks: PublishTask[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const task of tasks) {
    files.set(path.join(task.platform, "title.txt"), Buffer.from(task.title));
    files.set(path.join(task.platform, "description.txt"), Buffer.from(task.description));
    files.set(path.join(task.platform, "hashtags.txt"), Buffer.from(task.hashtags.map((tag) => `#${tag}`).join(" ")));
    files.set(path.join(task.platform, "publish.txt"), Buffer.from(buildPublishText(task)));
  }
  return files;
}

function projectionMatchesSnapshot(snapshot: DirectorySnapshot | undefined, tasks: PublishTask[]): boolean {
  if (!snapshot) return false;
  const expected = projectionContents(tasks);
  if (snapshot.files.size !== expected.size) return false;
  for (const [relativePath, expectedBytes] of expected) {
    if (!snapshot.files.get(relativePath)?.equals(expectedBytes)) return false;
  }
  return true;
}

async function snapshotManagedDirectory(
  parent: string,
  parentIdentity: FileIdentity,
  root: string,
): Promise<DirectorySnapshot | undefined> {
  assertDirectChild(parent, root);
  await requireMatchingDirectory(parent, parentIdentity);
  const rootStats = await optionalLstat(root);
  if (!rootStats) return undefined;
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || await realpath(root) !== root) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  const directories: string[] = [];
  const files = new Map<string, Buffer>();

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isSymbolicLink()) throw new PublishingAssetError("publish_video_unreadable");
      if (entry.isDirectory()) {
        directories.push(relativePath);
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.set(relativePath, await readFile(fullPath));
      } else {
        throw new PublishingAssetError("publish_video_unreadable");
      }
    }
  }
  await visit(root);
  await requireMatchingDirectory(parent, parentIdentity);
  await requireMatchingDirectory(root, rootStats);
  return { directories: directories.sort(), files };
}

function fingerprintSnapshot(snapshot: DirectorySnapshot | undefined): string {
  const hash = createHash("sha256");
  if (!snapshot) return hash.update("missing").digest("hex");
  for (const directory of snapshot.directories) hash.update(`d:${directory}\0`);
  for (const [relativePath, bytes] of [...snapshot.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`f:${relativePath}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function findOrphanPackages(
  context: RootContext,
  index: PublishingIndex,
  failures: PublishingRecoveryFailure[],
): Promise<string[]> {
  const known = new Set<string>();
  for (const pkg of Object.values(index.packages)) {
    try {
      known.add(expectedPackagePathFromRecord(context.publishingRoot, pkg));
    } catch (error) {
      failures.push(recoveryFailure(error, { packageId: pkg.id }));
    }
  }
  const orphans: string[] = [];
  for (const sourceEntry of await readdir(context.publishingRoot, { withFileTypes: true })) {
    const sourcePath = path.join(context.publishingRoot, sourceEntry.name);
    if (sourceEntry.isSymbolicLink()) {
      failures.push(recoveryFailure(new PublishingAssetError("publish_video_unreadable"), { path: sourcePath }));
      continue;
    }
    if (!sourceEntry.isDirectory() || sourceEntry.name.startsWith(".")) continue;
    for (const packageEntry of await readdir(sourcePath, { withFileTypes: true })) {
      const packagePath = path.join(sourcePath, packageEntry.name);
      if (packageEntry.isSymbolicLink()) {
        failures.push(recoveryFailure(new PublishingAssetError("publish_video_unreadable"), { path: packagePath }));
        continue;
      }
      if (packageEntry.isDirectory() && /^v\d+-/u.test(packageEntry.name) && !known.has(packagePath)) {
        orphans.push(packagePath);
      }
    }
  }
  return orphans;
}

async function walkManagedDirectories(
  root: string,
  visit: (directory: string, entry: Dirent<string>, parentIdentity: FileIdentity) => Promise<void>,
): Promise<void> {
  const rootIdentity = await requireDirectoryIdentity(root);
  async function walk(directory: string, directoryIdentity: FileIdentity): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      await visit(directory, entry, directoryIdentity);
      if (!entry.isDirectory() || entry.name.startsWith(".next-")) continue;
      const child = path.join(directory, entry.name);
      const childIdentity = await requireDirectoryIdentity(child);
      await walk(child, childIdentity);
    }
    await requireMatchingDirectory(directory, directoryIdentity);
  }
  await walk(root, rootIdentity);
}

async function resolveReadableFile(storageRoot: string, candidate: string): Promise<string> {
  const candidatePath = path.resolve(candidate);
  const canonicalPath = await realpath(candidatePath);
  if (!isInside(storageRoot, canonicalPath, false)) throw new PublishingAssetError("publish_video_unreadable");
  const fileStats = await lstat(canonicalPath);
  await access(canonicalPath, constants.R_OK);
  if (fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size === 0) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  return canonicalPath;
}

async function isReadableDirectFile(
  parent: string,
  parentIdentity: FileIdentity,
  candidate: string,
): Promise<boolean> {
  try {
    assertDirectChild(parent, candidate);
    await requireMatchingDirectory(parent, parentIdentity);
    const fileStats = await lstat(candidate);
    await access(candidate, constants.R_OK);
    return !fileStats.isSymbolicLink() && fileStats.isFile() && fileStats.size > 0 && await realpath(candidate) === candidate;
  } catch {
    return false;
  }
}

async function hashFileHandle(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== size) throw new PublishingAssetError("publish_video_unreadable");
  return hash.digest("hex");
}

async function hashFilePath(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const fileStats = await handle.stat();
    const pathStats = await lstat(filePath);
    if (!fileStats.isFile() || pathStats.isSymbolicLink() || !sameIdentity(fileStats, pathStats)) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    return await hashFileHandle(handle, fileStats.size);
  } finally {
    await handle.close();
  }
}

function sourceMetadataChanged(before: Stats, after: Stats): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
}

function validateProjectionTasks(packageId: string, tasks: PublishTask[]): void {
  const platforms = new Set<string>();
  for (const task of tasks) {
    if (task.packageId !== packageId || !APPROVED_PLATFORMS.has(task.platform) || platforms.has(task.platform)) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    platforms.add(task.platform);
  }
}

function validateSegment(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new PublishingAssetError("publish_video_unreadable");
}

function validateVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new PublishingAssetError("publish_video_unreadable");
}

function assertDirectChild(parent: string, candidate: string): void {
  if (path.dirname(candidate) !== parent || !isInside(parent, candidate, false)) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
}

function isInside(root: string, candidate: string, allowRoot: boolean): boolean {
  const relative = path.relative(root, candidate);
  return !(!allowRoot && relative === "")
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function requireSafeDirectoryChain(root: string, target: string): Promise<void> {
  if (target === root) return;
  if (!isInside(root, target, false)) throw new PublishingAssetError("publish_video_unreadable");
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const currentStats = await lstat(current);
    if (currentStats.isSymbolicLink() || !currentStats.isDirectory() || await realpath(current) !== current) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
  }
}

async function requireDirectoryIdentity(candidate: string): Promise<FileIdentity> {
  const candidateStats = await lstat(candidate);
  if (candidateStats.isSymbolicLink() || !candidateStats.isDirectory() || await realpath(candidate) !== candidate) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  return candidateStats;
}

async function requireMatchingDirectory(candidate: string, expected: FileIdentity): Promise<void> {
  const current = await requireDirectoryIdentity(candidate);
  if (!sameIdentity(current, expected)) throw new PublishingAssetError("publish_revision_conflict");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function optionalLstat(candidate: string): Promise<Stats | undefined> {
  try {
    return await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function pathExistsNoFollow(candidate: string): Promise<boolean> {
  return (await optionalLstat(candidate)) !== undefined;
}

async function withProcessLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = ASSET_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  ASSET_LOCKS.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ASSET_LOCKS.get(key) === tail) ASSET_LOCKS.delete(key);
  }
}

function recoveryFailure(
  error: unknown,
  fields: { packageId?: string; path?: string },
): PublishingRecoveryFailure {
  const normalized = normalizeAssetError(error, "publish_video_unreadable");
  return {
    ...fields,
    code: normalized.code,
    message: normalized.message,
  };
}

function normalizeAssetError(
  error: unknown,
  fallback: PublishingAssetErrorCode = "publish_clone_failed",
): PublishingAssetError {
  if (error instanceof PublishingAssetError) return error;
  if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
    return new PublishingAssetError("publish_storage_full");
  }
  return new PublishingAssetError(fallback);
}

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}
