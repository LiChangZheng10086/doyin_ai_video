import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  rollback(): Promise<void>;
}

export interface PublishingRecoveryReport {
  removedTempPaths: string[];
  orphanPaths: string[];
  repairedPackageIds: string[];
  brokenPackageIds: string[];
  notifications: DueNotification[];
  purgedPackageIds: string[];
  purgeFailures: Array<{ packageId: string; message: string }>;
}

type PublishingAssetErrorCode =
  | "publish_clone_failed"
  | "publish_storage_full"
  | "publish_video_missing"
  | "publish_video_unreadable";

const ERROR_MESSAGES: Record<PublishingAssetErrorCode, string> = {
  publish_clone_failed: "成片复制失败，请检查磁盘空间和文件权限",
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

type DirectorySnapshot = {
  directories: string[];
  files: Map<string, Buffer>;
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
    if (!Number.isSafeInteger(input.version) || input.version < 1) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    validateTasks(input);

    const sourceVideoPath = await this.resolveReadableSourceVideo(input.sourceVideoPath);
    const sourceDirectory = path.join(
      path.resolve(this.deps.storageRoot),
      "output",
      "publishing",
      input.sourceJobId,
    );
    const tempPath = path.join(sourceDirectory, `.next-${input.packageId}`);
    const packagePath = path.join(sourceDirectory, `v${input.version}-${input.packageId}`);
    const videoPath = path.join(tempPath, "video.mp4");
    let promoted = false;

    try {
      await mkdir(sourceDirectory, { recursive: true });
      await this.rm(tempPath, { recursive: true, force: true });
      if (await pathExists(packagePath)) throw new PublishingAssetError("publish_clone_failed");
      await mkdir(tempPath, { recursive: true });

      const videoMethod = await this.cloneOrCopy(sourceVideoPath, videoPath);
      const videoStats = await stat(videoPath);
      if (!videoStats.isFile() || videoStats.size === 0) {
        throw new PublishingAssetError("publish_clone_failed");
      }
      const videoSha256 = await hashFile(videoPath);
      const coverPath = await this.prepareCover(input.sourceCoverPath, sourceVideoPath, tempPath);
      const assetHealth: PublishAssetHealth = coverPath ? "healthy" : "missing_cover";

      await writePlatformProjection(path.join(tempPath, "platforms"), input.tasks);
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
        cover: coverPath ? { path: "cover.jpg" } : null,
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

      await this.rename(tempPath, packagePath);
      promoted = true;
      const formalVideoPath = path.join(packagePath, "video.mp4");
      const formalCoverPath = coverPath ? path.join(packagePath, "cover.jpg") : undefined;
      let rolledBack = false;

      return {
        packagePath,
        videoPath: formalVideoPath,
        coverPath: formalCoverPath,
        videoSha256,
        videoSize: videoStats.size,
        videoMethod,
        assetHealth,
        rollback: async () => {
          if (rolledBack) return;
          rolledBack = true;
          await this.rm(packagePath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await this.rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
      if (promoted) await this.rm(packagePath, { recursive: true, force: true }).catch(() => undefined);
      throw normalizeAssetError(error);
    }
  }

  async stageTextProjection(detail: PublishingPackageDetail): Promise<ProjectionTransaction> {
    validateProjectionTasks(detail.package.id, detail.tasks);
    const packagePath = await this.resolveExistingPackagePath(detail.package.packagePath);
    const targetPath = path.join(packagePath, "platforms");
    if (await pathExists(targetPath)) await this.assertDirectChildDirectory(packagePath, targetPath);
    const tempPath = path.join(packagePath, `.next-platforms-${randomUUID()}`);
    const previous = await snapshotDirectory(targetPath);
    await writePlatformProjection(tempPath, detail.tasks);
    let state: "staged" | "committed" | "rolled_back" = "staged";

    return {
      commit: async () => {
        if (state === "committed") return;
        if (state === "rolled_back") throw new Error("投影事务已回滚");
        const displacedPath = path.join(packagePath, `.previous-platforms-${randomUUID()}`);
        const hadTarget = await pathExists(targetPath);
        if (hadTarget) await this.rename(targetPath, displacedPath);
        try {
          await this.rename(tempPath, targetPath);
          state = "committed";
          await this.rm(displacedPath, { recursive: true, force: true });
        } catch (error) {
          if (hadTarget && await pathExists(displacedPath)) {
            await this.rename(displacedPath, targetPath).catch(() => undefined);
          }
          throw error;
        }
      },
      rollback: async () => {
        if (state === "rolled_back") return;
        if (state === "staged") {
          await this.rm(tempPath, { recursive: true, force: true });
          state = "rolled_back";
          return;
        }

        const restorePath = path.join(packagePath, `.next-platforms-restore-${randomUUID()}`);
        const displacedPath = path.join(packagePath, `.previous-platforms-rollback-${randomUUID()}`);
        if (previous) await restoreSnapshot(restorePath, previous);
        await this.rename(targetPath, displacedPath);
        try {
          if (previous) await this.rename(restorePath, targetPath);
          await this.rm(displacedPath, { recursive: true, force: true });
          state = "rolled_back";
        } catch (error) {
          if (await pathExists(displacedPath)) {
            await this.rename(displacedPath, targetPath).catch(() => undefined);
          }
          await this.rm(restorePath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      },
    };
  }

  async verifyPackageVideo(pkg: DeliveryPackage): Promise<PublishAssetHealth> {
    try {
      if (!pkg.videoPath || path.basename(pkg.videoPath).toLowerCase() !== "video.mp4") return "broken_video";
      const packagePath = await this.resolveExistingPackagePath(pkg.packagePath);
      const videoPath = path.resolve(pkg.videoPath);
      assertInside(packagePath, videoPath, false);
      const canonicalPackagePath = await realpath(packagePath);
      const canonicalVideoPath = await realpath(videoPath);
      assertInside(canonicalPackagePath, canonicalVideoPath, false);
      const videoStats = await stat(canonicalVideoPath);
      await access(canonicalVideoPath, constants.R_OK);
      if (!videoStats.isFile() || videoStats.size === 0 || videoStats.size !== pkg.videoSize) return "broken_video";
      if (await hashFile(canonicalVideoPath) !== pkg.videoSha256) return "broken_video";

      if (!pkg.coverPath || !await isReadableFileInside(packagePath, pkg.coverPath)) return "missing_cover";
      return "healthy";
    } catch {
      return "broken_video";
    }
  }

  async purgeAssets(pkg: DeliveryPackage): Promise<void> {
    const packagePath = this.assertPackagePath(pkg.packagePath);
    if (await pathExists(packagePath)) await this.resolveExistingPackagePath(packagePath);
    await this.rm(packagePath, { recursive: true, force: true });
  }

  async scanAndRepair(index: PublishingIndex): Promise<PublishingRecoveryReport> {
    const publishingRoot = path.join(path.resolve(this.deps.storageRoot), "output", "publishing");
    await mkdir(publishingRoot, { recursive: true });
    const removedTempPaths = await this.removeTemporaryPaths(publishingRoot);
    const orphanPaths = await findOrphanPackages(publishingRoot, index);
    const repairedPackageIds: string[] = [];
    const brokenPackageIds: string[] = [];
    const packageIds = Object.keys(index.packages).sort();

    for (const packageId of packageIds) {
      const pkg = index.packages[packageId];
      if (pkg.state !== "active") continue;
      const health = await this.verifyPackageVideo(pkg);
      pkg.assetHealth = health;
      if (health === "broken_video") brokenPackageIds.push(packageId);
    }

    for (const packageId of packageIds) {
      const pkg = index.packages[packageId];
      if (pkg.state !== "active") continue;
      const tasks = Object.values(index.tasks)
        .filter((task) => task.packageId === packageId)
        .sort((a, b) => a.platform.localeCompare(b.platform));
      const projectionPath = path.join(pkg.packagePath, "platforms");
      if (await pathExists(pkg.packagePath) && await this.projectionNeedsRepair(pkg.packagePath, projectionPath, tasks)) {
        const transaction = await this.stageTextProjection({
          package: pkg,
          tasks,
          audit: index.audit.filter((event) => event.packageId === packageId),
        });
        await transaction.commit();
        repairedPackageIds.push(packageId);
      }
    }

    return {
      removedTempPaths: removedTempPaths.sort(),
      orphanPaths: orphanPaths.sort(),
      repairedPackageIds,
      brokenPackageIds,
      notifications: [],
      purgedPackageIds: [],
      purgeFailures: [],
    };
  }

  private async cloneOrCopy(source: string, destination: string): Promise<PackageVideoMethod> {
    try {
      await this.copyFile(source, destination, constants.COPYFILE_FICLONE);
      return "clone";
    } catch {
      try {
        await this.copyFile(source, destination);
        return "copy";
      } catch (error) {
        throw normalizeAssetError(error, "publish_clone_failed");
      }
    }
  }

  private async prepareCover(
    sourceCoverPath: string | undefined,
    sourceVideoPath: string,
    tempPath: string,
  ): Promise<string | undefined> {
    const coverPath = path.join(tempPath, "cover.jpg");
    if (sourceCoverPath) {
      try {
        const source = await this.resolveReadableFile(sourceCoverPath);
        await this.copyFile(source, coverPath);
        return coverPath;
      } catch {
        await this.rm(coverPath, { force: true }).catch(() => undefined);
      }
    }

    try {
      await this.runCommand("ffmpeg", [
        "-y", "-ss", "1", "-i", sourceVideoPath,
        "-frames:v", "1", "-q:v", "2", coverPath,
      ], { timeoutMs: 30_000 });
      const coverStats = await stat(coverPath);
      await access(coverPath, constants.R_OK);
      if (!coverStats.isFile() || coverStats.size === 0) throw new Error("empty cover");
      return coverPath;
    } catch {
      await this.rm(coverPath, { force: true }).catch(() => undefined);
      return undefined;
    }
  }

  private async resolveReadableSourceVideo(candidate: string): Promise<string> {
    if (path.extname(candidate).toLowerCase() !== ".mp4") {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    let source: string;
    try {
      source = await this.resolveReadableFile(candidate);
      const sourceStats = await stat(source);
      if (sourceStats.size === 0) throw new PublishingAssetError("publish_video_missing");
    } catch (error) {
      if (error instanceof PublishingAssetError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PublishingAssetError("publish_video_missing");
      }
      throw new PublishingAssetError("publish_video_unreadable");
    }
    return source;
  }

  private async resolveReadableFile(candidate: string): Promise<string> {
    const storageRoot = path.resolve(this.deps.storageRoot);
    const canonicalRoot = await realpath(storageRoot);
    const candidatePath = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(storageRoot, candidate);
    if (!isInside(storageRoot, candidatePath, false) && !isInside(canonicalRoot, candidatePath, false)) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    const canonicalPath = await realpath(candidatePath);
    assertInside(canonicalRoot, canonicalPath, false);
    const fileStats = await stat(canonicalPath);
    await access(canonicalPath, constants.R_OK);
    if (!fileStats.isFile() || fileStats.size === 0) throw new Error("file is not readable");
    return canonicalPath;
  }

  private assertPackagePath(candidate: string): string {
    const publishingRoot = path.join(path.resolve(this.deps.storageRoot), "output", "publishing");
    const packagePath = path.resolve(candidate);
    assertInside(publishingRoot, packagePath, false);
    return packagePath;
  }

  private async resolveExistingPackagePath(candidate: string): Promise<string> {
    const packagePath = this.assertPackagePath(candidate);
    const publishingRoot = path.join(path.resolve(this.deps.storageRoot), "output", "publishing");
    const canonicalPublishingRoot = await realpath(publishingRoot);
    const canonicalPackagePath = await realpath(packagePath);
    const expectedCanonicalPath = path.join(
      canonicalPublishingRoot,
      path.relative(publishingRoot, packagePath),
    );
    if (canonicalPackagePath !== expectedCanonicalPath) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    assertInside(canonicalPublishingRoot, canonicalPackagePath, false);
    return packagePath;
  }

  private async projectionNeedsRepair(
    packagePath: string,
    projectionPath: string,
    tasks: PublishTask[],
  ): Promise<boolean> {
    if (!await pathExists(projectionPath)) return true;
    await this.assertDirectChildDirectory(packagePath, projectionPath);
    return !await projectionMatches(projectionPath, tasks);
  }

  private async assertDirectChildDirectory(parent: string, candidate: string): Promise<void> {
    const canonicalParent = await realpath(parent);
    const canonicalCandidate = await realpath(candidate);
    const expectedCandidate = path.join(canonicalParent, path.relative(parent, candidate));
    const candidateStats = await stat(canonicalCandidate);
    if (canonicalCandidate !== expectedCandidate || !candidateStats.isDirectory()) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
  }

  private async removeTemporaryPaths(root: string): Promise<string[]> {
    const candidates: string[] = [];
    await walkDirectories(root, (directory) => {
      if (path.basename(directory).startsWith(".next-")) candidates.push(directory);
    });
    candidates.sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      await this.rm(candidate, { recursive: true, force: true });
    }
    return candidates;
  }
}

async function writePlatformProjection(root: string, tasks: PublishTask[]): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const task of tasks) {
    const platformPath = path.join(root, task.platform);
    await mkdir(platformPath, { recursive: true });
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
    const prefix = task.platform;
    files.set(path.join(prefix, "title.txt"), Buffer.from(task.title));
    files.set(path.join(prefix, "description.txt"), Buffer.from(task.description));
    files.set(path.join(prefix, "hashtags.txt"), Buffer.from(task.hashtags.map((tag) => `#${tag}`).join(" ")));
    files.set(path.join(prefix, "publish.txt"), Buffer.from(buildPublishText(task)));
  }
  return files;
}

async function projectionMatches(root: string, tasks: PublishTask[]): Promise<boolean> {
  const snapshot = await snapshotDirectory(root);
  if (!snapshot) return false;
  const expected = projectionContents(tasks);
  if (snapshot.files.size !== expected.size) return false;
  for (const [relativePath, expectedBytes] of expected) {
    if (!snapshot.files.get(relativePath)?.equals(expectedBytes)) return false;
  }
  return true;
}

async function snapshotDirectory(root: string): Promise<DirectorySnapshot | undefined> {
  if (!await pathExists(root)) return undefined;
  const directories: string[] = [];
  const files = new Map<string, Buffer>();
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        directories.push(relativePath);
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.set(relativePath, await readFile(fullPath));
      }
    }
  }
  await visit(root);
  return { directories: directories.sort(), files };
}

