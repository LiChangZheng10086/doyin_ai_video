import axios, { AxiosInstance } from 'axios';
import type { Job, ApiResponse, ScriptAsset, CleanedScript } from '../types';

class ApiClient {
  private client: AxiosInstance | null = null;
  private serverPort: number | null = null;

  async initialize() {
    if (!this.serverPort) {
      this.serverPort = await window.electron.getServerPort();
      this.client = axios.create({
        baseURL: `http://localhost:${this.serverPort}`,
        timeout: 30000,
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
