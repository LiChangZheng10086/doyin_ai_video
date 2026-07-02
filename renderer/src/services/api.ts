import axios, { AxiosInstance } from 'axios';
import type { Job, ApiResponse, ScriptAsset, CleanedScript, RawTranscript, PipelineStep, JobOverview } from '../types';

class ApiClient {
  private client: AxiosInstance | null = null;
  private serverPort: number | null = null;

  async initialize() {
    if (!this.serverPort) {
      this.serverPort = await window.electron.getServerPort();
      this.client = axios.create({
        baseURL: `http://localhost:${this.serverPort}`,
        timeout: 600000,
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
      download: 'download',
      extract_audio: 'extract-audio',
      transcribe: 'transcribe',
      clean: 'clean',
      generate_ppt: 'generate-ppt',
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

  // 获取任务脚本
  async getJobScript(id: string): Promise<ScriptAsset> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>(`/api/jobs/${id}/script`);
    return response.data.script!;
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

  // 获取视频提示词
  async getJobVideoPrompts(id: string): Promise<any> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>(`/api/jobs/${id}/video-prompts`);
    return response.data;
  }

  // 获取 PPT 内容
  async getJobPPTContent(id: string): Promise<any> {
    const client = await this.getClient();
    const response = await client.get<ApiResponse>(`/api/jobs/${id}/ppt-content`);
    return response.data;
  }

  // 下载 PPT
  async downloadPPT(id: string): Promise<string> {
    const serverPort = this.serverPort || await window.electron.getServerPort();
    return `http://localhost:${serverPort}/api/jobs/${id}/ppt/download`;
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
