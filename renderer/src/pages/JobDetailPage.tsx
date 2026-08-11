import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Video,
  Wand2,
  XCircle,
  MoreHorizontal,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { CookieHint } from '../components/CookieHint';
import { CreatePublishPackageDialog } from '../components/CreatePublishPackageDialog';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { InlineNotice } from '../components/ui/InlineNotice';
import { IconButton } from '../components/ui/IconButton';
import { apiClient } from '../services/api';
import { useOperatorStore } from '../store/operator';
import { getCleanArtifactDecision, getCleanArtifactLoadError } from '../utils/jobArtifacts';
import { isPublishingEligibleVideo } from '../utils/publishing';
import { WorkflowConsole } from '../features/jobs/WorkflowConsole';
import type {
  Job,
  CleanedScript,
  RawTranscript,
  PipelineStep,
  PipelineStepState,
  HyperframesVideoOutput,
  ShortVideoShot,
  ShotLayout,
  ShotType,
} from '../types';

type OutcomeTab = 'transcript' | 'script' | 'prompts' | 'video';
type OutcomeStatus = 'ready' | 'processing' | 'waiting' | 'failed';

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

  const outcomes = buildOutcomes(job, cleaned, rawTranscript, videoOutput, cleanedError, transcriptError, videoError);
  const activeOutcome = outcomes.find((item) => item.id === activeTab) ?? outcomes[0];

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
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-lg border border-tech-border bg-white">
          <div className="flex overflow-x-auto border-b border-tech-border bg-gray-50 p-2">
            {outcomes.map((tab) => {
              const Icon = tab.icon;
              const active = activeOutcome.id === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`mr-2 flex min-w-[140px] items-center justify-between gap-3 rounded-lg px-4 py-3 text-left transition-all ${
                    active ? 'bg-white text-tech-text shadow-sm' : 'text-tech-muted hover:bg-white/70'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <Icon size={17} className={active ? 'text-tech-purple' : ''} />
                    {tab.label}
                  </span>
                  <OutcomeStatusBadge status={tab.status} />
                </button>
              );
            })}
          </div>
          <div className="p-6">
            {activeOutcome.id === 'transcript' && (
              <TranscriptContent
                rawTranscript={rawTranscript}
                cleaned={cleaned}
                transcriptError={transcriptError}
              />
            )}
            {activeOutcome.id === 'script' && (
              <ScriptContent cleaned={cleaned} cleanedError={cleanedError} />
            )}
            {activeOutcome.id === 'prompts' && (
              <VideoPromptsContent cleaned={cleaned} />
            )}
            {activeOutcome.id === 'video' && (
              <VideoContentView
                output={videoOutput}
                jobId={job.id}
                title={cleaned?.output?.title || job.topic || '未命名作品'}
                videoError={videoError}
              />
            )}
          </div>
        </div>

        <aside className="space-y-6">
          <TimelinePanel job={job} />
          <AdvancedInfo job={job} />
        </aside>
      </div>

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

// ── Transcript content ──

function TranscriptContent({
  rawTranscript,
  cleaned,
  transcriptError,
}: {
  rawTranscript: RawTranscript | null;
  cleaned: CleanedScript | null;
  transcriptError: string | null;
}) {
  if (rawTranscript) {
    return <TranscriptTab transcriptData={rawTranscript} source="视频音频转录" />;
  }
  if (transcriptError) {
    return (
      <Notice tone="warning" title="视频转录不可用">
        {transcriptError}
      </Notice>
    );
  }
  if (cleaned?.output?.rawText) {
    return (
      <div className="space-y-4">
        <Notice tone="info" title="使用分享文本作为后备">
          这是您输入的分享文本，不是视频的实际音频转录。
        </Notice>
        <TranscriptTab transcriptData={{ transcript: cleaned.output.rawText }} source="分享文本（非转录）" />
      </div>
    );
  }
  return <EmptyContent title="暂无转录内容" description="完成视频转录后，这里会显示原始文案和分段。" />;
}

function ScriptContent({ cleaned, cleanedError }: { cleaned: CleanedScript | null; cleanedError: string | null }) {
  if (cleanedError) {
    return <Notice tone="danger" title="AI 洗稿失败">{cleanedError}</Notice>;
  }
  if (!cleaned?.output?.cleanScript && !cleaned?.output?.summary) {
    return <EmptyContent title="AI 成果还没生成" description="完成 AI 洗稿后，这里会展示标题、摘要、核心要点和成稿。" />;
  }
  return <ScriptTab cleaned={cleaned} />;
}

function VideoPromptsContent({ cleaned }: { cleaned: CleanedScript | null }) {
  const output = cleaned?.output;
  const shots = output?.shortVideoShots ?? [];
  const prompts = output?.videoPrompts ?? [];
  const scenes = output?.enhancedScenes ?? [];

  if (!shots.length && !prompts.length && !scenes.length) {
    return <EmptyContent title="镜头列表还没生成" description="完成生成分镜后，这里会显示 HyperFrames 使用的短视频镜头规划。" />;
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

function VideoContentView({
  output,
  jobId,
  title,
  videoError,
}: {
  output: HyperframesVideoOutput | null;
  jobId: string;
  title: string;
  videoError: string | null;
}) {
  const currentUser = useOperatorStore((state) => state.currentUser);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamError, setStreamError] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishError, setPublishError] = useState('');

  useEffect(() => {
    if (!output) {
      return;
    }
    setStreamError(false);
    const loadVideoUrl = async () => {
      try {
        const [downloadUrl, previewUrl] = await Promise.all([
          apiClient.downloadVideo(jobId),
          apiClient.getVideoStreamUrl(jobId),
        ]);
        setVideoUrl(downloadUrl);
        setStreamUrl(previewUrl);
      } catch (err) {
        console.error('Failed to get video URL:', err);
      }
    };
    loadVideoUrl();
  }, [output, jobId]);

  if (videoError && !output) {
    return <Notice tone="danger" title="视频成片不可用">{videoError}</Notice>;
  }

  if (!output) {
    return <EmptyContent title="视频还没生成" description="完成生成分镜后，可以执行生成视频步骤，渲染 9:16 竖屏 MP4。" />;
  }

  const openPublishingDialog = () => {
    if (!currentUser) {
      setPublishError('请先在顶部选择操作者');
      document.getElementById('operator-switcher')?.focus();
      return;
    }
    setPublishError('');
    setShowPublishDialog(true);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-tech-text">视频成片</h3>
          <p className="mt-1 text-sm text-tech-muted">HyperFrames 本地渲染的 9:16 无声动效版。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isPublishingEligibleVideo(output) && (
            <button
              type="button"
              onClick={openPublishingDialog}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-purple px-4 py-2.5 font-medium text-white transition-all hover:opacity-90"
            >
              <Send size={17} />
              加入发布中心
            </button>
          )}
          {videoUrl && (
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-blue px-4 py-2.5 font-medium text-white transition-all hover:bg-tech-blue-dark"
            >
              <Download size={17} />
              下载 MP4
            </a>
          )}
        </div>
      </div>

      {publishError && <Notice tone="warning" title="需要选择操作者">{publishError}</Notice>}

      {videoError && <Notice tone="warning" title="本次渲染失败，正在显示上一版成片">{videoError}</Notice>}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Metric label="渲染器" value={output.provider} />
        <Metric label="尺寸" value={`${output.width}x${output.height} · ${output.aspectRatio}`} />
        <Metric label="时长" value={formatSeconds(output.duration)} />
      </div>

      {streamUrl && !streamError ? (
        <div className="rounded-lg border border-tech-border bg-black p-3">
          <video
            src={streamUrl}
            controls
            playsInline
            className="mx-auto aspect-[9/16] max-h-[72vh] w-full max-w-sm rounded-md bg-black"
            onError={() => setStreamError(true)}
          />
        </div>
      ) : streamError ? (
        <Notice tone="warning" title="视频预览加载失败">可以先下载 MP4 到本地查看。</Notice>
      ) : null}

      <div className="rounded-lg bg-gray-50 p-4">
        <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">视频文件</label>
        <p className="break-all font-mono text-xs text-tech-text">{output.videoPath}</p>
      </div>
      <div className="rounded-lg bg-gray-50 p-4">
        <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">HyperFrames 项目</label>
        <p className="break-all font-mono text-xs text-tech-text">{output.projectPath}</p>
      </div>

      {output.scenes?.length > 0 && (
        <div>
          <h4 className="mb-3 text-base font-semibold text-tech-text">渲染镜头</h4>
          <div className="space-y-3">
            {output.scenes.map((scene) => (
              <div key={scene.index} className="rounded-lg border border-tech-border bg-gray-50 p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="font-semibold text-tech-text">{scene.index}. {scene.headline ?? scene.subject ?? scene.title ?? '镜头'}</p>
                  <span className="shrink-0 rounded-full bg-white px-2 py-1 text-xs text-tech-muted">
                    {[formatSeconds(scene.duration), scene.transition, scene.pacing].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <p className="text-xs text-tech-muted">{scene.layout ? formatLayout(scene.layout) : formatShotType(scene.shotType)}</p>
                {(scene.captionLines?.length || scene.caption) && (
                  <div className="mt-2 rounded-lg bg-white p-3 text-sm leading-6 text-tech-text">
                    {(scene.captionLines?.length ? scene.captionLines : [scene.caption]).filter(Boolean).map((line, index) => <p key={index}>{line}</p>)}
                  </div>
                )}
                {(scene.bullets && scene.bullets.length > 0) && (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-tech-text">
                    {scene.bullets.map((bullet, index) => (
                      <li key={index}>{bullet}</li>
                    ))}
                  </ul>
                )}
                {(scene.emphasisWords && scene.emphasisWords.length > 0) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {scene.emphasisWords.map((word, index) => (
                      <span key={`${word}-${index}`} className="rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700">
                        {word}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {showPublishDialog && isPublishingEligibleVideo(output) && (
        <CreatePublishPackageDialog
          jobId={jobId}
          title={title}
          output={output}
          onClose={() => setShowPublishDialog(false)}
        />
      )}
    </div>
  );
}

function TimelinePanel({ job }: { job: Job }) {
  const events = buildTimeline(job);
  return (
    <div className="rounded-lg border border-tech-border bg-white p-5">
      <h3 className="font-semibold text-tech-text">活动记录</h3>
      <p className="mt-1 text-sm text-tech-muted">关键步骤时间线</p>
      <div className="mt-5 space-y-4">
        {events.length === 0 ? (
          <p className="text-sm text-tech-muted">等待第一步开始。</p>
        ) : events.map((event, index) => (
          <div key={`${event.label}-${index}`} className="flex gap-3">
            <span className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${event.failed ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-tech-blue'}`}>
              {event.failed ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
            </span>
            <div>
              <p className="text-sm font-medium text-tech-text">{event.label}</p>
              <p className="text-xs text-tech-muted">{formatDateTime(event.time)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdvancedInfo({ job }: { job: Job }) {
  return (
    <details className="rounded-lg border border-tech-border bg-white p-5">
      <summary className="cursor-pointer font-semibold text-tech-text">高级信息</summary>
      <div className="mt-4 space-y-4">
        <Field label="任务 ID" value={job.id} />
        <Field label="创建时间" value={new Date(job.createdAt).toLocaleString('zh-CN')} />
        <Field label="更新时间" value={new Date(job.updatedAt).toLocaleString('zh-CN')} />
        <Field label="视频文件" value={job.videoPath} />
        <Field label="音频文件" value={job.audioPath} />
        <Field label="成片文件" value={job.videoOutputPath} />
        <Field label="HyperFrames 项目" value={job.videoProjectPath} />
        <Field label="存储路径" value={job.storagePath} />
        {(job.errorMessage || job.error || job.downloadErrorMessage || job.audioErrorMessage || job.transcriptErrorMessage) && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <p className="mb-2 font-semibold">错误详情</p>
            <pre className="whitespace-pre-wrap font-mono text-xs">
              {job.errorMessage || job.error || job.downloadErrorMessage || job.audioErrorMessage || job.transcriptErrorMessage}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function TranscriptTab({ transcriptData, source }: { transcriptData: RawTranscript; source: string }) {
  const segments = transcriptData.segments ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-tech-text">{source}</h3>
      <p className="mt-1 text-xs text-tech-muted">
        {source === '视频音频转录'
          ? '这是从视频音频提取并转录的真实内容'
          : '这是从分享文本解析的内容，非实际音频转录'}
      </p>
      {(transcriptData.provider || transcriptData.model || transcriptData.duration) && (
        <div className="my-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {transcriptData.provider && <Metric label="服务" value={transcriptData.provider} />}
          {transcriptData.model && <Metric label="模型" value={transcriptData.model} />}
          {transcriptData.duration && <Metric label="时长" value={formatSeconds(transcriptData.duration)} />}
        </div>
      )}
      <div className="mt-4 rounded-lg bg-gray-50 p-4">
        <p className="whitespace-pre-wrap leading-relaxed text-tech-text">{transcriptData.transcript}</p>
      </div>
      {segments.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-3 text-base font-semibold text-tech-text">转录分段</h4>
          <div className="space-y-2">
            {segments.map((segment, index) => (
              <div key={index} className="rounded-lg border border-tech-border bg-gray-50 p-3">
                <p className="mb-1 font-mono text-xs text-tech-muted">{formatRange(segment.start, segment.end)}</p>
                <p className="text-sm leading-relaxed text-tech-text">{segment.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ScriptTab({ cleaned }: { cleaned: CleanedScript }) {
  const output = cleaned.output;

  if (!output) {
    return <EmptyContent title="暂无内容" description="AI 洗稿完成后会显示在这里。" />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-tech-text">AI 洗稿成果</h3>
        <p className="mt-1 text-sm text-tech-muted">面向二次创作的标题、摘要、要点和成稿。</p>
      </div>
      {output.title && <ContentBlock label="标题" value={output.title} strong />}
      {output.summary && <ContentBlock label="摘要" value={output.summary} />}
      {output.keyPoints && output.keyPoints.length > 0 && (
        <div>
          <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">核心要点</label>
          <div className="space-y-2">
            {output.keyPoints.map((point, index) => (
              <p key={index} className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-tech-text">{point}</p>
            ))}
          </div>
        </div>
      )}
      {output.cleanScript && <ContentBlock label="清洗后的脚本" value={output.cleanScript} multiline />}
      {output.qualityNotes && output.qualityNotes.length > 0 && (
        <div className="space-y-2">
          {output.qualityNotes.map((note, index) => (
            <p key={index} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function buildOutcomes(
  job: Job,
  cleaned: CleanedScript | null,
  rawTranscript: RawTranscript | null,
  videoOutput: HyperframesVideoOutput | null,
  cleanedError: string | null,
  transcriptError: string | null,
  videoError: string | null
) {
  return [
    {
      id: 'script' as OutcomeTab,
      label: 'AI 洗稿',
      icon: Sparkles,
      status: getOutcomeStatus(Boolean(cleaned?.output?.cleanScript), job.steps?.clean?.status, cleanedError),
    },
    {
      id: 'transcript' as OutcomeTab,
      label: '视频转录',
      icon: Mic,
      status: getOutcomeStatus(Boolean(rawTranscript?.transcript || cleaned?.output?.rawText), job.steps?.transcribe?.status, transcriptError),
    },
    {
      id: 'prompts' as OutcomeTab,
      label: '分镜',
      icon: Wand2,
      status: getOutcomeStatus(
        Boolean(cleaned?.output?.shortVideoShots?.length || cleaned?.output?.videoPrompts?.length || cleaned?.output?.enhancedScenes?.length),
        job.steps?.generate_video_prompts?.status,
        null
      ),
    },
    {
      id: 'video' as OutcomeTab,
      label: '视频成片',
      icon: Video,
      status: getOutcomeStatus(Boolean(videoOutput?.videoPath), job.steps?.generate_video?.status, videoError),
    },
  ];
}

function getOutcomeStatus(ready: boolean, stepStatus?: PipelineStepState['status'], error?: string | null): OutcomeStatus {
  if (ready) return 'ready';
  if (error || stepStatus === 'failed') return 'failed';
  if (stepStatus === 'running') return 'processing';
  return 'waiting';
}

function OutcomeStatusBadge({ status }: { status: OutcomeStatus }) {
  const config: Record<OutcomeStatus, string> = {
    ready: 'bg-emerald-50 text-emerald-700',
    processing: 'bg-cyan-50 text-cyan-700',
    waiting: 'bg-gray-100 text-tech-muted',
    failed: 'bg-red-50 text-red-700',
  };
  const labels: Record<OutcomeStatus, string> = {
    ready: '可用',
    processing: '处理中',
    waiting: '等待中',
    failed: '失败',
  };
  return <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${config[status]}`}>{labels[status]}</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <label className="mb-1 block text-xs text-tech-muted">{label}</label>
      <p className="text-sm text-tech-text">{value}</p>
    </div>
  );
}

function ContentBlock({ label, value, strong = false, multiline = false }: { label: string; value: string; strong?: boolean; multiline?: boolean }) {
  return (
    <div>
      <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">{label}</label>
      <div className="rounded-lg bg-gray-50 px-4 py-3">
        <p className={`${strong ? 'text-xl font-semibold' : 'text-sm'} ${multiline ? 'whitespace-pre-wrap leading-7' : ''} text-tech-text`}>
          {value}
        </p>
      </div>
    </div>
  );
}

function Notice({ tone, title, children }: { tone: 'info' | 'warning' | 'danger'; title: string; children: ReactNode }) {
  const config = {
    info: 'border-blue-200 bg-blue-50 text-blue-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
  }[tone];
  return (
    <div className={`rounded-lg border p-4 ${config}`}>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm">{children}</p>
    </div>
  );
}

function EmptyContent({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-tech-border bg-gray-50 py-14 text-center">
      <Clock className="mx-auto mb-4 h-9 w-9 text-tech-muted" />
      <h3 className="font-semibold text-tech-text">{title}</h3>
      <p className="mt-2 text-sm text-tech-muted">{description}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null;
  }
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase text-tech-muted">{label}</label>
      <p className="break-all rounded bg-gray-50 px-3 py-2 font-mono text-xs text-tech-text">{value}</p>
    </div>
  );
}

function buildTimeline(job: Job) {
  const STEPS = ['transcribe', 'clean', 'generate_video_prompts', 'generate_video'] as PipelineStep[];
  const STEP_LABELS: Record<PipelineStep, string> = {
    transcribe: '视频转录',
    clean: 'AI 洗稿',
    generate_video_prompts: '生成分镜',
    generate_video: '生成视频',
  };
  if (!job.steps) {
    return [];
  }
  return STEPS.flatMap((step) => {
    const state = job.steps?.[step];
    if (!state) {
      return [];
    }
    const events: Array<{ label: string; time: string; failed?: boolean }> = [];
    if (state.startedAt) {
      events.push({ label: `开始${STEP_LABELS[step]}`, time: state.startedAt });
    }
    if (state.finishedAt) {
      events.push({
        label: state.status === 'failed' ? `${STEP_LABELS[step]}失败` : `${STEP_LABELS[step]}完成`,
        time: state.finishedAt,
        failed: state.status === 'failed',
      });
    }
    return events;
  });
}

function formatShotType(type?: ShotType) {
  const labels: Record<ShotType, string> = {
    hook: '开场钩子',
    problem: '问题',
    explain: '解释',
    proof: '验证',
    contrast: '对比',
    process: '流程',
    summary: '总结',
    cta: '行动引导',
  };
  return type ? labels[type] : '内容镜头';
}

function formatLayout(layout: ShotLayout) {
  const labels: Record<ShotLayout, string> = {
    'kinetic-title': '动态标题',
    'concept-map': '概念关系',
    'process-flow': '流程图',
    comparison: '对比画面',
    metric: '数据状态',
    'summary-stack': '总结收束',
  };
  return labels[layout];
}

function formatSeconds(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatRange(start?: number, end?: number) {
  if (typeof start !== 'number' && typeof end !== 'number') {
    return '时间未标记';
  }
  return `${typeof start === 'number' ? formatSeconds(start) : '--'} - ${
    typeof end === 'number' ? formatSeconds(end) : '--'
  }`;
}

function formatTrashRetention(value?: string) {
  if (!value) {
    return '保留期未知';
  }
  const days = Math.ceil((new Date(value).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) {
    return '即将自动清理';
  }
  return `剩余 ${days} 天自动清理`;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getApiErrorStatus(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status;
}

function getApiErrorMessage(error: unknown) {
  const responseMessage = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  if (responseMessage) return responseMessage;
  return error instanceof Error ? error.message : '未知错误';
}
