import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain,
  CheckCircle2,
  Copy,
  Edit3,
  Eye,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { apiClient } from '../services/api';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { SkillViewModal } from '../features/skills/SkillViewModal';
import type { SkillSummary } from '../types';

export function SkillListPage() {
  const navigate = useNavigate();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);

  // 查看 Skill 内容
  const [viewingSkill, setViewingSkill] = useState(false);
  const [skillContent, setSkillContent] = useState<{
    skillName: string;
    skillPath: string;
    skillMarkdown: string;
    sourceMarkdown: string;
    meta: any;
    knowledgeBase?: string;
    caseLibrary?: string;
    quotesCollection?: string;
    checklist?: string;
    decisionFramework?: string;
    evalCases?: string;
    templates?: Array<{ name: string; content: string }>;
  } | null>(null);
  // 重命名状态
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const data = await apiClient.getSkills();
      setSkills(data.skills || []);
    } catch (err: any) {
      setError(err.response?.data?.message || '加载 Skill 列表失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleView = async (collectionId: string) => {
    setViewingSkill(true);
    try {
      const data = await apiClient.getSkillContent(collectionId);
      setSkillContent(data);
    } catch (err: any) {
      setActionError(err.response?.data?.message || '读取 Skill 失败');
    } finally {
      setViewingSkill(false);
    }
  };

  const handleDelete = async (collectionId: string) => {
    setDeletingId(collectionId);
    try {
      await apiClient.deleteSkill(collectionId);
      setDeleteConfirm(null);
      await refresh();
    } catch (err: any) {
      setActionError(err.response?.data?.message || '删除 Skill 失败');
    } finally {
      setDeletingId(null);
    }
  };

  const startRename = (skill: SkillSummary) => {
    setRenamingId(skill.collectionId);
    setRenameValue(skill.skillName);
  };

  const handleRename = async (collectionId: string) => {
    if (!renameValue.trim() || renaming) return;
    setRenaming(true);
    try {
      await apiClient.renameSkill(collectionId, renameValue.trim());
      setRenamingId(null);
      setRenameValue('');
      await refresh();
    } catch (err: any) {
      setActionError(err.response?.data?.message || '重命名失败');
    } finally {
      setRenaming(false);
    }
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[420px]">
          <Loader2 className="mx-auto h-12 w-12 animate-spin text-ai" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader
        /* 标题层级与字重统一到 PageHeader（原来这里用 font-bold，其余页面是 font-semibold） */
        title={
          <span className="inline-flex items-center gap-2">
            <Brain size={24} className="text-ai" aria-hidden="true" />
            Skill 管理
          </span>
        }
        description="从合集转录文本蒸馏的结构化知识库，可在 Claude Code 中作为 Skill 使用"
        actions={
          <Button variant="outline" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />
            刷新
          </Button>
        }
      />

      {/* ⚠️ 错误与空态互斥（同上） */}
      {error && skills.length > 0 && (
        <div className="mb-5 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </div>
      )}

      {/* Skill 列表 */}
      {skills.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-panel p-16 text-center">
          <Brain size={48} className="mx-auto text-ink-muted mb-4" />
          <h3 className="text-lg font-medium text-ink mb-2">
            尚无已生成的 Skill
          </h3>
          <p className="text-sm text-ink-muted mb-6 max-w-md mx-auto">
            在合集详情页中，将已转录的视频通过 AI 蒸馏生成结构化 Skill，
            即可在此集中管理。
          </p>
          <button
            onClick={() => navigate('/collections')}
            className="inline-flex items-center gap-2 rounded-lg bg-ai px-4 py-2 text-sm font-medium text-on-accent hover:bg-ai transition-all"
          >
            <Users size={14} />
            前往合集页面
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {skills.map((skill) => (
            <div
              key={skill.collectionId}
              className="rounded-lg border border-line bg-panel p-5 hover:border-ai-line/30 hover:shadow-sm transition-all"
            >
              {/* Skill 名称 */}
              <div className="flex items-start gap-3 mb-3">
                <SkillAvatar
                  avatarUrl={skill.avatarUrl}
                  nickname={skill.collectionNickname}
                />
                <div className="min-w-0 flex-1">
                  {renamingId === skill.collectionId ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(skill.collectionId);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className="w-full rounded border border-ai-line bg-panel px-2 py-1 text-sm font-semibold text-ink focus:outline-none focus:ring-1 focus:ring-ai"
                        autoFocus
                        disabled={renaming}
                      />
                      <button
                        onClick={() => handleRename(skill.collectionId)}
                        disabled={renaming || !renameValue.trim()}
                        className="shrink-0 rounded bg-ai px-2 py-1 text-xs text-on-accent hover:bg-ai disabled:opacity-50"
                      >
                        {renaming ? <Loader2 size={12} className="animate-spin" /> : '保存'}
                      </button>
                      <button
                        onClick={() => setRenamingId(null)}
                        disabled={renaming}
                        className="shrink-0 rounded border border-line px-2 py-1 text-xs text-ink-muted hover:bg-elevated"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <h3 className="font-semibold text-ink truncate">
                        {skill.skillName}
                      </h3>
                    </div>
                  )}
                  <p className="text-xs text-ink-muted mt-0.5 truncate">
                    来源合集：{skill.collectionNickname}
                  </p>
                </div>
              </div>

              {/* 元信息 */}
              <div className="flex flex-wrap gap-2 mb-4 text-xs text-ink-muted">
                {skill.autoSyncSkill && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-success">
                    <CheckCircle2 size={10} />
                    自动同步
                  </span>
                )}
                <span className="rounded-full bg-canvas px-2 py-0.5">
                  {skill.transcribedCount} 条转录
                </span>
                {skill.skillGeneratedAt && (
                  <span className="rounded-full bg-canvas px-2 py-0.5">
                    {new Date(skill.skillGeneratedAt).toLocaleDateString('zh-CN')}
                  </span>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center gap-2 relative">
                <button
                  onClick={() => handleView(skill.collectionId)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-ai px-3 py-2 text-xs font-medium text-on-accent hover:bg-ai transition-colors"
                >
                  <Eye size={12} />
                  查看
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedMenu(expandedMenu === skill.collectionId ? null : skill.collectionId)}
                  className="shrink-0 rounded-lg border border-line px-2 py-2 text-xs text-ink-muted hover:bg-elevated transition-colors"
                  aria-label="更多操作"
                >
                  <MoreHorizontal size={14} />
                </button>
                {expandedMenu === skill.collectionId && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setExpandedMenu(null)} />
                    <div className="absolute right-0 top-full mt-1 z-20 rounded-lg border border-line bg-panel shadow-lg py-1 min-w-[140px]">
                      <button
                        onClick={() => { setExpandedMenu(null); navigate(`/collections/${skill.collectionId}`); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-elevated"
                      >
                        <Users size={14} />
                        打开合集
                      </button>
                      <button
                        onClick={() => { setExpandedMenu(null); startRename(skill); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-elevated"
                      >
                        <Edit3 size={14} />
                        重命名
                      </button>
                      <hr className="border-line" />
                      <button
                        onClick={() => { setExpandedMenu(null); setDeleteConfirm(skill.collectionId); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger-soft"
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    </div>
                  </>
                )}
                {deleteConfirm === skill.collectionId && (
                  <ConfirmDialog
                    open={true}
                    title="确认删除 Skill？"
                    description={`Skill「${skill.skillName}」将从本地删除，合集不受影响。`}
                    confirmLabel="删除"
                    tone="danger"
                    busy={deletingId === skill.collectionId}
                    onConfirm={() => handleDelete(skill.collectionId)}
                    onClose={() => setDeleteConfirm(null)}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Skill 内容查看 Modal */}
      {skillContent && (
        <SkillViewModal
          data={skillContent}
          loading={viewingSkill}
          onClose={() => setSkillContent(null)}
        />
      )}

      {/* Action error toast */}
      {actionError && (
        <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger shadow-lg">
          {actionError}
          <button className="ml-3 font-medium underline" onClick={() => setActionError(null)}>
            关闭
          </button>
        </div>
      )}
    </Layout>
  );
}

function SkillAvatar({ avatarUrl, nickname }: { avatarUrl?: string; nickname?: string }) {
  const [failed, setFailed] = useState(false);

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt={nickname}
        className="h-10 w-10 shrink-0 rounded-lg object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas text-sm font-bold text-ink-muted">
      {nickname?.charAt(0) || <Brain size={16} />}
    </div>
  );
}
