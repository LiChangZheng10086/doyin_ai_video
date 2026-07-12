import axios, { AxiosInstance } from 'axios';
import type { Job, ApiResponse, CleanedScript, RawTranscript, PipelineStep, JobOverview, HyperframesVideoOutput } from '../types';

class ApiClient {
  private client: AxiosInstance | null = null;
  private serverPort: number | null = null;

  async initialize() {
    if (!this.serverPort) {
      this.serverPort = await window.electron.getServerPort();
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
    const serverPort = this.serverPort || await window.electron.getServerPort();
    return `http://localhost:${serverPort}/api/jobs/${id}/video/download`;
  }

  async getVideoStreamUrl(id: string): Promise<string> {
    const serverPort = this.serverPort || await window.electron.getServerPort();
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
}

export const apiClient = new ApiClient();
