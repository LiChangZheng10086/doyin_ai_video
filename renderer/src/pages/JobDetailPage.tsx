import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Loader2,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { CreatePublishPackageDialog } from '../components/CreatePublishPackageDialog';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { InlineNotice } from '../components/ui/InlineNotice';
import { apiClient } from '../services/api';
import { useOperatorStore } from '../store/operator';
import { getCleanArtifactDecision, getCleanArtifactLoadError } from '../utils/jobArtifacts';
import { isPublishingEligibleVideo } from '../utils/publishing';
import { WorkflowConsole } from '../features/jobs/WorkflowConsole';
import { ArtifactNavigator, type ArtifactKey } from '../features/jobs/artifacts/ArtifactNavigator';
import { TranscriptArtifact } from '../features/jobs/artifacts/TranscriptArtifact';
import { RewriteArtifact } from '../features/jobs/artifacts/RewriteArtifact';
import { ShotArtifact } from '../features/jobs/artifacts/ShotArtifact';
import { VideoArtifact } from '../features/jobs/artifacts/VideoArtifact';
import { JobContextSidebar } from '../features/jobs/JobContextSidebar';
import { buildArtifactStates } from '../features/jobs/jobPresentation';
import type {
  Job,
  CleanedScript,
  RawTranscript,
  PipelineStep,
  HyperframesVideoOutput,
  ShortVideoShot,
} from '../types';

