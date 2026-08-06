import axios, { AxiosInstance } from 'axios';
import type { Job, ApiResponse, CleanedScript, RawTranscript, PipelineStep, JobOverview, HyperframesVideoOutput, CollectionOverview, CrawlUserPageResult, CollectionTranscriptsResponse, GenerateSkillResponse } from '../types';

class ApiClient {
  private client: AxiosInstance | null = null;
  private serverPort: number | null = null;

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
    }
    return this.client!;
  }

  async getClient() {
    if (!this.client) {
      await this.initialize();
    }
    return this.client!;
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

  // 生成/更新 Skill
  async generateSkill(id: string, options: { focusPrompt?: string; mode?: 'create' | 'update' }): Promise<GenerateSkillResponse> {
    const client = await this.getClient();
    const response = await client.post(`/api/collections/${id}/generate-skill`, options);
    return response.data;
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
