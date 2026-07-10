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
  Sparkles,
  Trash2,
  Video,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiClient } from '../services/api';
import type {
  Job,
  CleanedScript,
  RawTranscript,
  PipelineStep,
  PipelineStepState,
  HyperframesVideoOutput,
  ShortVideoShot,
} from '../types';

type OutcomeTab = 'transcript' | 'script' | 'prompts' | 'video';
type OutcomeStatus = 'ready' | 'processing' | 'waiting' | 'failed';

const pipelineSteps: Array<{ id: PipelineStep; label: string; description: string; icon: typeof Video }> = [
  { id: 'transcribe', label: '视频转录', description: '下载视频、提取音频并转成文案', icon: Mic },
  { id: 'clean', label: 'AI 洗稿', description: '生成创作文稿', icon: Sparkles },
  { id: 'generate_video_prompts', label: '生成视频提示词', description: '规划竖屏画面', icon: Wand2 },
  { id: 'generate_video', label: '生成视频', description: '渲染竖屏成片', icon: Video },
];

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

    try {
      const cleanedData = await apiClient.getJobCleaned(jobData.id);
      setCleaned(cleanedData);
      if (cleanedData.output?.hyperframesVideo) {
        setVideoOutput(cleanedData.output.hyperframesVideo);
      }
    } catch (err) {
      setCleaned(null);
      if (jobData.steps?.clean?.status === 'failed' || jobData.status === 'done') {
        const errMsg = err instanceof Error ? err.message : '未知错误';
        setCleanedError(`内容加载失败: ${errMsg}`);
      }
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
    } else if (jobData.steps?.generate_video?.status === 'failed') {
      setVideoError('视频生成失败，可在当前步骤重试');
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

  const focus = useMemo(() => job ? getFocusStep(job, runningStep) : null, [job, runningStep]);

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
        <div className="rounded-lg border border-tech-border bg-tech-surface py-20 text-center">
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
    const ok = window.confirm('确定删除这个作品吗？删除后会进入垃圾桶，30 天内可恢复。');
    if (!ok) return;

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
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-tech-border text-tech-muted transition-colors hover:bg-tech-surface hover:text-tech-text"
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
            onClick={handleDeleteJob}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 px-4 py-2.5 font-medium text-red-600 transition-all hover:bg-red-50"
          >
            <Trash2 size={16} />
            删除作品
          </button>
        )}
      </div>

      {actionError && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {actionError}
        </div>
      )}

      {job.deletedAt && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-700">
          此作品已在垃圾桶中，{formatTrashRetention(job.trashExpiresAt)}
        </div>
      )}

      <CurrentStepHero
        job={job}
        focus={focus}
        runningStep={runningStep}
        onRunStep={handleRunStep}
      />

      <WorkflowStepper job={job} runningStep={runningStep} />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-lg border border-tech-border bg-tech-surface">
          <div className="flex overflow-x-auto border-b border-tech-border bg-tech-bg p-2">
            {outcomes.map((tab) => {
              const Icon = tab.icon;
              const active = activeOutcome.id === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`mr-2 flex min-w-[154px] items-center justify-between gap-3 rounded-lg px-4 py-3 text-left transition-all ${
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
              <VideoContentView output={videoOutput} jobId={job.id} videoError={videoError} />
            )}
          </div>
        </div>

        <aside className="space-y-6">
          <TimelinePanel job={job} />
          <AdvancedInfo job={job} />
        </aside>
      </div>
    </Layout>
  );
}

function CurrentStepHero({
  job,
  focus,
  runningStep,
  onRunStep,
}: {
  job: Job;
  focus: FocusStep | null;
  runningStep: PipelineStep | null;
  onRunStep: (step: PipelineStep) => void;
}) {
  const completed = getCompletedCount(job);
  const total = pipelineSteps.length;
  const percent = Math.round((completed / total) * 100);
  const hero = getHeroCopy(job, focus);
  const actionDisabled = !focus || focus.disabled || Boolean(job.deletedAt);

  return (
    <section className="overflow-hidden rounded-lg border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-purple-50 p-6 shadow-sm">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-tech-purple shadow-sm">
            <Sparkles size={14} />
            当前步骤
          </p>
          <h2 className="text-2xl font-semibold text-tech-text">{hero.title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-tech-muted">{hero.description}</p>
          <div className="mt-5 max-w-lg">
            <div className="mb-2 flex items-center justify-between text-xs font-medium text-tech-muted">
              <span>主链路进度</span>
              <span>{completed}/{total} · {percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-gradient-to-r from-tech-blue to-tech-purple transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
          {focus?.step && (
            <button
              type="button"
              disabled={actionDisabled}
              onClick={() => onRunStep(focus.step)}
              className={`inline-flex min-w-40 items-center justify-center gap-2 rounded-lg px-5 py-3 font-medium transition-all ${
                focus.status === 'failed'
                  ? 'border border-red-200 bg-white text-red-600 hover:bg-red-50'
                  : 'bg-tech-blue text-white shadow-sm hover:bg-tech-blue-dark hover:shadow'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {runningStep === focus.step ? <Loader2 className="animate-spin" size={18} /> : getActionIcon(focus)}
              {runningStep === focus.step ? '执行中...' : focus.actionLabel}
            </button>
          )}
          <StatusChip job={job} />
        </div>
      </div>
    </section>
  );
}