type OutcomeTab = 'transcript' | 'script' | 'prompts' | 'video';

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [cleaned, setCleaned] = useState<CleanedScript | null>(null);
  const [rawTranscript, setRawTranscript] = useState<RawTranscript | null>(null);
  const [videoOutput, setVideoOutput] = useState<HyperframesVideoOutput | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cleanedError, setCleanedError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runningStep, setRunningStep] = useState<PipelineStep | null>(null);
  const [activeTab, setActiveTab] = useState<OutcomeTab>('script');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const loadJobArtifacts = async (jobData: Job) => {
    setCleanedError(null);
    setTranscriptError(null);
    setVideoError(null);
    setVideoOutput(null);

    try {
      const transcriptData = await apiClient.getJobRawTranscript(jobData.id);
      if (transcriptData && transcriptData.transcript) {
        setRawTranscript(transcriptData);
      }
    } catch {
      setRawTranscript(null);
      if (jobData.steps?.transcribe?.status === 'failed') {
        setTranscriptError('视频转录失败，可在当前步骤重试');
      }
    }

    const cleanArtifact = getCleanArtifactDecision(jobData);
    if (cleanArtifact.error) setCleanedError(cleanArtifact.error);
    if (cleanArtifact.shouldLoad) {
      try {
        const cleanedData = await apiClient.getJobCleaned(jobData.id);
        setCleaned(cleanedData);
        if (cleanedData.output?.hyperframesVideo) {
          setVideoOutput(cleanedData.output.hyperframesVideo);
        }
      } catch (err) {
        setCleaned(null);
        const status = getApiErrorStatus(err);
        const loadError = getCleanArtifactLoadError(jobData, status, getApiErrorMessage(err));
        if (loadError) setCleanedError(loadError);
      }
    } else {
      setCleaned(null);
    }

    if (jobData.steps?.generate_video?.status === 'failed') {
      setVideoError(jobData.steps.generate_video.lastError || '视频生成失败，可在当前步骤重试');
    }

    if (jobData.videoOutputPath || jobData.steps?.generate_video?.status === 'succeeded') {
      try {
        const output = await apiClient.getJobVideoOutput(jobData.id);
        setVideoOutput(output);
      } catch (err) {
        setVideoOutput(null);
        const errMsg = err instanceof Error ? err.message : '未知错误';
        setVideoError(`视频成片加载失败: ${errMsg}`);
      }
    }
  };

  useEffect(() => {
    const fetchJob = async () => {
      if (!id) return;

      try {
        setIsLoading(true);
        const jobData = await apiClient.getJob(id);
        setJob(jobData);
        await loadJobArtifacts(jobData);
      } catch (err: any) {
        setError(err.response?.data?.message || '加载任务失败');
      } finally {
        setIsLoading(false);
      }
    };

    fetchJob();
  }, [id]);

  useEffect(() => {
    if (!id || !runningStep) return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const latest = await apiClient.getJob(id);
        if (active) setJob(latest);
      } catch {
        // The original step request remains the source of truth for errors.
      }
    }, 750);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [id, runningStep]);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-24">
          <div className="text-center">
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-tech-blue" />
            <p className="mt-4 text-tech-muted">正在打开作品...</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (error || !job) {
    return (
      <Layout>
        <div className="rounded-lg border border-tech-border bg-white py-20 text-center">
          <XCircle className="mx-auto mb-4 h-12 w-12 text-red-500" />
          <h3 className="text-xl font-semibold text-tech-text">{error || '作品不存在'}</h3>
          <button
            onClick={() => navigate('/')}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-tech-blue px-5 py-2.5 text-white transition-all hover:bg-tech-blue-dark"
          >
            <ArrowLeft size={16} />
            返回创作中心
          </button>
        </div>
      </Layout>
    );
  }

  const handleDeleteJob = async () => {
    try {
      setActionError(null);
      await apiClient.deleteJob(job.id);
      navigate('/');
    } catch (err: any) {
      setActionError(err.response?.data?.message || '删除作品失败');
    }
  };

  const handleRestoreJob = async () => {
    try {
      setActionError(null);
      const restored = await apiClient.restoreJob(job.id);
      setJob(restored);
    } catch (err: any) {
      setActionError(err.response?.data?.message || '恢复作品失败');
    }
  };

  const handleRunStep = async (step: PipelineStep) => {
    try {
      setActionError(null);
      setRunningStep(step);
      const updated = await apiClient.runJobStep(job.id, step);
      setJob(updated);
      await loadJobArtifacts(updated);
    } catch (err: any) {
      const responseJob = err.response?.data?.job as Job | undefined;
      if (responseJob) {
        setJob(responseJob);
        await loadJobArtifacts(responseJob);
      }
      setActionError(err.response?.data?.message || '步骤执行失败');
    } finally {
      setRunningStep(null);
    }
  };

  const artifactAvailability = {
    transcriptReady: Boolean(rawTranscript?.transcript),
    rewriteReady: Boolean(cleaned?.output?.cleanScript || cleaned?.output?.summary),
    shotsReady: Boolean(cleaned?.output?.shortVideoShots?.length || cleaned?.output?.videoPrompts?.length || cleaned?.output?.enhancedScenes?.length),
    videoReady: Boolean(videoOutput?.videoPath),
    transcriptError,
    rewriteError: cleanedError,
    videoError: videoError && !videoOutput ? videoError : null,
  };
  const artifactStates = buildArtifactStates(job, artifactAvailability);
  const activeArtifactKey: ArtifactKey = activeTab === 'prompts' ? 'shots' : activeTab === 'script' ? 'script' : activeTab === 'transcript' ? 'transcript' : 'video';

  // Video content view state
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamError, setStreamError] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishError, setPublishError] = useState('');
  const currentUser = useOperatorStore((state) => state.currentUser);

  useEffect(() => {
    if (!videoOutput) return;
    setStreamError(false);
    const loadVideoUrl = async () => {
      try {
        const [downloadUrl, previewUrl] = await Promise.all([
          apiClient.downloadVideo(job.id),
          apiClient.getVideoStreamUrl(job.id),
        ]);
        setVideoUrl(downloadUrl);
        setStreamUrl(previewUrl);
      } catch (err) {
        console.error('Failed to get video URL:', err);
      }
    };
    loadVideoUrl();
  }, [videoOutput, job.id]);

  const openPublishingDialog = () => {
    if (!currentUser) {
      setPublishError('请先在顶部选择操作者');
      return;
    }
    setPublishError('');
    setShowPublishDialog(true);
  };

  return (
    <Layout>
      {/* Title bar */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-tech-border text-tech-muted transition-colors hover:bg-white hover:text-tech-text"
            aria-label="返回创作中心"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-2xl font-semibold text-tech-text">{cleaned?.output?.title || job.topic || '未命名作品'}</h1>
            <p className="mt-1 text-sm text-tech-muted">更新于 {new Date(job.updatedAt).toLocaleString('zh-CN')}</p>
          </div>
        </div>
        {job.deletedAt ? (
          <button
            onClick={handleRestoreJob}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-blue px-4 py-2.5 font-medium text-white transition-all hover:bg-tech-blue-dark"
          >
            <RotateCcw size={16} />
            恢复作品
          </button>
        ) : (
          <button
            onClick={() => setDeleteConfirmOpen(true)}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 px-4 py-2.5 font-medium text-red-600 transition-all hover:bg-red-50"
          >
            <Trash2 size={16} />
            删除作品
          </button>
        )}
      </div>

      {/* Trashed notice */}
      {job.deletedAt && (
        <div className="mb-6">
          <InlineNotice tone="warning" title="此作品已在垃圾桶中">
            {formatTrashRetention(job.trashExpiresAt)}
          </InlineNotice>
        </div>
      )}

      {/* Workflow console */}
      <WorkflowConsole
        job={job}
        runningStep={runningStep}
        actionError={actionError}
        onRunStep={handleRunStep}
      />

      {/* Outcome tabs */}
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="overflow-hidden rounded-lg border border-tech-border bg-white">
          <ArtifactNavigator
            active={activeArtifactKey}
            items={artifactStates.map((a) => ({ key: a.key as ArtifactKey, label: a.label, state: a.state }))}
            onChange={(key) => {
              if (key === 'shots') setActiveTab('prompts');
              else if (key === 'script') setActiveTab('script');
              else if (key === 'transcript') setActiveTab('transcript');
              else setActiveTab('video');
            }}
          />
          <div className="p-6">
            {activeArtifactKey === 'transcript' && (
              <TranscriptArtifact
                transcript={rawTranscript}
                fallbackText={cleaned?.output?.rawText}
                transcriptError={transcriptError}
              />
            )}
            {activeArtifactKey === 'script' && (
              <RewriteArtifact cleaned={cleaned} cleanedError={cleanedError} />
            )}
            {activeArtifactKey === 'shots' && (
              <VideoPromptsContent cleaned={cleaned} />
            )}
            {activeArtifactKey === 'video' && videoOutput ? (
              <VideoArtifact
                output={videoOutput}
                jobId={job.id}
                title={cleaned?.output?.title || job.topic || '未命名作品'}
                videoError={videoError}
                videoUrl={videoUrl}
                streamUrl={streamUrl}
                streamError={streamError}
                publishError={publishError}
                onOpenPublishing={openPublishingDialog}
              />
            ) : activeArtifactKey === 'video' && videoError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
                <p className="font-semibold">视频成片不可用</p>
                <p className="mt-1 text-sm">{videoError}</p>
              </div>
            ) : activeArtifactKey === 'video' ? (
              <div className="rounded-lg border border-dashed border-tech-border bg-gray-50 py-14 text-center">
                <h3 className="font-semibold text-tech-text">视频还没生成</h3>
                <p className="mt-2 text-sm text-tech-muted">完成生成分镜后，可以执行生成视频步骤，渲染 9:16 竖屏 MP4。</p>
              </div>
            ) : null}
          </div>
        </div>

        <JobContextSidebar job={job} />
      </div>

      {showPublishDialog && videoOutput && isPublishingEligibleVideo(videoOutput) && (
        <CreatePublishPackageDialog
          jobId={job.id}
          title={cleaned?.output?.title || job.topic || '未命名作品'}
          output={videoOutput}
          onClose={() => setShowPublishDialog(false)}
        />
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="确定删除这个作品吗？"
        description="删除后会进入垃圾桶，30 天内可恢复。"
        confirmLabel="删除"
        onConfirm={handleDeleteJob}
        onClose={() => setDeleteConfirmOpen(false)}
      />
    </Layout>
  );
}

// ── Shots display content ──

function VideoPromptsContent({ cleaned }: { cleaned: CleanedScript | null }) {
  const output = cleaned?.output;
  const shots = output?.shortVideoShots ?? [];
  const prompts = output?.videoPrompts ?? [];
  const scenes = output?.enhancedScenes ?? [];

  if (!shots.length && !prompts.length && !scenes.length) {
    return (
      <div className="rounded-lg border border-dashed border-tech-border bg-gray-50 py-14 text-center">
        <h3 className="font-semibold text-tech-text">镜头列表还没生成</h3>
        <p className="mt-2 text-sm text-tech-muted">完成生成分镜后，这里会显示 HyperFrames 使用的短视频镜头规划。</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-tech-text">镜头列表</h3>
        <p className="mt-1 text-sm text-tech-muted">基于 AI 洗稿结果生成的短视频镜头、字幕、动效节奏和视觉层级。</p>
      </div>

      {shots.length > 0 ? (
        <div className="space-y-3">
          {shots.map((shot) => (
            <ShotCard key={`${shot.index}-${shot.caption}`} shot={shot} />
          ))}
        </div>
      ) : scenes.length > 0 ? (
        <div className="space-y-3">
          {scenes.map((scene) => (
            <div key={scene.scene} className="rounded-lg border border-tech-border bg-gray-50 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="font-semibold text-tech-text">场景 {scene.scene}</p>
                {scene.cameraMovement && (
                  <span className="rounded-full bg-white px-2 py-1 text-xs text-tech-muted">{scene.cameraMovement}</span>
                )}
              </div>
              <p className="text-sm leading-6 text-tech-text">{scene.videoPrompt}</p>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                {scene.originalVisual && <Metric label="画面" value={scene.originalVisual} />}
                {scene.motionEffect && <Metric label="动效" value={scene.motionEffect} />}
                {scene.lightingStyle && <Metric label="光影" value={scene.lightingStyle} />}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {prompts.map((prompt, index) => (
            <p key={index} className="rounded-lg border border-tech-border bg-gray-50 p-4 text-sm leading-6 text-tech-text">
              {index + 1}. {prompt}
            </p>
          ))}
        </div>
      )}

      {output?.videoOutline && output.videoOutline.length > 0 && (
        <div>
          <h4 className="mb-3 text-base font-semibold text-tech-text">兼容视频大纲</h4>
          <div className="space-y-3">
            {output.videoOutline.map((item, index) => (
              <div key={index} className="rounded-lg border border-tech-border bg-gray-50 p-4">
                <p className="mb-2 font-semibold text-tech-text">{index + 1}. {item.title}</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-tech-text">
                  {item.bullets.map((bullet, bulletIndex) => (
                    <li key={bulletIndex}>{bullet}</li>
                  ))}
                </ul>
                {item.visualPrompt && <p className="mt-3 text-sm text-tech-muted">{item.visualPrompt}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ShotCard({ shot }: { shot: ShortVideoShot }) {
  const layers = shot.visualLayers ?? [];
  const captionLines = shot.captionLines?.length ? shot.captionLines : [shot.caption].filter(Boolean);
  const visualItems = shot.visualItems ?? [];

  return (
    <div className="rounded-lg border border-tech-border bg-gray-50 p-4">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-purple-600">镜头 {shot.index} · {formatShotType(shot.shotType)}</p>
          <h4 className="mt-1 text-base font-semibold text-tech-text">{shot.headline || shot.subject}</h4>
          {shot.supportingText && <p className="mt-1 text-sm text-tech-muted">{shot.supportingText}</p>}
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-tech-muted">
          <span className="rounded-full bg-white px-2 py-1">{formatSeconds(shot.duration)}</span>
          {shot.layout && <span className="rounded-full bg-white px-2 py-1">{formatLayout(shot.layout)}</span>}
          {shot.sourceKeyPoints?.length ? <span className="rounded-full bg-white px-2 py-1">覆盖要点 {shot.sourceKeyPoints.map((item) => item + 1).join('、')}</span> : null}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-purple-100 bg-white p-3">
        <label className="mb-1 block text-xs font-medium uppercase text-purple-500">字幕</label>
        {captionLines.map((line, index) => <p key={index} className="text-sm leading-6 text-tech-text">{line}</p>)}
      </div>

      {visualItems.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
          {visualItems.map((item, index) => (
            <div key={`${item.label}-${index}`} className="rounded-lg border border-tech-border bg-white p-3">
              <p className="text-xs text-tech-muted">{item.label}</p>
              {item.value && <p className="mt-1 font-semibold text-tech-text">{item.value}</p>}
            </div>
          ))}
        </div>
      )}

      <details className="mt-3 rounded-lg border border-tech-border bg-white p-3">
        <summary className="cursor-pointer text-sm font-medium text-tech-muted">制作信息</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Metric label="转场" value={shot.transition} />
          <Metric label="节奏" value={shot.pacing} />
          <Metric label="画面动作" value={shot.action} />
          <Metric label="镜头运动" value={shot.cameraMotion} />
        </div>
        {layers.length > 0 && (
          <div className="mt-3 space-y-2">
            {layers.map((layer, index) => (
              <p key={`${layer.type}-${index}`} className="text-xs leading-5 text-tech-muted">
                {layer.type}: {[layer.content, layer.motion, layer.style].filter(Boolean).join(' · ')}
              </p>
            ))}
          </div>
        )}
        {shot.narration && <p className="mt-3 text-xs leading-5 text-tech-muted">内部口播稿：{shot.narration}</p>}
      </details>
    </div>
  );
}

// ── Utility helpers ──

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <label className="mb-1 block text-xs text-tech-muted">{label}</label>
      <p className="text-sm text-tech-text">{value}</p>
    </div>
  );
}

function formatShotType(type?: ShortVideoShot['shotType']) {
  const labels: Record<string, string> = {
    hook: '开场钩子', problem: '问题', explain: '解释', proof: '验证',
    contrast: '对比', process: '流程', summary: '总结', cta: '行动引导',
  };
  return type ? (labels[type] ?? '内容镜头') : '内容镜头';
}

function formatLayout(layout: ShortVideoShot['layout']) {
  if (!layout) return '';
  const labels: Record<string, string> = {
    'kinetic-title': '动态标题', 'concept-map': '概念关系', 'process-flow': '流程图',
    comparison: '对比画面', metric: '数据状态', 'summary-stack': '总结收束',
  };
  return labels[layout] ?? layout;
}

function formatSeconds(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatTrashRetention(value?: string) {
  if (!value) return '保留期未知';
  const days = Math.ceil((new Date(value).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return '即将自动清理';
  return `剩余 ${days} 天自动清理`;
}

function getApiErrorStatus(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status;
}

function getApiErrorMessage(error: unknown) {
  const responseMessage = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  if (responseMessage) return responseMessage;
  return error instanceof Error ? error.message : '未知错误';
}
