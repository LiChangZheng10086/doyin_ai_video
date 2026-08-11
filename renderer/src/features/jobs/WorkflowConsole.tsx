import React from 'react';
import { Play, RotateCcw, Loader2, Sparkles } from 'lucide-react';
import type { Job, PipelineStep } from '../../types/index';
import { buildWorkflowSteps } from './jobPresentation';
import { WorkflowStepper } from './WorkflowStepper';

export interface WorkflowConsoleProps {
  job: Job;
  runningStep: PipelineStep | null;
  actionError: string | null;
  onRunStep: (step: PipelineStep) => void;
}

export function WorkflowConsole({ job, runningStep, actionError, onRunStep }: WorkflowConsoleProps) {
  const steps = buildWorkflowSteps(job, runningStep);
  const focus = findFocusStep(steps);

  const completed = steps.filter((s) => s.status === 'succeeded').length;
  const total = steps.length;
  const percent = Math.round((completed / total) * 100);

  const hero = getConsoleCopy(job, focus);

  const isBusy = runningStep !== null;
  const isBlocked = focus?.blocked ?? false;
  const isFailed = focus?.status === 'failed';

  return (
    <section className="overflow-hidden rounded-lg border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-purple-50 p-6 shadow-sm">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-tech-purple shadow-sm">
            <Sparkles size={14} />
            {job.deletedAt ? '已归档' : job.status === 'done' ? '作品已完成' : '当前步骤'}
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
            {focus?.progress !== undefined && focus.status === 'running' && (
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-xs font-medium text-tech-muted">
                  <span>{focus.label}进行中</span>
                  <span>{Math.round(focus.progress)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full bg-tech-purple transition-all" style={{ width: `${Math.min(100, Math.round(focus.progress))}%` }} />
                </div>
              </div>
            )}
          </div>

          {actionError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {actionError}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
          {focus && (
            <button
              type="button"
              data-primary-action
              disabled={isBusy || isBlocked || Boolean(job.deletedAt)}
              onClick={() => onRunStep(focus.key)}
              className={`inline-flex min-w-40 items-center justify-center gap-2 rounded-lg px-5 py-3 font-medium transition-all ${
                isFailed
                  ? 'border border-red-200 bg-white text-red-600 hover:bg-red-50'
                  : 'bg-tech-blue text-white shadow-sm hover:bg-tech-blue-dark hover:shadow'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {isBusy ? <Loader2 className="animate-spin" size={18} /> : isFailed ? <RotateCcw size={18} /> : <Play size={18} />}
              {isBusy ? '执行中...' : focus.actionLabel}
            </button>
          )}
          <StatusChip job={job} />
        </div>
      </div>

      <WorkflowStepper steps={steps} />
    </section>
  );
}

function findFocusStep(steps: ReturnType<typeof buildWorkflowSteps>) {
  const failed = steps.find((s) => s.status === 'failed');
  if (failed) return failed;
  const running = steps.find((s) => s.status === 'running');
  if (running) return running;
  const next = steps.find((s) => s.status === 'pending');
  return next ?? null;
}

function getConsoleCopy(job: Job, focus: ReturnType<typeof buildWorkflowSteps>[number] | null) {
  if (job.deletedAt) {
    return { title: '作品已删除', description: '此作品在垃圾桶中，恢复后可继续操作。' };
  }
  if (job.status === 'done') {
    return { title: '作品资产已生成', description: '可以查看视频转录、AI 洗稿、分镜和视频成片。' };
  }
  if (!focus) {
    return { title: '历史作品', description: '这个作品来自旧流程，仍可查看已有结果。' };
  }
  if (focus.blocked) {
    return { title: `等待上一步完成`, description: `${focus.label}需要前置步骤成功后才能执行。` };
  }
  if (focus.status === 'running') {
    return { title: `正在${focus.label}`, description: '系统正在处理当前步骤，完成后会刷新对应的创作成果。' };
  }
  if (focus.status === 'failed') {
    return { title: `${focus.label}遇到问题`, description: '查看错误摘要后可以重试当前步骤。' };
  }
  return { title: `下一步：${focus.label}`, description: '点击主按钮执行当前步骤。失败时系统会自动尝试 3 次。' };
}

function StatusChip({ job }: { job: Job }) {
  const config: Record<string, string> = {
    queued: 'border-blue-200 bg-blue-50 text-blue-700',
    processing: 'border-cyan-200 bg-cyan-50 text-cyan-700',
    done: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    failed: 'border-red-200 bg-red-50 text-red-700',
  };
  const labels: Record<string, string> = {
    queued: '待执行',
    processing: '处理中',
    done: '已完成',
    failed: '失败',
  };
  const cls = config[job.status] ?? 'border-tech-border bg-gray-50 text-tech-muted';
  const label = labels[job.status] ?? job.status;
  return (
    <span className={`inline-flex items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium ${cls}`}>
      {label}
    </span>
  );
}
