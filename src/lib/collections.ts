import { randomUUID } from "node:crypto";
import { crawlUserPage } from "./user-page-crawler.js";
import type {
  CrawlUserPageResult,
  DouyinVideoItem,
  UserPageCrawlerConfig,
} from "./user-page-crawler.js";
import type { LocalStorage } from "./storage.js";
import type { JobRecord, PipelineStep } from "../types.js";

const COLLECTIONS_INDEX = "cache/collections-index.json";

export interface CollectionRecord {
  id: string;
  sourcePageUrl: string;
  secUid: string;
  nickname: string;
  avatarUrl: string;
  crawlResult: {
    items: DouyinVideoItem[];
    totalCollected: number;
    hasMore: boolean;
    nextCursor: number;
  };
  childJobIds: string[];
  skillName?: string;
  skillPath?: string;
  autoSyncSkill?: boolean;
  skillGeneratedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionOverview extends CollectionRecord {
  childJobProgress: {
    total: number;
    transcribed: number;
    cleaned: number;
    scripted: number;
    rendered: number;
    failed: number;
  };
}

type CollectionsIndex = Record<string, CollectionRecord>;

export class CollectionStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly jobStore: {
      create(input: { sourceUrl?: string; shareText?: string; topic?: string; coverUrl?: string }): Promise<JobRecord>;
      get(id: string): Promise<JobRecord | null>;
    },
    private readonly crawlerConfig: UserPageCrawlerConfig = {}
  ) {}

  async init(): Promise<void> {
    try {
      await this.storage.readJson<CollectionsIndex>(COLLECTIONS_INDEX);
    } catch {
      await this.storage.writeJson(COLLECTIONS_INDEX, {});
    }
  }

  /**
   * 创建合集（包含爬取用户主页）
   */
  async create(pageUrl: string, maxItems: number = 100): Promise<{
    collection: CollectionRecord;
    crawlResult: CrawlUserPageResult;
  }> {
    const crawlResult = await crawlUserPage(pageUrl, maxItems, this.crawlerConfig);
    const now = new Date().toISOString();
    const id = randomUUID();

    const record: CollectionRecord = {
      id,
      sourcePageUrl: pageUrl,
      secUid: crawlResult.userInfo.secUid,
      nickname: crawlResult.userInfo.nickname,
      avatarUrl: crawlResult.userInfo.avatarUrl,
      crawlResult: {
        items: crawlResult.items,
        totalCollected: crawlResult.totalCollected,
        hasMore: crawlResult.hasMore,
        nextCursor: crawlResult.nextCursor,
      },
      childJobIds: [],
      createdAt: now,
      updatedAt: now,
    };

    const index = await this.readIndex();
    index[id] = record;
    await this.writeIndex(index);

    return { collection: record, crawlResult };
  }

  /**
   * 增量更新合集 — 爬取新视频并去重追加到已有合集
   */
  async update(collectionId: string): Promise<{
    collection: CollectionRecord;
    newItemsCount: number;
  }> {
    const existing = await this.get(collectionId);
    if (!existing) {
      throw new Error("collection not found");
    }

    const pageUrl = existing.sourcePageUrl;
    // 重新爬取（增量检测不需要太多，50 条足以覆盖新内容）
    const crawlResult = await crawlUserPage(pageUrl, 50, this.crawlerConfig);

    // 用 awemeId 去重
    const existingIds = new Set(existing.crawlResult.items.map((item) => item.awemeId));
    const newItems = crawlResult.items.filter((item) => !existingIds.has(item.awemeId));

    if (newItems.length > 0) {
      existing.crawlResult.items.push(...newItems);
      existing.crawlResult.totalCollected = existing.crawlResult.items.length;
      existing.crawlResult.hasMore = crawlResult.hasMore;
      existing.crawlResult.nextCursor = crawlResult.nextCursor;
    }

    existing.updatedAt = new Date().toISOString();

    const index = await this.readIndex();
    index[collectionId] = existing;
    await this.writeIndex(index);

    return { collection: existing, newItemsCount: newItems.length };
  }

  /**
   * 将爬取结果中的选中视频批量创建为子任务
   */
  async createChildJobs(
    collectionId: string,
    selectedAwemeIds: string[],
    topic: string = ""
  ): Promise<{ collection: CollectionRecord; createdJobs: JobRecord[] }> {
    const collection = await this.get(collectionId);
    if (!collection) {
      throw new Error("collection not found");
    }

    const selectedSet = new Set(selectedAwemeIds);
    const selectedItems = collection.crawlResult.items.filter((item) =>
      selectedSet.has(item.awemeId)
    );

    if (selectedItems.length === 0) {
      throw new Error("no matching videos found in collection");
    }

    // 去重：跳过已经创建过的
    const existingIds = new Set(collection.childJobIds);
    const toCreate = selectedItems.filter(
      (_, idx) => !existingIds.has(`${collectionId}-${idx}`)
    );

    const createdJobs: JobRecord[] = [];
    const newJobIds: string[] = [];

    for (const item of toCreate) {
      const videoShareUrl = `https://www.douyin.com/video/${item.awemeId}`;
      const jobTopic = topic || item.desc.slice(0, 48) || collection.nickname;

      try {
        const job = await this.jobStore.create({
          sourceUrl: videoShareUrl,
          topic: jobTopic,
          coverUrl: item.coverUrl,
        });
        createdJobs.push(job);
        newJobIds.push(job.id);
      } catch (error) {
        // 单个子任务创建失败不影响整体
        console.warn(`Failed to create child job for aweme ${item.awemeId}:`, error);
      }
    }

    const index = await this.readIndex();
    const current = index[collectionId];
    if (current) {
      current.childJobIds = [...current.childJobIds, ...newJobIds];
      current.updatedAt = new Date().toISOString();
      index[collectionId] = current;
      await this.writeIndex(index);
    }

    return {
      collection: (await this.get(collectionId))!,
      createdJobs,
    };
  }

  /**
   * 获取合集详情（含子任务进度汇总）
   */
  async getOverview(collectionId: string): Promise<CollectionOverview | null> {
    const collection = await this.get(collectionId);
    if (!collection) return null;

    const progress = {
      total: collection.childJobIds.length,
      transcribed: 0,
      cleaned: 0,
      scripted: 0,
      rendered: 0,
      failed: 0,
    };

    for (const jobId of collection.childJobIds) {
      const job = await this.jobStore.get(jobId);
      if (!job) continue;

      if (job.stage === "transcribed" || job.steps?.transcribe?.status === "succeeded") {
        progress.transcribed++;
      }
      if (job.stage === "cleaned" || job.steps?.clean?.status === "succeeded") {
        progress.cleaned++;
      }
      if (job.stage === "scripted" || job.steps?.generate_video_prompts?.status === "succeeded") {
        progress.scripted++;
      }
      if (job.status === "done" || job.steps?.generate_video?.status === "succeeded") {
        progress.rendered++;
      }
      if (job.status === "failed" || job.stage === "failed") {
        progress.failed++;
      }
    }

    return {
      ...collection,
      childJobProgress: progress,
    };
  }

  async get(id: string): Promise<CollectionRecord | null> {
    const index = await this.readIndex();
    return index[id] ?? null;
  }

  async list(): Promise<CollectionRecord[]> {
    const index = await this.readIndex();
    return Object.values(index).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async listOverviews(): Promise<CollectionOverview[]> {
    const collections = await this.list();
    const overviews = await Promise.all(
      collections.map((c) => this.getOverview(c.id))
    );
    return overviews.filter((o): o is CollectionOverview => o !== null);
  }

  async delete(id: string): Promise<boolean> {
    const index = await this.readIndex();
    if (!index[id]) return false;

    delete index[id];
    await this.writeIndex(index);

    // 清理爬取缓存
    try {
      await this.storage.writeJson(
        `cache/collections-${id}.json`,
        null
      );
    } catch {
      // 忽略清理错误
    }

    return true;
  }

  /**
   * 获取合集中某个视频项的关联子任务状态
   */
  async getChildJobForItem(
    collectionId: string,
    awemeId: string
  ): Promise<JobRecord | null> {
    const collection = await this.get(collectionId);
    if (!collection) return null;

    const itemIndex = collection.crawlResult.items.findIndex(
      (item) => item.awemeId === awemeId
    );
    if (itemIndex < 0 || itemIndex >= collection.childJobIds.length) return null;

    const jobId = collection.childJobIds[itemIndex];
    return this.jobStore.get(jobId);
  }

  /**
   * 更新合集 Skill 元信息
   */
  async updateSkillMeta(
    id: string,
    meta: { skillName: string; skillPath: string; skillGeneratedAt: string; autoSyncSkill?: boolean }
  ): Promise<CollectionRecord | null> {
    const index = await this.readIndex();
    const record = index[id];
    if (!record) return null;

    record.skillName = meta.skillName;
    record.skillPath = meta.skillPath;
    record.skillGeneratedAt = meta.skillGeneratedAt;
    if (meta.autoSyncSkill !== undefined) {
      record.autoSyncSkill = meta.autoSyncSkill;
    }
    record.updatedAt = new Date().toISOString();
    index[id] = record;
    await this.writeIndex(index);
    return record;
  }

  /**
   * 切换自动同步 Skill 开关
   */
  async toggleAutoSyncSkill(id: string, enabled: boolean): Promise<CollectionRecord | null> {
    const index = await this.readIndex();
    const record = index[id];
    if (!record) return null;

    record.autoSyncSkill = enabled;
    record.updatedAt = new Date().toISOString();
    index[id] = record;
    await this.writeIndex(index);
    return record;
  }

  private async readIndex(): Promise<CollectionsIndex> {
    return this.storage.readJson<CollectionsIndex>(COLLECTIONS_INDEX);
  }

  private async writeIndex(index: CollectionsIndex): Promise<void> {
    await this.storage.writeJson(COLLECTIONS_INDEX, index);
  }
}
