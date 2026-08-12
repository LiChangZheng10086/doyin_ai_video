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
          <Loader2 className="mx-auto h-12 w-12 animate-spin text-tech-purple" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      {/* 页面标题 */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-xs text-tech-muted uppercase tracking-wider mb-1">
            知识库
          </p>
          <h1 className="text-2xl font-bold text-tech-text flex items-center gap-2">
            <Brain size={24} className="text-tech-purple" />
            Skill 管理
          </h1>
          <p className="mt-1 text-sm text-tech-muted">
            从合集转录文本蒸馏的结构化知识库，可在 Claude Code 中作为 Skill 使用
          </p>
        </div>
        <button
          onClick={refresh}
          className="inline-flex items-center gap-2 rounded-lg border border-tech-border px-3 py-2 text-sm text-tech-muted hover:text-tech-text hover:bg-tech-bg transition-colors"
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Skill 列表 */}
      {skills.length === 0 ? (
        <div className="rounded-lg border border-dashed border-tech-border bg-tech-surface p-16 text-center">
          <Brain size={48} className="mx-auto text-tech-muted mb-4" />
          <h3 className="text-lg font-medium text-tech-text mb-2">
            尚无已生成的 Skill
          </h3>
          <p className="text-sm text-tech-muted mb-6 max-w-md mx-auto">
            在合集详情页中，将已转录的视频通过 AI 蒸馏生成结构化 Skill，
            即可在此集中管理。
          </p>
          <button
            onClick={() => navigate('/collections')}
            className="inline-flex items-center gap-2 rounded-lg bg-tech-purple px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-all"
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
              className="rounded-lg border border-tech-border bg-tech-surface p-5 hover:border-tech-purple/30 hover:shadow-sm transition-all"
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
                        className="w-full rounded border border-tech-purple bg-white px-2 py-1 text-sm font-semibold text-tech-text focus:outline-none focus:ring-1 focus:ring-tech-purple"
                        autoFocus
                        disabled={renaming}
                      />
                      <button
                        onClick={() => handleRename(skill.collectionId)}
                        disabled={renaming || !renameValue.trim()}
                        className="shrink-0 rounded bg-tech-purple px-2 py-1 text-xs text-white hover:bg-purple-700 disabled:opacity-50"
                      >
                        {renaming ? <Loader2 size={12} className="animate-spin" /> : '保存'}
                      </button>
                      <button
                        onClick={() => setRenamingId(null)}
                        disabled={renaming}
                        className="shrink-0 rounded border border-tech-border px-2 py-1 text-xs text-tech-muted hover:bg-tech-bg"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <h3 className="font-semibold text-tech-text truncate">
                        {skill.skillName}
                      </h3>
                    </div>
                  )}
                  <p className="text-xs text-tech-muted mt-0.5 truncate">
                    来源合集：{skill.collectionNickname}
                  </p>
                </div>
              </div>

              {/* 元信息 */}
              <div className="flex flex-wrap gap-2 mb-4 text-xs text-tech-muted">
                {skill.autoSyncSkill && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
                    <CheckCircle2 size={10} />
                    自动同步
                  </span>
                )}
                <span className="rounded-full bg-tech-bg px-2 py-0.5">
                  {skill.transcribedCount} 条转录
                </span>
                {skill.skillGeneratedAt && (
                  <span className="rounded-full bg-tech-bg px-2 py-0.5">
                    {new Date(skill.skillGeneratedAt).toLocaleDateString('zh-CN')}
                  </span>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center gap-2 relative">
                <button
                  onClick={() => handleView(skill.collectionId)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-tech-purple px-3 py-2 text-xs font-medium text-white hover:bg-purple-700 transition-colors"
                >
                  <Eye size={12} />
                  查看
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedMenu(expandedMenu === skill.collectionId ? null : skill.collectionId)}
                  className="shrink-0 rounded-lg border border-tech-border px-2 py-2 text-xs text-tech-muted hover:bg-tech-bg transition-colors"
                  aria-label="更多操作"
                >
                  <MoreHorizontal size={14} />
                </button>
                {expandedMenu === skill.collectionId && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setExpandedMenu(null)} />
                    <div className="absolute right-0 top-full mt-1 z-20 rounded-lg border border-tech-border bg-white shadow-lg py-1 min-w-[140px]">
                      <button
                        onClick={() => { setExpandedMenu(null); navigate(`/collections/${skill.collectionId}`); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-tech-text hover:bg-tech-bg"
                      >
                        <Users size={14} />
                        打开合集
                      </button>
                      <button
                        onClick={() => { setExpandedMenu(null); startRename(skill); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-tech-text hover:bg-tech-bg"
                      >
                        <Edit3 size={14} />
                        重命名
                      </button>
                      <hr className="border-tech-border" />
                      <button
                        onClick={() => { setExpandedMenu(null); setDeleteConfirm(skill.collectionId); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
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
        <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
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
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-tech-purple to-tech-blue text-white text-sm font-bold">
      {nickname?.charAt(0) || <Brain size={16} />}
    </div>
  );
}
