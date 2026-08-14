import axios, { AxiosInstance, type AxiosRequestConfig } from 'axios';
import type {
  ApiResponse,
  CleanedScript,
  CollectionOverview,
  CollectionTranscriptsResponse,
  ConfirmedPublishingAction,
  CreatePublishingPackageInput,
  CreatePublishingVersionInput,
  CrawlUserPageResult,
  DeliveryPackage,
  DueNotification,
  GenerateSkillResponse,
  HyperframesVideoOutput,
  Job,
  JobOverview,
  JobStepStreamEvent,
  LocalSessionResponse,
  LocalUserResponse,
  LocalUsersResponse,
  LocalUserSessionResponse,
  LocalUserRole,
  ParsedApiError,
  PipelineStep,
  StreamablePipelineStep,
  PublishPlatform,
  PublishingActionErrorType,
  PublishingAssetInspection,
  PublishingListFilters,
  PublishingPackageDetail,
  PublishingPreview,
  PublishTask,
  RawTranscript,
  RestoredPublishingPackage,
  UpdatePublishingContentInput,
} from '../types';
import { parseSkillProgressLine, type SkillProgressEvent } from '../utils/skill-progress';

export function parseApiError(error: unknown): ParsedApiError {
  const response = (error as {
    response?: { status?: unknown; data?: { code?: unknown; message?: unknown; details?: unknown } };
  })?.response;
  return {
    code: typeof response?.data?.code === 'string' ? response.data.code : 'request_failed',
    message: typeof response?.data?.message === 'string' && response.data.message.trim()
      ? response.data.message
      : '发布请求失败，请稍后重试',
    ...(response?.data?.details === undefined ? {} : { details: response.data.details }),
    ...(typeof response?.status === 'number' ? { status: response.status } : {}),
  };
}

export function parseJobStepStreamEvent(value: string): JobStepStreamEvent | null {
  try {
    const event = JSON.parse(value) as Partial<JobStepStreamEvent>;
    if (!Number.isFinite(event.id) || typeof event.jobId !== 'string') return null;
    if (!['clean', 'generate_video_prompts'].includes(event.step ?? '')) return null;
    if (!['started', 'preview', 'completed', 'paused', 'error'].includes(event.type ?? '')) return null;
    return event as JobStepStreamEvent;
  } catch {
    return null;
  }
}

export class ApiClient {
  private client: AxiosInstance | null = null;
  private serverPort: number | null = null;
  private localSessionToken: string | null = null;

  async initialize() {
    if (!this.serverPort) {
      // Electron 环境下获取后端端口，浏览器开发模式下使用 Vite 代理
      if (typeof window !== 'undefined' && window.electron?.getServerPort) {
        this.serverPort = await window.electron.getServerPort();
      } else {
        this.serverPort = 5173; // Vite proxy port
      }
      this.client = axios.create({
        baseURL: `http://localhost:${this.serverPort}`,
        timeout: 960000,
      });
      this.client.interceptors.request.use((request) => {
        if (this.localSessionToken) {
          request.headers.set('X-Local-Session', this.localSessionToken);
        }
        return request;
      });
    }
    return this.client!;
  }

  async getClient() {
    if (!this.client) {
      await this.initialize();
    }
    return this.client!;
  }

  setLocalSession(token: string | null): void {
    this.localSessionToken = token;
  }

  async getLocalUsers(): Promise<LocalUsersResponse> {
    const client = await this.getClient();
    const response = await client.get<LocalUsersResponse>('/api/local-users');
    return response.data;
  }

  async bootstrapLocalAdmin(displayName: string, pin: string): Promise<LocalUserSessionResponse> {
    const client = await this.getClient();
    const response = await client.post<LocalUserSessionResponse>('/api/local-users/bootstrap', { displayName, pin });
    return response.data;
  }

  async recoverLocalIdentity(confirmation: string, displayName: string, pin: string): Promise<LocalUserSessionResponse> {
    const client = await this.getClient();
    const response = await client.post<LocalUserSessionResponse>('/api/local-users/recover', { confirmation, displayName, pin });
    return response.data;
  }

  async openLocalSession(userId: string, pin?: string): Promise<LocalSessionResponse> {
    const client = await this.getClient();
    const response = await client.post<LocalSessionResponse>('/api/local-sessions', { userId, ...(pin === undefined ? {} : { pin }) });
    return response.data;
  }

  async closeLocalSession(): Promise<void> {
    const client = await this.getClient();
    await client.delete('/api/local-sessions/current');
  }

