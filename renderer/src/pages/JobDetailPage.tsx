import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { apiClient } from '../services/api';
import type { Job, ScriptAsset, CleanedScript } from '../types';

type TabType = 'overview' | 'transcript' | 'script' | 'video' | 'ppt';

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [cleaned, setCleaned] = useState<CleanedScript | null>(null);
  const [rawTranscript, setRawTranscript] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cleanedError, setCleanedError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  useEffect(() => {
    const fetchJob = async () => {
      if (!id) return;

      try {
        setIsLoading(true);
        const jobData = await apiClient.getJob(id);
        setJob(jobData);

        // 如果任务已完成，加载内容
        if (jobData.status === 'done') {
          // 加载清洗内容
          try {
            const cleanedData = await apiClient.getJobCleaned(id);
            setCleaned(cleanedData);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : '未知错误';
            setCleanedError(`内容加载失败: ${errMsg}`);
            console.error('Failed to load cleaned content:', err);
          }

          // 加载原始转录（视频音频转文本）
          try {
            const transcriptData = await apiClient.getJobRawTranscript(id);
            if (transcriptData && transcriptData.transcript) {
              setRawTranscript(transcriptData.transcript);
            }
          } catch (err) {
            console.log('No raw transcript available (possibly no ASR configured)');
            setTranscriptError('视频转录功能未配置或转录失败');
          }
        }
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

  const tabs = [
    { id: 'overview' as TabType, label: '概览', icon: '📋' },
    { id: 'transcript' as TabType, label: '视频转录', icon: '🎤', disabled: !rawTranscript && !cleaned?.output?.rawText },
    { id: 'script' as TabType, label: 'AI 洗稿', icon: '✨', disabled: !cleaned?.output?.cleanScript },
    { id: 'video' as TabType, label: '视频提示词', icon: '🎬', disabled: !cleaned?.output?.videoPrompts },
    { id: 'ppt' as TabType, label: 'PPT 内容', icon: '📊', disabled: !cleaned?.output?.pptContent },
  ];

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
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-tech-surface rounded-xl border border-tech-border overflow-hidden">
        <div className="flex border-b border-tech-border overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => !tab.disabled && setActiveTab(tab.id)}
              disabled={tab.disabled}
              className={`px-6 py-4 text-sm font-medium whitespace-nowrap transition-all ${
                activeTab === tab.id
                  ? 'bg-tech-blue text-white'
                  : tab.disabled
                  ? 'text-tech-muted cursor-not-allowed opacity-50'
                  : 'text-tech-text hover:bg-tech-bg'
              }`}
            >
              <span className="mr-2">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'overview' && (
            <OverviewTab job={job} />
          )}

          {activeTab === 'transcript' && (
            <>
              {rawTranscript ? (
                <TranscriptTab
                  transcript={rawTranscript}
                  source="视频音频转录"
                />
              ) : transcriptError ? (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-2xl">⚠️</span>
                    <span className="font-semibold text-amber-700">视频转录不可用</span>
                  </div>
                  <p className="text-sm text-amber-700 mb-4">
                    系统未配置语音识别 API（如 OpenAI Whisper），因此无法将视频音频转换为文字。
                  </p>
                  {cleaned?.output?.rawText && (
                    <div className="mt-4 pt-4 border-t border-amber-200">
                      <p className="text-sm text-amber-700 mb-2">
                        <strong>后备方案：</strong>使用了您输入的分享文本
                      </p>
                      <div className="bg-white rounded-lg p-4 mt-2">
                        <p className="text-tech-text whitespace-pre-wrap leading-relaxed">
                          {cleaned.output.rawText}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ) : cleaned?.output?.rawText ? (
                <div>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">ℹ️</span>
                      <span className="text-sm text-blue-700">
                        注意：这是您输入的分享文本，不是视频的实际转录内容
                      </span>
                    </div>
                  </div>
                  <TranscriptTab
                    transcript={cleaned.output.rawText}
                    source="分享文本（非转录）"
                  />
                </div>
              ) : (
                <div className="text-center py-8 text-tech-muted">暂无内容</div>
              )}
            </>
          )}

          {activeTab === 'script' && (
            <>
              {cleanedError ? (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">⚠️</span>
                    <span className="font-semibold">加载失败</span>
                  </div>
                  <p className="text-sm">{cleanedError}</p>
                </div>
              ) : cleaned ? (
                <ScriptTab cleaned={cleaned} />
              ) : (
                <div className="text-center py-8 text-tech-muted">暂无内容</div>
              )}
            </>
          )}

          {activeTab === 'video' && cleaned?.output?.videoPrompts && (
            <VideoPromptsTab prompts={cleaned.output.videoPrompts} />
          )}

          {activeTab === 'ppt' && cleaned?.output?.pptContent && (
            <PPTTab content={cleaned.output.pptContent} jobId={job.id} />
          )}
        </div>
      </div>
    </Layout>
  );
}

// Overview Tab
function OverviewTab({ job }: { job: Job }) {
  return (
    <div className="space-y-6">
      {/* Processing Stage */}
      {job.stage && (
        <div>
          <h3 className="text-lg font-semibold text-tech-text mb-3">处理进度</h3>
          <div className="flex items-center gap-3 p-4 bg-tech-bg rounded-lg">
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

      {/* Source URL */}
      <div>
        <h3 className="text-lg font-semibold text-tech-text mb-3">源链接</h3>
        <p className="text-sm text-tech-blue break-all bg-tech-bg px-4 py-3 rounded-lg">
          {job.sourceUrl}
        </p>
      </div>

      {/* Error Message */}
      {job.errorMessage && (
        <div>
          <h3 className="text-lg font-semibold text-red-700 mb-3">错误信息</h3>
          <pre className="text-sm text-red-600 whitespace-pre-wrap font-mono bg-red-50 border border-red-200 px-4 py-3 rounded-lg">
            {job.errorMessage}
          </pre>
        </div>
      )}

      {/* File Paths */}
      <div>
        <h3 className="text-lg font-semibold text-tech-text mb-3">文件路径</h3>
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
    </div>
  );
}

// Transcript Tab
function TranscriptTab({ transcript, source }: { transcript: string; source: string }) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-tech-text mb-1">
        {source}
      </h3>
      <p className="text-xs text-tech-muted mb-3">
        {source === '视频音频转录'
          ? '这是从视频音频提取并转录的真实内容'
          : '这是从分享文本解析的内容，非实际音频转录'}
      </p>
      <div className="bg-tech-bg rounded-lg p-4">
        <p className="text-tech-text whitespace-pre-wrap leading-relaxed">
          {transcript}
        </p>
      </div>
    </div>
  );
}

// Script Tab
function ScriptTab({ cleaned }: { cleaned: CleanedScript }) {
  const output = cleaned.output;

  if (!output) {
    return <div className="text-center py-8 text-tech-muted">暂无内容</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-tech-text mb-3">AI 洗稿结果</h3>

        {/* Title */}
        {output.title && (
          <div className="mb-4">
            <label className="text-xs text-tech-muted block mb-1">标题</label>
            <p className="text-xl font-bold text-tech-text bg-tech-bg px-4 py-3 rounded-lg">
              {output.title}
            </p>
          </div>
        )}

        {/* Clean Script */}
        {output.cleanScript && (
          <div className="mb-4">
            <label className="text-xs text-tech-muted block mb-1">清洗后的脚本</label>
            <div className="bg-tech-bg rounded-lg p-4">
              <p className="text-tech-text whitespace-pre-wrap leading-relaxed">
                {output.cleanScript}
              </p>
            </div>
          </div>
        )}

        {/* Tags */}
        {output.tags && output.tags.length > 0 && (
          <div className="mt-4">
            <label className="text-xs text-tech-muted block mb-2">标签</label>
            <div className="flex flex-wrap gap-2">
              {output.tags.map((tag, index) => (
                <span
                  key={index}
                  className="px-3 py-1 bg-tech-blue bg-opacity-10 text-tech-blue rounded-full text-sm"
                >
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Video Prompts Tab
function VideoPromptsTab({ prompts }: { prompts: any[] }) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-tech-text mb-3">AI 生成的视频提示词</h3>
      <div className="space-y-4">
        {prompts.map((prompt, index) => (
          <div key={index} className="bg-tech-bg rounded-lg p-4 border border-tech-border">
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-8 h-8 flex items-center justify-center bg-tech-blue text-white rounded-full text-sm font-bold">
                {index + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-tech-text leading-relaxed break-words">
                  {typeof prompt === 'string' ? prompt : prompt.prompt || JSON.stringify(prompt, null, 2)}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// PPT Tab
function PPTTab({ content, jobId }: { content: any; jobId: string }) {
  const [pptUrl, setPptUrl] = useState<string | null>(null);

  useEffect(() => {
    const loadPPTUrl = async () => {
      try {
        const url = await apiClient.downloadPPT(jobId);
        setPptUrl(url);
      } catch (err) {
        console.error('Failed to get PPT URL:', err);
      }
    };
    loadPPTUrl();
  }, [jobId]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-tech-text mb-3">PPT 内容</h3>

        {pptUrl && (
          <div className="mb-4">
            <a
              href={pptUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 bg-tech-blue text-white rounded-lg hover:bg-tech-blue-dark transition-all"
            >
              <span>📥</span>
              下载 PPT
            </a>
          </div>
        )}

        <div className="bg-tech-bg rounded-lg p-4 max-h-96 overflow-y-auto">
          <pre className="text-sm text-tech-text whitespace-pre-wrap">
            {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
