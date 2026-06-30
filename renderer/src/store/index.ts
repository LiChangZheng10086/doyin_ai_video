import { create } from 'zustand';
import type { Job } from '../types';

interface AppState {
  // 任务列表
  jobs: Job[];
  currentJob: Job | null;

  // UI 状态
  isCreatingJob: boolean;
  isLoadingJobs: boolean;
  error: string | null;

  // 服务器信息
  serverPort: number | null;

  // Actions
  setJobs: (jobs: Job[]) => void;
  addJob: (job: Job) => void;
  updateJob: (id: string, updates: Partial<Job>) => void;
  setCurrentJob: (job: Job | null) => void;
  setIsCreatingJob: (isCreating: boolean) => void;
  setIsLoadingJobs: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  setServerPort: (port: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  jobs: [],
  currentJob: null,
  isCreatingJob: false,
  isLoadingJobs: false,
  error: null,
  serverPort: null,

  setJobs: (jobs) => set({ jobs }),

  addJob: (job) => set((state) => ({
    jobs: [job, ...state.jobs]
  })),

  updateJob: (id, updates) => set((state) => ({
    jobs: state.jobs.map((job) =>
      job.id === id ? { ...job, ...updates } : job
    ),
    currentJob: state.currentJob?.id === id
      ? { ...state.currentJob, ...updates }
      : state.currentJob,
  })),

  setCurrentJob: (job) => set({ currentJob: job }),
  setIsCreatingJob: (isCreating) => set({ isCreatingJob: isCreating }),
  setIsLoadingJobs: (isLoading) => set({ isLoadingJobs: isLoading }),
  setError: (error) => set({ error }),
  setServerPort: (port) => set({ serverPort: port }),
}));