  async createLocalUser(input: { displayName: string; role: LocalUserRole; pin?: string }): Promise<LocalUserResponse> {
    const client = await this.getClient();
    const response = await client.post<LocalUserResponse>('/api/local-users', input);
    return response.data;
  }

  async updateLocalUser(id: string, input: { displayName?: string; role?: LocalUserRole; isActive?: boolean; pin?: string }): Promise<LocalUserResponse> {
    const client = await this.getClient();
    const response = await client.patch<LocalUserResponse>(`/api/local-users/${id}`, input);
    return response.data;
  }

  async resetLocalUserPin(id: string, pin: string): Promise<void> {
    const client = await this.getClient();
    await client.post(`/api/local-users/${id}/reset-pin`, { pin });
  }

  private async publishingRequest<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      const client = await this.getClient();
      return (await client.request<T>(config)).data;
    } catch (error) {
      const parsed = parseApiError(error);
      throw Object.assign(new Error(parsed.message), parsed, { name: 'PublishingApiError' });
    }
  }

  async previewPublishing(id: string, platforms: PublishPlatform[]): Promise<PublishingPreview> {
    const response = await this.publishingRequest<{ preview: PublishingPreview }>({
      method: 'POST',
      url: `/api/jobs/${id}/publishing/preview`,
      data: { platforms },
    });
    return response.preview;
  }

  async inspectPublishingAssets(id: string): Promise<PublishingAssetInspection> {
    const response = await this.publishingRequest<{ assets: PublishingAssetInspection }>({
      method: 'GET',
      url: `/api/jobs/${id}/publishing/assets`,
    });
    return response.assets;
  }

  async createPublishingPackage(
    input: CreatePublishingPackageInput,
  ): Promise<PublishingPackageDetail> {
    const response = await this.publishingRequest<{ package: PublishingPackageDetail }>({
      method: 'POST',
      url: '/api/publishing/packages',
      data: input,
    });
    return response.package;
  }

  async listPublishingPackages(
    filters: PublishingListFilters = {},
  ): Promise<PublishingPackageDetail[]> {
    const response = await this.publishingRequest<{ packages: PublishingPackageDetail[] }>({
      method: 'GET',
      url: '/api/publishing/packages',
      params: filters,
    });
    return response.packages;
  }

  async getPublishingPackage(id: string): Promise<PublishingPackageDetail> {
    const response = await this.publishingRequest<{ package: PublishingPackageDetail }>({
      method: 'GET',
      url: `/api/publishing/packages/${id}`,
    });
    return response.package;
  }

  async getPublishingCover(id: string): Promise<Blob> {
    return this.publishingRequest<Blob>({
      method: 'GET',
      url: `/api/publishing/packages/${id}/cover`,
      responseType: 'blob',
    });
  }

  async checkPublishingDue(): Promise<{ notifications: DueNotification[] }> {
    return this.publishingRequest<{ notifications: DueNotification[] }>({
      method: 'POST',
      url: '/api/publishing/due/check',
      data: {},
    });
  }

  async createPublishingVersion(
    packageId: string,
    input: CreatePublishingVersionInput,
  ): Promise<PublishingPackageDetail> {
    const response = await this.publishingRequest<{ package: PublishingPackageDetail }>({
      method: 'POST',
      url: `/api/publishing/packages/${packageId}/versions`,
      data: input,
    });
    return response.package;
  }

  async updatePublishingContent(
    taskId: string,
    input: UpdatePublishingContentInput,
  ): Promise<PublishTask> {
    const response = await this.publishingRequest<{ task: PublishTask }>({
      method: 'PATCH',
      url: `/api/publishing/tasks/${taskId}/content`,
      data: input,
    });
    return response.task;
  }

  async updatePublishingSchedule(taskId: string, scheduledAt: string | null): Promise<PublishTask> {
    const response = await this.publishingRequest<{ task: PublishTask }>({
      method: 'PATCH',
      url: `/api/publishing/tasks/${taskId}/schedule`,
      data: { scheduledAt },
    });
    return response.task;
  }

  async cancelPublishingTask(
    taskId: string,
    input: ConfirmedPublishingAction,
  ): Promise<PublishTask> {
    const response = await this.publishingRequest<{ task: PublishTask }>({
      method: 'POST',
      url: `/api/publishing/tasks/${taskId}/cancel`,
      data: input,
    });
    return response.task;
  }

  async restorePublishingTask(taskId: string, scheduledAt: string | null): Promise<PublishTask> {
    const response = await this.publishingRequest<{ task: PublishTask }>({
      method: 'POST',
      url: `/api/publishing/tasks/${taskId}/restore`,
      data: { scheduledAt },
    });
    return response.task;
  }

  async markPublishingTaskPublished(
    taskId: string,
    input: ConfirmedPublishingAction,
  ): Promise<PublishTask> {
    const response = await this.publishingRequest<{ task: PublishTask }>({
      method: 'POST',
      url: `/api/publishing/tasks/${taskId}/mark-published`,
      data: input,
    });
    return response.task;
  }

  async withdrawPublishingTask(
    taskId: string,
    input: ConfirmedPublishingAction & { reason: string },
  ): Promise<PublishTask> {
    const response = await this.publishingRequest<{ task: PublishTask }>({
      method: 'POST',
      url: `/api/publishing/tasks/${taskId}/withdraw`,
      data: input,
    });
    return response.task;
  }

  async recordPublishingFailure(taskId: string, reason: string): Promise<PublishTask> {
    const response = await this.publishingRequest<{ task: PublishTask }>({
      method: 'POST',
      url: `/api/publishing/tasks/${taskId}/record-failure`,
      data: { reason },
    });
    return response.task;
  }

  async recordPublishingActionError(
    taskId: string,
    action: PublishingActionErrorType,
    message: string,
  ): Promise<void> {
    await this.publishingRequest<void>({
      method: 'POST',
      url: `/api/publishing/tasks/${taskId}/action-error`,
      data: { action, message },
    });
  }

  async trashPublishingPackage(
    packageId: string,
    input: ConfirmedPublishingAction,
  ): Promise<DeliveryPackage> {
    const response = await this.publishingRequest<{ package: DeliveryPackage }>({
      method: 'DELETE',
      url: `/api/publishing/packages/${packageId}`,
      data: input,
    });
    return response.package;
  }

  async restorePublishingPackage(packageId: string): Promise<RestoredPublishingPackage> {
    return this.publishingRequest<RestoredPublishingPackage>({
      method: 'POST',
      url: `/api/publishing/packages/${packageId}/restore`,
      data: {},
    });
  }

  // 通用 GET 请求
  async get(url: string): Promise<any> {
    const client = await this.getClient();
    return client.get(url);
  }

  // 创建任务
  async createJob(params: {
    sourceUrl?: string;
    shareText?: string;
    topic?: string;
  }): Promise<Job> {
    const client = await this.getClient();
    const response = await client.post<ApiResponse>('/api/jobs', params);
    return response.data.job!;
  }

  // 获取任务详情
  async getJob(id: string): Promise<Job> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>(`/api/jobs/${id}`);
    return response.data.job!;
  }

  async getJobOverviews(): Promise<JobOverview[]> {
    const client = await this.getClient();
    const response = await client.get<{ jobs: JobOverview[] }>('/api/jobs/overview');
    return response.data.jobs || [];
  }

  // 执行一个手动步骤
  async runJobStep(id: string, step: PipelineStep): Promise<Job> {
    const client = await this.getClient();
    const routeMap: Record<PipelineStep, string> = {
      transcribe: 'transcribe',
      clean: 'clean',
      generate_video_prompts: 'generate-video-prompts',
      generate_video: 'generate-video',
    };
    const response = await client.post<ApiResponse>(`/api/jobs/${id}/steps/${routeMap[step]}`);
    return response.data.job!;
  }

  async pauseJobStep(id: string): Promise<Job> {
    const client = await this.getClient();
    const response = await client.post<ApiResponse>(`/api/jobs/${id}/steps/pause`);
    return response.data.job!;
  }

  // 补充内容后重新洗稿
  async recleanJob(id: string, supplementalText: string): Promise<Job> {
    const client = await this.getClient();
    const response = await client.post<ApiResponse>(`/api/jobs/${id}/reclean`, { supplementalText });
    return response.data.job!;
  }

  async subscribeJobStepEvents(
    id: string,
    step: StreamablePipelineStep,
    handlers: {
      onEvent: (event: JobStepStreamEvent) => void;
      onConnectionError?: (message: string) => void;
    }
  ): Promise<() => void> {
    await this.initialize();
    const source = new EventSource(`http://localhost:${this.serverPort}/api/jobs/${id}/steps/${step}/events`);
    const eventTypes: JobStepStreamEvent['type'][] = ['started', 'preview', 'completed', 'paused', 'error'];
    let terminal = false;
    let consecutiveErrors = 0;
    const listeners = eventTypes.map((type) => {
      const listener = (raw: Event) => {
        const parsed = parseJobStepStreamEvent((raw as MessageEvent<string>).data);
        if (!parsed) return;
        handlers.onEvent(parsed);
        if (['completed', 'paused', 'error'].includes(parsed.type)) {
          terminal = true;
          source.close();
        }
      };
      source.addEventListener(type, listener);
      return { type, listener };
    });
    source.onopen = () => {
      consecutiveErrors = 0;
    };
    source.onerror = () => {
      if (terminal) return;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        source.close();
        handlers.onConnectionError?.('实时连接已断开，任务仍会在后台继续执行');
      }
    };
    return () => {
      terminal = true;
      for (const { type, listener } of listeners) source.removeEventListener(type, listener);
      source.close();
    };
  }

  // 获取垃圾桶任务
  async getTrashJobs(): Promise<Job[]> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>('/api/jobs/trash');
    return response.data.jobs || [];
  }

  // 移入垃圾桶
  async deleteJob(id: string): Promise<Job> {
    const client = await this.getClient();
    const response = await client.delete<ApiResponse>(`/api/jobs/${id}`);
    return response.data.job!;
  }

  // 恢复垃圾桶任务
  async restoreJob(id: string): Promise<Job> {
    const client = await this.getClient();
    const response = await client.post<ApiResponse>(`/api/jobs/${id}/restore`);
    return response.data.job!;
  }

  // 永久删除垃圾桶任务
  async permanentlyDeleteJob(id: string): Promise<void> {
    const client = await this.getClient();
    await client.delete<ApiResponse>(`/api/jobs/${id}/permanent`);
  }

  // 获取清洗后的内容
  async getJobCleaned(id: string): Promise<CleanedScript> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>(`/api/jobs/${id}/cleaned`);
    return response.data.cleaned!;
  }

  // 获取原始转录文本
  async getJobRawTranscript(id: string): Promise<RawTranscript> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>(`/api/jobs/${id}/raw-transcript`);
    return response.data.rawTranscript!;
  }

  // 获取分镜（兼容历史视频提示词字段）
  async getJobVideoPrompts(id: string): Promise<Pick<ApiResponse, 'planVersion' | 'targetDuration' | 'shortVideoScript' | 'shortVideoShots' | 'videoPrompts' | 'enhancedScenes' | 'videoOutline'>> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>(`/api/jobs/${id}/video-prompts`);
    return {
      planVersion: response.data.planVersion,
      targetDuration: response.data.targetDuration,
      shortVideoScript: response.data.shortVideoScript,
      shortVideoShots: response.data.shortVideoShots,
      videoPrompts: response.data.videoPrompts,
      enhancedScenes: response.data.enhancedScenes,
      videoOutline: response.data.videoOutline,
    };
  }

  // 获取生成视频信息
  async getJobVideoOutput(id: string): Promise<HyperframesVideoOutput> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>(`/api/jobs/${id}/video-output`);
    return response.data.videoOutput!;
  }

  // 下载生成的视频
  async downloadVideo(id: string): Promise<string> {
    const serverPort = this.serverPort || (typeof window !== 'undefined' && window.electron?.getServerPort ? await window.electron.getServerPort() : 5173);
    return `http://localhost:${serverPort}/api/jobs/${id}/video/download`;
  }

  async getVideoStreamUrl(id: string): Promise<string> {
    const serverPort = this.serverPort || (typeof window !== 'undefined' && window.electron?.getServerPort ? await window.electron.getServerPort() : 5173);
    return `http://localhost:${serverPort}/api/jobs/${id}/video/stream`;
  }

  // 健康检查
  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const response = await client.get('/health');
      return response.data.ok === true;
    } catch {
      return false;
    }
  }

  // ─── 合集 API ──────────────────────────────────────────────

  // 创建合集（爬取用户主页）
  async createCollection(params: { pageUrl: string; maxItems?: number }): Promise<{ collection: any; crawlResult: CrawlUserPageResult }> {
    const client = await this.getClient();
    const response = await client.post('/api/collections', params);
    return response.data;
  }

  // 列出所有合集
  async getCollections(): Promise<CollectionOverview[]> {
    const client = await this.getClient();
    const response = await client.get('/api/collections');
    return response.data.collections ?? [];
  }

  // 获取合集详情
  async getCollection(id: string): Promise<CollectionOverview> {
    const client = await this.getClient();
    const response = await client.get(`/api/collections/${id}`);
    return response.data.collection!;
  }

  // 获取合集中每个视频项的子任务状态
  async getCollectionItemStates(id: string): Promise<Record<string, {
    jobId: string;
    status: string;
    stage: string;
    error?: string;
  } | null>> {
    const client = await this.getClient();
    const response = await client.get(`/api/collections/${id}/item-states`);
    return response.data.itemStates;
  }

  // 删除合集
  async deleteCollection(id: string): Promise<void> {
    const client = await this.getClient();
    await client.delete(`/api/collections/${id}`);
  }

  // 增量更新合集 — 抓取新视频追加到已有合集
  async updateCollection(id: string): Promise<{ collection: any; newItemsCount: number; message: string }> {
    const client = await this.getClient();
    const response = await client.post(`/api/collections/${id}/update`);
    return response.data;
  }

  // 基于合集创建子任务
  async createCollectionJobs(collectionId: string, selectedIds: string[], topic?: string): Promise<{ createdJobs: Job[]; collection: any }> {
    const client = await this.getClient();
    const response = await client.post(`/api/collections/${collectionId}/create-jobs`, {
      selectedIds,
      topic,
    });
    return response.data;
  }

  // 批量执行合集步骤
  async batchRunCollectionStep(collectionId: string, step: PipelineStep): Promise<{ message: string; results: Array<{ jobId: string; status: string; error?: string }> }> {
    const client = await this.getClient();
    const routeMap: Record<PipelineStep, string> = {
      transcribe: 'transcribe',
      clean: 'clean',
      generate_video_prompts: 'generate_video_prompts',
      generate_video: 'generate_video',
    };
    const response = await client.post(`/api/collections/${collectionId}/steps/${routeMap[step]}`);
    return response.data;
  }

  // 获取合集全部转录文本
  async getCollectionTranscripts(id: string): Promise<CollectionTranscriptsResponse> {
    const client = await this.getClient();
    const response = await client.get(`/api/collections/${id}/transcripts`);
    return response.data;
  }

  // 生成/更新 Skill（流式进度回调）
  async generateSkill(
    id: string,
    options: { focusPrompt?: string; mode?: 'create' | 'update' },
    onProgress?: (event: SkillProgressEvent) => void
  ): Promise<GenerateSkillResponse> {
    const client = await this.getClient();
    const port = this.serverPort;

    // 使用 fetch 以支持流式读取
    const response = await fetch(`http://localhost:${port}/api/collections/${id}/generate-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
      throw { response: { data: err } };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/plain') && !response.body) {
      // Plain JSON response (error case handled above)
      const data = await response.json();
      return data as GenerateSkillResponse;
    }

    // 流式读取 NDJSON
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: GenerateSkillResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseSkillProgressLine(line);
        if (!event) continue;
        onProgress?.(event);
        if (event.success) {
          finalResult = event as GenerateSkillResponse;
        }
      }
    }

    if (finalResult) return finalResult;

    // Should never reach here, but fallback
    throw { response: { data: { message: '生成未返回结果' } } };
  }

  // 获取 Skill 内容
  async getSkillContent(id: string): Promise<any> {
    const client = await this.getClient();
    const response = await client.get(`/api/collections/${id}/skill-content`);
    return response.data;
  }

  // 切换自动同步 Skill 开关
  async toggleAutoSyncSkill(id: string, enabled: boolean): Promise<{ success: boolean; autoSyncSkill: boolean }> {
    const client = await this.getClient();
    const response = await client.post(`/api/collections/${id}/toggle-auto-sync-skill`, { enabled });
    return response.data;
  }

  // 列出所有已生成的 Skill
  async getSkills(): Promise<{ skills: any[] }> {
    const client = await this.getClient();
    const response = await client.get('/api/skills');
    return response.data;
  }

  // 删除 Skill
  async deleteSkill(collectionId: string): Promise<{ success: boolean }> {
    const client = await this.getClient();
    const response = await client.delete(`/api/skills/${collectionId}`);
    return response.data;
  }

  // 重命名 Skill
  async renameSkill(collectionId: string, newName: string): Promise<{ success: boolean; skillName: string; skillPath: string }> {
    const client = await this.getClient();
    const response = await client.put(`/api/skills/${collectionId}/rename`, { newName });
    return response.data;
  }

  // ─── 抖音 Cookie / 扫码登录 API ───────────────────────────

  // 检查 cookie 状态
  async getCookieStatus(): Promise<{ hasCookie: boolean; hasAuth: boolean; path: string; status: string }> {
    const client = await this.getClient();
    const response = await client.get('/api/douyin/cookie-status');
    return response.data;
  }

  // 扫码登录
  async startQrLogin(): Promise<{ success: boolean; message: string; hasAuth: boolean; authInfo?: any }> {
    const client = await this.getClient();
    const response = await client.post('/api/douyin/qr-login');
    return response.data;
  }

  // 手动保存 Cookie
  async saveCookie(cookie: string): Promise<{ success: boolean; message: string; hasAuth: boolean; path: string }> {
    const client = await this.getClient();
    const response = await client.post('/api/douyin/save-cookie', { cookie });
    return response.data;
  }
}

export const apiClient = new ApiClient();
