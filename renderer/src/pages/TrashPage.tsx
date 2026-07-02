import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiClient } from '../services/api';
import type { Job } from '../types';

export function TrashPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const loadTrash = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const trashJobs = await apiClient.getTrashJobs();
        setJobs(trashJobs);
      } catch (err: any) {
        setError(err.response?.data?.message || '加载垃圾桶失败');
      } finally {
        setIsLoading(false);
      }
    };

    loadTrash();
  }, []);

  const handleRestore = async (jobId: string) => {
    try {
      setBusyId(jobId);
      await apiClient.restoreJob(jobId);
      setJobs(jobs.filter((job) => job.id !== jobId));
    } catch (err: any) {
      window.alert(err.response?.data?.message || '恢复任务失败');
    } finally {
      setBusyId(null);
    }
  };

  const handlePermanentDelete = async (job: Job) => {
    const ok = window.confirm('确定永久删除这个任务吗？相关视频、音频、转录、洗稿和 PPT 文件会被清理，无法恢复。');
    if (!ok) return;

    try {
      setBusyId(job.id);
      await apiClient.permanentlyDeleteJob(job.id);
      setJobs(jobs.filter((item) => item.id !== job.id));
    } catch (err: any) {
      window.alert(err.response?.data?.message || '永久删除任务失败');
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-tech-blue border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-tech-muted">加载垃圾桶...</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-semibold text-tech-text mb-1">垃圾桶</h2>
          <p className="text-sm text-tech-muted">
            删除的任务会保留 30 天，可恢复或永久删除
          </p>
        </div>
        <button
          onClick={() => navigate('/')}
          className="px-4 py-2 rounded-lg border border-tech-border text-tech-text hover:bg-tech-bg transition-all"
        >
          返回任务列表
        </button>
      </div>

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error}
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-20 h-20 mx-auto mb-6 bg-tech-surface rounded-lg border border-tech-border flex items-center justify-center text-tech-muted">
            <Trash2 size={34} />
          </div>
          <h3 className="text-xl font-semibold text-tech-text mb-2">垃圾桶是空的</h3>
          <p className="text-tech-muted">删除的任务会在这里保留 30 天</p>
        </div>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => {
            const active = job.status === 'queued' || job.status === 'processing';
            const busy = busyId === job.id;

            return (
              <div
                key={job.id}
                className="bg-tech-surface rounded-lg border border-tech-border p-5"
              >
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-medium text-tech-text mb-1 line-clamp-1">
                      {job.topic || '无主题'}
                    </h3>
                    <p className="text-xs text-tech-muted mb-2">
                      删除于 {formatDate(job.deletedAt)} · {formatRemaining(job.trashExpiresAt)}
                    </p>
                    {job.sourceUrl && (
                      <p className="text-sm text-tech-muted line-clamp-1 break-all">
                        {job.sourceUrl}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => navigate(`/jobs/${job.id}`)}
                      className="px-3 py-2 rounded-lg border border-tech-border text-sm text-tech-text hover:bg-tech-bg transition-all"
                    >
                      查看
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleRestore(job.id)}
                      className="px-3 py-2 rounded-lg bg-tech-blue text-white text-sm hover:bg-tech-blue-dark disabled:opacity-50 transition-all"
                    >
                      恢复
                    </button>
                    <button
                      type="button"
                      disabled={busy || active}
                      title={active ? '处理中任务暂不能永久删除' : undefined}
                      onClick={() => handlePermanentDelete(job)}
                      className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50 disabled:opacity-50 transition-all"
                    >
                      永久删除
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Layout>
  );
}

function formatDate(value?: string) {
  if (!value) return '未知时间';
  return new Date(value).toLocaleString('zh-CN');
}

function formatRemaining(value?: string) {
  if (!value) return '保留期未知';
  const remainingMs = new Date(value).getTime() - Date.now();
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  if (days <= 0) {
    return '即将自动清理';
  }
  return `剩余 ${days} 天自动清理`;
}