function WorkflowStepper({ job, runningStep }: { job: Job; runningStep: PipelineStep | null }) {
  return (
    <section className="mt-6 rounded-lg border border-tech-border bg-tech-surface p-5">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold text-tech-text">Workflow</h3>
          <p className="mt-1 text-sm text-tech-muted">从视频素材到创作成果的主链路</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {pipelineSteps.map((step, index) => {
          const state = getStepState(job, step.id, runningStep);
          const Icon = step.icon;
          return (
            <div key={step.id} className={`rounded-lg border p-4 ${getStepCardClass(state.status)}`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className={`flex h-8 w-8 items-center justify-center rounded-full ${getStepIconClass(state.status)}`}>
                  {state.status === 'succeeded' ? <Check size={16} /> : <Icon size={16} />}
                </span>
                <span className="text-xs font-medium text-tech-muted">0{index + 1}</span>
              </div>
              <h4 className="font-semibold text-tech-text">{step.label}</h4>
              <p className="mt-1 text-xs leading-5 text-tech-muted">{step.description}</p>
              <p className="mt-3 text-xs font-medium">{getStepStatusLabel(state.status)}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

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
    return <Notice tone="danger" title="AI 洗稿加载失败">{cleanedError}</Notice>;
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
    return <EmptyContent title="镜头列表还没生成" description="完成生成视频提示词后，这里会显示 HyperFrames 使用的短视频镜头规划。" />;
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
            <div key={scene.scene} className="rounded-lg border border-tech-border bg-tech-bg p-4">
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
            <p key={index} className="rounded-lg border border-tech-border bg-tech-bg p-4 text-sm leading-6 text-tech-text">
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
              <div key={index} className="rounded-lg border border-tech-border bg-tech-bg p-4">
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
  const visibleLayers = layers.filter((layer) => layer.type !== 'caption').slice(0, 6);

  return (
    <div className="rounded-lg border border-tech-border bg-tech-bg p-4">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-purple-600">Shot {shot.index} · {shot.shotType}</p>
          <h4 className="mt-1 text-base font-semibold text-tech-text">{shot.subject}</h4>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-tech-muted">
          <span className="rounded-full bg-white px-2 py-1">{formatSeconds(shot.duration)}</span>
          <span className="rounded-full bg-white px-2 py-1">{shot.transition}</span>
          <span className="rounded-full bg-white px-2 py-1">{shot.pacing}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Metric label="画面动作" value={shot.action} />
        <Metric label="镜头运动" value={shot.cameraMotion} />
      </div>

      <div className="mt-3 rounded-lg border border-purple-100 bg-white p-3">
        <label className="mb-1 block text-xs font-medium uppercase text-purple-500">字幕</label>
        <p className="text-sm leading-6 text-tech-text">{shot.caption}</p>
      </div>

      {shot.emphasisWords?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {shot.emphasisWords.map((word, index) => (
            <span key={`${word}-${index}`} className="rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700">
              {word}
            </span>
          ))}
        </div>
      )}

      {visibleLayers.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {visibleLayers.map((layer, index) => (
            <div key={`${layer.type}-${index}`} className="rounded-lg border border-tech-border bg-white p-3">
              <p className="text-xs font-semibold uppercase text-tech-muted">{layer.type}</p>
              <p className="mt-1 text-sm leading-5 text-tech-text">{layer.content}</p>
              {(layer.motion || layer.style) && (
                <p className="mt-1 text-xs text-tech-muted">{[layer.motion, layer.style].filter(Boolean).join(' · ')}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {shot.narration && (
        <p className="mt-3 text-sm leading-6 text-tech-muted">{shot.narration}</p>
      )}
    </div>
  );
}

function VideoContentView({
  output,
  jobId,
  videoError,
}: {
  output: HyperframesVideoOutput | null;
  jobId: string;
  videoError: string | null;
}) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!output) {
      return;
    }
    const loadVideoUrl = async () => {
      try {
        const url = await apiClient.downloadVideo(jobId);
        setVideoUrl(url);
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
    return <EmptyContent title="视频还没生成" description="完成生成视频提示词后，可以执行生成视频步骤，渲染 9:16 竖屏 MP4。" />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-tech-text">视频成片</h3>
          <p className="mt-1 text-sm text-tech-muted">HyperFrames 本地渲染的竖屏解释视频。</p>
        </div>
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

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Metric label="渲染器" value={output.provider} />
        <Metric label="尺寸" value={`${output.width}x${output.height} · ${output.aspectRatio}`} />
        <Metric label="时长" value={formatSeconds(output.duration)} />
      </div>

      <div className="rounded-lg bg-tech-bg p-4">
        <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">视频文件</label>
        <p className="break-all font-mono text-xs text-tech-text">{output.videoPath}</p>
      </div>
      <div className="rounded-lg bg-tech-bg p-4">
        <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">HyperFrames 项目</label>
        <p className="break-all font-mono text-xs text-tech-text">{output.projectPath}</p>
      </div>

      {output.scenes?.length > 0 && (
        <div>
          <h4 className="mb-3 text-base font-semibold text-tech-text">渲染镜头</h4>
          <div className="space-y-3">
            {output.scenes.map((scene) => (
              <div key={scene.index} className="rounded-lg border border-tech-border bg-tech-bg p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="font-semibold text-tech-text">{scene.index}. {scene.subject ?? scene.title ?? '镜头'}</p>
                  <span className="shrink-0 rounded-full bg-white px-2 py-1 text-xs text-tech-muted">
                    {[formatSeconds(scene.duration), scene.transition, scene.pacing].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {scene.action && <p className="text-sm leading-6 text-tech-text">{scene.action}</p>}
                {scene.caption && (
                  <p className="mt-2 rounded-lg bg-white p-3 text-sm leading-6 text-tech-text">{scene.caption}</p>
                )}
                {scene.bullets?.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-tech-text">
                    {scene.bullets.map((bullet, index) => (
                      <li key={index}>{bullet}</li>
                    ))}
                  </ul>
                )}
                {scene.emphasisWords?.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {scene.emphasisWords.map((word, index) => (
                      <span key={`${word}-${index}`} className="rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700">
                        {word}
                      </span>
                    ))}
                  </div>
                )}
                {scene.narration && (
                  <p className="mt-3 text-sm leading-6 text-tech-muted">{scene.narration}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TimelinePanel({ job }: { job: Job }) {
  const events = buildTimeline(job);
  return (
    <div className="rounded-lg border border-tech-border bg-tech-surface p-5">
      <h3 className="font-semibold text-tech-text">Timeline</h3>
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
    <details className="rounded-lg border border-tech-border bg-tech-surface p-5">
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
      <div className="mt-4 rounded-lg bg-tech-bg p-4">
        <p className="whitespace-pre-wrap leading-relaxed text-tech-text">{transcriptData.transcript}</p>
      </div>
      {segments.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-3 text-base font-semibold text-tech-text">转录分段</h4>
          <div className="space-y-2">
            {segments.map((segment, index) => (
              <div key={index} className="rounded-lg border border-tech-border bg-tech-bg p-3">
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
        <h3 className="text-lg font-semibold text-tech-text">AI Rewrite</h3>
        <p className="mt-1 text-sm text-tech-muted">面向二次创作的标题、摘要、要点和成稿。</p>
      </div>
      {output.title && <ContentBlock label="标题" value={output.title} strong />}
      {output.summary && <ContentBlock label="摘要" value={output.summary} />}
      {output.keyPoints && output.keyPoints.length > 0 && (
        <div>
          <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">核心要点</label>
          <div className="space-y-2">
            {output.keyPoints.map((point, index) => (
              <p key={index} className="rounded-lg bg-tech-bg px-4 py-3 text-sm text-tech-text">{point}</p>
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
      label: 'AI Rewrite',
      icon: Sparkles,
      status: getOutcomeStatus(Boolean(cleaned?.output?.cleanScript), job.steps?.clean?.status, cleanedError),
    },
    {
      id: 'transcript' as OutcomeTab,
      label: 'Transcript',
      icon: Mic,
      status: getOutcomeStatus(Boolean(rawTranscript?.transcript || cleaned?.output?.rawText), job.steps?.transcribe?.status, transcriptError),
    },
    {
      id: 'prompts' as OutcomeTab,
      label: '镜头列表',
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

type FocusStep = {
  step: PipelineStep;
  status: PipelineStepState['status'];
  blocked: boolean;
  disabled: boolean;
  actionLabel: string;
};

function getFocusStep(job: Job, runningStep: PipelineStep | null): FocusStep | null {
  if (job.workflowMode !== 'manual' || !job.steps) {
    return null;
  }
  const failed = pipelineSteps.find((step) => job.steps?.[step.id]?.status === 'failed')?.id;
  const running = pipelineSteps.find((step) => job.steps?.[step.id]?.status === 'running')?.id;
  const next = failed || running || pipelineSteps.find((step) => job.steps?.[step.id]?.status !== 'succeeded')?.id;
  if (!next) {
    return null;
  }
  const index = pipelineSteps.findIndex((step) => step.id === next);
  const previous = index > 0 ? job.steps[pipelineSteps[index - 1].id] : null;
  const state = job.steps[next];
  const blocked = Boolean(previous && previous.status !== 'succeeded');
  const disabled =
    Boolean(runningStep) ||
    blocked ||
    state.status === 'running' ||
    state.status === 'succeeded';
  return {
    step: next,
    status: state.status,
    blocked,
    disabled,
    actionLabel: getStepActionLabel(state, blocked),
  };
}

function getHeroCopy(job: Job, focus: FocusStep | null) {
  if (job.status === 'done') {
    return {
      title: '作品资产已生成',
      description: '可以查看视频转录、AI 洗稿、视频提示词和视频成片，也可以回到创作中心继续处理其他作品。',
    };
  }
  if (job.status === 'failed') {
    return {
      title: focus ? `${getPipelineStepLabel(focus.step)}遇到问题` : '作品处理失败',
      description: '查看错误摘要后可以重试当前步骤，或在高级信息中检查更详细的错误。',
    };
  }
  if (focus?.blocked) {
    return {
      title: `等待上一步完成`,
      description: `${getPipelineStepLabel(focus.step)}需要前置步骤成功后才能执行。`,
    };
  }
  if (focus?.status === 'running') {
    return {
      title: `正在${getPipelineStepLabel(focus.step)}`,
      description: '系统正在处理当前步骤，完成后会刷新对应的创作成果。',
    };
  }
  if (focus) {
    return {
      title: `下一步：${getPipelineStepLabel(focus.step)}`,
      description: '点击主按钮执行当前步骤。失败时系统会自动尝试 3 次。',
    };
  }
  return {
    title: '历史作品',
    description: '这个作品来自旧流程，仍可查看已有结果。',
  };
}

function getActionIcon(focus: FocusStep) {
  if (focus.status === 'failed') return <RotateCcw size={18} />;
  if (focus.status === 'running') return <Loader2 className="animate-spin" size={18} />;
  return <Play size={18} />;
}

function getCompletedCount(job: Job) {
  if (!job.steps) {
    return job.status === 'done' ? pipelineSteps.length : 0;
  }
  return pipelineSteps.filter((step) => job.steps?.[step.id]?.status === 'succeeded').length;
}

function getStepState(job: Job, step: PipelineStep, runningStep: PipelineStep | null) {
  const state = job.steps?.[step] ?? { status: 'pending' as PipelineStepState['status'], attempts: 0 };
  if (runningStep === step) {
    return { ...state, status: 'running' as PipelineStepState['status'] };
  }
  return state;
}

function StatusChip({ job }: { job: Job }) {
  const config = {
    queued: 'border-blue-200 bg-blue-50 text-blue-700',
    processing: 'border-cyan-200 bg-cyan-50 text-cyan-700',
    done: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    failed: 'border-red-200 bg-red-50 text-red-700',
  }[job.status] ?? 'border-tech-border bg-tech-bg text-tech-muted';
  return (
    <span className={`inline-flex items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium ${config}`}>
      {getJobStatusLabel(job.status)}
    </span>
  );
}

function OutcomeStatusBadge({ status }: { status: OutcomeStatus }) {
  const config: Record<OutcomeStatus, string> = {
    ready: 'bg-emerald-50 text-emerald-700',
    processing: 'bg-cyan-50 text-cyan-700',
    waiting: 'bg-tech-bg text-tech-muted',
    failed: 'bg-red-50 text-red-700',
  };
  return <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${config[status]}`}>{getOutcomeStatusLabel(status)}</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-tech-bg px-4 py-3">
      <label className="mb-1 block text-xs text-tech-muted">{label}</label>
      <p className="text-sm text-tech-text">{value}</p>
    </div>
  );
}

function ContentBlock({ label, value, strong = false, multiline = false }: { label: string; value: string; strong?: boolean; multiline?: boolean }) {
  return (
    <div>
      <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">{label}</label>
      <div className="rounded-lg bg-tech-bg px-4 py-3">
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
    <div className="rounded-lg border border-dashed border-tech-border bg-tech-bg py-14 text-center">
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
      <p className="break-all rounded bg-tech-bg px-3 py-2 font-mono text-xs text-tech-text">{value}</p>
    </div>
  );
}

function buildTimeline(job: Job) {
  if (!job.steps) {
    return [];
  }
  return pipelineSteps.flatMap((step) => {
    const state = job.steps?.[step.id];
    if (!state) {
      return [];
    }
    const events: Array<{ label: string; time: string; failed?: boolean }> = [];
    if (state.startedAt) {
      events.push({ label: `开始${step.label}`, time: state.startedAt });
    }
    if (state.finishedAt) {
      events.push({
        label: state.status === 'failed' ? `${step.label}失败` : `${step.label}完成`,
        time: state.finishedAt,
        failed: state.status === 'failed',
      });
    }
    return events;
  });
}

function getPipelineStepLabel(step: PipelineStep) {
  return pipelineSteps.find((item) => item.id === step)?.label || step;
}

function getStepActionLabel(state: PipelineStepState, blocked: boolean) {
  if (blocked) return '等待上一步';
  if (state.status === 'failed') return '重试';
  if (state.status === 'succeeded') return '已完成';
  if (state.status === 'running') return '执行中...';
  return '执行';
}

function getStepStatusLabel(status: PipelineStepState['status']) {
  const labels: Record<PipelineStepState['status'], string> = {
    pending: '待执行',
    running: '执行中',
    succeeded: '已完成',
    failed: '失败',
  };
  return labels[status];
}

function getStepCardClass(status: PipelineStepState['status']) {
  const classes: Record<PipelineStepState['status'], string> = {
    pending: 'border-tech-border bg-white',
    running: 'border-cyan-200 bg-cyan-50',
    succeeded: 'border-emerald-200 bg-emerald-50',
    failed: 'border-red-200 bg-red-50',
  };
  return classes[status];
}

function getStepIconClass(status: PipelineStepState['status']) {
  const classes: Record<PipelineStepState['status'], string> = {
    pending: 'bg-tech-bg text-tech-muted',
    running: 'bg-cyan-100 text-cyan-700',
    succeeded: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
  };
  return classes[status];
}

function getOutcomeStatusLabel(status: OutcomeStatus) {
  const labels: Record<OutcomeStatus, string> = {
    ready: 'Ready',
    processing: 'Processing',
    waiting: 'Waiting',
    failed: 'Failed',
  };
  return labels[status];
}

function getJobStatusLabel(status: Job['status']) {
  const labels: Record<Job['status'], string> = {
    queued: '待执行',
    processing: '处理中',
    done: '已完成',
    failed: '失败',
  };
  return labels[status];
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
