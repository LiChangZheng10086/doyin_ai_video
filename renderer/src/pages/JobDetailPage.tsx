import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { apiClient } from '../services/api';
import type { Job } from '../types';

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchJob = async () => {
      if (!id) return;

      try {
        setIsLoading(true);
        const jobData = await apiClient.getJob(id);
        setJob(jobData);
      } catch (err: any) {
        setError(err.response?.data?.message || '加载任务失败');
      } finally {
        setIsLoading(false);
      }
    };

    fetchJob();
  }, [id]);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-tech-blue border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-tech-muted">加载中...</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (error || !job) {
    return (
      <Layout>
        <div className="text-center py-20">
          <div className="text-6xl mb-4">⚠️</div>
          <h3 className="text-xl font-semibold text-tech-text mb-2">
            {error || '任务不存在'}
          </h3>
          <button
            onClick={() => navigate('/')}
            className="mt-4 px-6 py-2 bg-tech-blue text-white rounded-lg hover:bg-tech-blue-dark transition-all"
          >
            返回任务列表
          </button>
        </div>
      </Layout>
    );
  }

  const statusConfig: Record<string, { label: string; color: string }> = {
    queued: { label: '排队中', color: 'bg-blue-50 text-blue-700 border-blue-200' },
    processing: { label: '处理中', color: 'bg-amber-50 text-amber-700 border-amber-200' },
    done: { label: '已完成', color: 'bg-green-50 text-green-700 border-green-200' },
    failed: { label: '失败', color: 'bg-red-50 text-red-700 border-red-200' },
  };

  const statusInfo = statusConfig[job.status] || {
    label: job.status,
    color: 'bg-gray-50 text-gray-700 border-gray-200'
  };

  return (
    <Layout>
      {/* Header */}
      <div className="mb-6 flex items-center gap-4">
        <button
          onClick={() => navigate('/')}
          className="text-tech-muted hover:text-tech-text transition-colors"
        >
          ← 返回
        </button>
        <h1 className="text-2xl font-bold text-tech-text">
          任务详情
        </h1>
      </div>

      {/* Status Card */}
      <div className="bg-tech-surface rounded-xl border border-tech-border p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold text-tech-text mb-2">
              {job.topic || '无主题'}
            </h2>
            <p className="text-sm text-tech-muted">
              任务 ID: {job.id}
            </p>
          </div>
          <span className={`px-4 py-2 rounded-lg text-sm font-medium border ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>

        {/* Basic Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-tech-border">
          <div>
            <label className="text-xs text-tech-muted block mb-1">创建时间</label>
            <p className="text-sm text-tech-text">
              {new Date(job.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>
          <div>
            <label className="text-xs text-tech-muted block mb-1">更新时间</label>
            <p className="text-sm text-tech-text">
              {new Date(job.updatedAt).toLocaleString('zh-CN')}
            </p>
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-tech-muted block mb-1">源链接</label>
            <p className="text-sm text-tech-blue break-all">
              {job.sourceUrl}
            </p>
          </div>
        </div>
      </div>

      {/* Processing Stage */}
      {job.stage && (
        <div className="bg-tech-surface rounded-xl border border-tech-border p-6 mb-6">
          <h3 className="text-lg font-semibold text-tech-text mb-4">处理进度</h3>
          <div className="flex items-center gap-3">
            <div className="text-2xl">
              {job.status === 'done' ? '✅' :
               job.status === 'failed' ? '❌' :
               job.status === 'processing' ? '⏳' : '⏸️'}
            </div>
            <div>
              <p className="text-tech-text font-medium">{job.stage}</p>
              {job.status === 'processing' && (
                <p className="text-sm text-tech-muted">正在处理中...</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Error Message */}
      {job.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 mb-6">
          <h3 className="text-lg font-semibold text-red-700 mb-2">错误信息</h3>
          <pre className="text-sm text-red-600 whitespace-pre-wrap font-mono">
            {job.errorMessage}
          </pre>
        </div>
      )}

      {/* File Paths */}
      <div className="bg-tech-surface rounded-xl border border-tech-border p-6">
        <h3 className="text-lg font-semibold text-tech-text mb-4">文件路径</h3>
        <div className="space-y-3">
          {job.videoPath && (
            <div>
              <label className="text-xs text-tech-muted block mb-1">视频文件</label>
              <p className="text-sm text-tech-text font-mono break-all bg-tech-bg px-3 py-2 rounded">
                {job.videoPath}
              </p>
            </div>
          )}
          {job.audioPath && (
            <div>
              <label className="text-xs text-tech-muted block mb-1">音频文件</label>
              <p className="text-sm text-tech-text font-mono break-all bg-tech-bg px-3 py-2 rounded">
                {job.audioPath}
              </p>
            </div>
          )}
          {job.storagePath && (
            <div>
              <label className="text-xs text-tech-muted block mb-1">存储路径</label>
              <p className="text-sm text-tech-text font-mono break-all bg-tech-bg px-3 py-2 rounded">
                {job.storagePath}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 flex gap-3">
        <button
          onClick={() => navigate('/')}
          className="px-6 py-3 bg-tech-surface text-tech-text border border-tech-border rounded-lg hover:bg-tech-bg transition-all"
        >
          返回列表
        </button>
        {job.status === 'done' && job.storagePath && (
          <button
            onClick={() => {
              // TODO: 查看脚本内容
              console.log('View script:', job.id);
            }}
            className="px-6 py-3 bg-tech-blue text-white rounded-lg hover:bg-tech-blue-dark transition-all"
          >
            查看脚本
          </button>
        )}
      </div>
    </Layout>
  );
}
