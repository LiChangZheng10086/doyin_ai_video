import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { JobCard } from '../components/JobCard';
import { CreateJobDialog } from '../components/CreateJobDialog';
import { ApiKeyWarning } from '../components/ApiKeyWarning';
import { useAppStore } from '../store';
import { apiClient } from '../services/api';
import { hasValidApiKey } from '../utils/apiKeyValidator';
import { useJobPolling } from '../hooks/useJobPolling';

export function JobListPage() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const navigate = useNavigate();
  const jobs = useAppStore((state) => state.jobs);
  const setJobs = useAppStore((state) => state.setJobs);
  const serverPort = useAppStore((state) => state.serverPort);
  const setServerPort = useAppStore((state) => state.setServerPort);

  // 启用智能轮询
  const { isPolling } = useJobPolling(true);

  // 初始化
  useEffect(() => {
    const init = async () => {
      try {
        // 获取服务器端口
        const port = await window.electron.getServerPort();
        setServerPort(port);

        // 初始化 API 客户端
        await apiClient.initialize();

        // 从后端获取任务列表
        const response = await apiClient.get('/api/jobs');
        if (response.data && response.data.jobs) {
          setJobs(response.data.jobs);
        }
      } catch (error) {
        console.error('Failed to initialize:', error);
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, [setServerPort, setJobs]);

  const handleJobClick = (jobId: string) => {
    navigate(`/jobs/${jobId}`);
  };

  const handleCreateClick = async () => {
    // 验证 API Key
    const hasKey = await hasValidApiKey();
    if (!hasKey) {
      setShowApiWarning(true);
      return;
    }

    // 验证通过，打开创建任务对话框
    setIsDialogOpen(true);
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-tech-border border-t-tech-blue"></div>
            <p className="mt-4 text-tech-muted">加载中...</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-semibold text-tech-text mb-1">
            任务列表
          </h2>
          <p className="text-sm text-tech-muted">
            管理您的视频处理任务
          </p>
        </div>
        <button
          onClick={handleCreateClick}
          className="px-6 py-3 rounded-lg bg-tech-blue text-white hover:bg-tech-blue-dark transition-all shadow-sm hover:shadow flex items-center gap-2 font-medium"
        >
          <span>+</span>
          <span>创建任务</span>
        </button>
      </div>

      {/* Server Info */}
      {serverPort && (
        <div className="mb-6 p-4 bg-tech-surface rounded-lg border border-tech-border">
          <div className="flex items-center gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
              </span>
              <span className="text-tech-text font-medium">后端服务运行中</span>
            </div>
            <span className="text-tech-muted">·</span>
            <code className="text-xs text-tech-blue bg-blue-50 px-2 py-1 rounded font-mono">
              http://localhost:{serverPort}
            </code>
          </div>
        </div>
      )}

      {/* Job List */}
      {jobs.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-tech-blue to-tech-blue-light rounded-2xl flex items-center justify-center text-4xl shadow-lg">
            📋
          </div>
          <h3 className="text-xl font-semibold text-tech-text mb-2">
            还没有任务
          </h3>
          <p className="text-tech-muted mb-8 max-w-md mx-auto">
            点击上方按钮创建第一个任务，开始您的智能视频创作之旅
          </p>
          <button
            onClick={handleCreateClick}
            className="px-6 py-3 rounded-lg bg-tech-blue text-white hover:bg-tech-blue-dark transition-all shadow-sm hover:shadow font-medium"
          >
            立即创建
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onClick={() => handleJobClick(job.id)}
            />
          ))}
        </div>
      )}

      {/* Create Job Dialog */}
      <CreateJobDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
      />

      {/* API Key Warning Dialog */}
      <ApiKeyWarning
        isOpen={showApiWarning}
        onClose={() => setShowApiWarning(false)}
      />

      {/* Polling Indicator (Debug) */}
      {isPolling && jobs.length > 0 && (
        <div className="fixed bottom-4 right-4 text-xs text-tech-muted bg-tech-surface border border-tech-border rounded-lg px-3 py-2 shadow-sm">
          <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span>
          轮询中...
        </div>
      )}
    </Layout>
  );
}