async function restoreSnapshot(root: string, snapshot: DirectorySnapshot): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const directory of snapshot.directories) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const [relativePath, bytes] of snapshot.files) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

async function findOrphanPackages(root: string, index: PublishingIndex): Promise<string[]> {
  const knownPaths = new Set(Object.values(index.packages).map((pkg) => path.resolve(pkg.packagePath)));
  const orphans: string[] = [];
  for (const sourceEntry of await readdir(root, { withFileTypes: true })) {
    if (!sourceEntry.isDirectory() || sourceEntry.name.startsWith(".")) continue;
    const sourcePath = path.join(root, sourceEntry.name);
    for (const packageEntry of await readdir(sourcePath, { withFileTypes: true })) {
      if (!packageEntry.isDirectory() || !/^v\d+-/u.test(packageEntry.name)) continue;
      const packagePath = path.resolve(sourcePath, packageEntry.name);
      if (!knownPaths.has(packagePath)) orphans.push(packagePath);
    }
  }
  return orphans;
}

async function walkDirectories(root: string, visit: (directory: string) => void): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root, entry.name);
    visit(fullPath);
    if (!entry.name.startsWith(".next-")) await walkDirectories(fullPath, visit);
  }
}

async function isReadableFileInside(root: string, candidate: string): Promise<boolean> {
  try {
    const rootPath = path.resolve(root);
    const candidatePath = path.resolve(candidate);
    assertInside(rootPath, candidatePath, false);
    const canonicalRoot = await realpath(rootPath);
    const canonicalCandidate = await realpath(candidatePath);
    assertInside(canonicalRoot, canonicalCandidate, false);
    const fileStats = await stat(canonicalCandidate);
    await access(canonicalCandidate, constants.R_OK);
    return fileStats.isFile() && fileStats.size > 0;
  } catch {
    return false;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function validateTasks(input: PackageAssetInput): void {
  validateProjectionTasks(input.packageId, input.tasks);
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
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
}

function assertInside(root: string, candidate: string, allowRoot: boolean): void {
  if (!isInside(root, candidate, allowRoot)) {
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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
