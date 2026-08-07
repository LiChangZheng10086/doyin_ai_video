import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain,
  CheckCircle2,
  Copy,
  Edit3,
  Eye,
  Loader2,
  RefreshCw,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiClient } from '../services/api';
import type { SkillSummary } from '../types';

export function SkillListPage() {
  const navigate = useNavigate();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

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
      alert(err.response?.data?.message || '读取 Skill 失败');
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
      alert(err.response?.data?.message || '删除 Skill 失败');
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
      alert(err.response?.data?.message || '重命名失败');
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
            Knowledge Base
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {skills.map((skill) => (
            <div
              key={skill.collectionId}
              className="rounded-lg border border-tech-border bg-tech-surface p-5 hover:border-tech-purple/30 hover:shadow-sm transition-all"
            >
              {/* Skill 名称 */}
              <div className="flex items-start gap-3 mb-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-tech-purple to-tech-blue text-white">
                  <Brain size={18} />
                </div>
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
                    <div className="flex items-center gap-1.5 group/name">
                      <h3 className="font-semibold text-tech-text truncate">
                        {skill.skillName}
                      </h3>
                      <button
                        onClick={() => startRename(skill)}
                        className="shrink-0 p-0.5 rounded text-tech-muted opacity-0 group-hover/name:opacity-100 hover:text-tech-blue hover:bg-blue-50 transition-all"
                        title="重命名"
                      >
                        <Edit3 size={12} />
                      </button>
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
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleView(skill.collectionId)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-tech-border px-3 py-2 text-xs font-medium text-tech-text hover:bg-tech-bg transition-colors"
                >
                  <Eye size={12} />
                  查看
                </button>
                <button
                  onClick={() => navigate(`/collections/${skill.collectionId}`)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-tech-border px-3 py-2 text-xs font-medium text-tech-text hover:bg-tech-bg transition-colors"
                >
                  <Users size={12} />
                  打开合集
                </button>
                {deleteConfirm === skill.collectionId ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDelete(skill.collectionId)}
                      disabled={deletingId === skill.collectionId}
                      className="rounded-lg bg-red-600 px-2.5 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deletingId === skill.collectionId ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        '确认'
                      )}
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="rounded-lg border border-tech-border px-2 py-2 text-xs text-tech-muted hover:bg-tech-bg"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(skill.collectionId)}
                    className="rounded-lg border border-tech-border px-2.5 py-2 text-xs text-red-500 hover:bg-red-50 transition-colors"
                    title="删除 Skill"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Skill 内容查看 Modal（复用 SkillViewModal 逻辑） */}
      {skillContent && (
        <SkillViewModal
          data={skillContent}
          loading={false}
          onClose={() => setSkillContent(null)}
        />
      )}
    </Layout>
  );
}

// ─── Skill 内容查看 Modal（与 CollectionDetailPage 中的相同） ──────

function SkillViewModal({
  data,
  loading,
  onClose,
}: {
  data: {
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
  };
  loading: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<string>('skill');
  const [copied, setCopied] = useState(false);

  const getCurrentContent = () => {
    switch (tab) {
      case 'skill': return data.skillMarkdown;
      case 'source': return data.sourceMarkdown;
      case 'knowledge_base': return data.knowledgeBase || '';
      case 'case_library': return data.caseLibrary || '';
      case 'quotes': return data.quotesCollection || '';
      case 'checklist': return data.checklist || '';
      case 'decision': return data.decisionFramework || '';
      case 'evals': return data.evalCases || '';
      case 'meta': return JSON.stringify(data.meta, null, 2);
      default:
        if (tab.startsWith('tpl_') && data.templates) {
          const tplName = tab.slice(4);
          return data.templates.find(t => t.name === tplName)?.content || '';
        }
        return '';
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(getCurrentContent());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="rounded-xl bg-white p-8 shadow-2xl flex items-center gap-3">
          <Loader2 size={24} className="animate-spin text-tech-purple" />
          <span className="text-tech-text">加载 Skill 内容…</span>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: 'skill', label: 'SKILL.md' },
    ...(data.knowledgeBase ? [{ id: 'knowledge_base', label: '知识库' }] : []),
    ...(data.caseLibrary ? [{ id: 'case_library', label: '案例库' }] : []),
    ...(data.quotesCollection ? [{ id: 'quotes', label: '金句集' }] : []),
    ...(data.checklist ? [{ id: 'checklist', label: '检查清单' }] : []),
    ...(data.decisionFramework ? [{ id: 'decision', label: '决策框架' }] : []),
    ...(data.evalCases ? [{ id: 'evals', label: '验收用例' }] : []),
    ...(data.templates || []).map(t => ({ id: `tpl_${t.name}`, label: t.name })),
    { id: 'source', label: '原始来源' },
    { id: 'meta', label: '元信息' },
  ];

  const currentContent = getCurrentContent();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-tech-border px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <Brain size={20} className="text-tech-purple shrink-0" />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-tech-text truncate">
                {data.skillName}
              </h2>
              <p className="text-xs text-tech-muted truncate mt-0.5">
                {data.skillPath}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg transition-colors"
            >
              {copied ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Copy size={16} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-tech-muted hover:bg-tech-bg hover:text-tech-text transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 border-b border-tech-border bg-tech-bg px-6 py-2 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                tab === t.id
                  ? 'bg-white text-tech-text shadow-sm'
                  : 'text-tech-muted hover:text-tech-text'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'skill' || tab === 'knowledge_base' || tab === 'case_library' || tab === 'quotes' || tab === 'checklist' || tab === 'decision' || tab === 'evals' || tab.startsWith('tpl_') ? (
            <div className="p-6">
              <div className="prose prose-sm max-w-none">
                <RenderMarkdown content={currentContent} />
              </div>
            </div>
          ) : tab === 'source' ? (
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-tech-text p-6">
              {data.sourceMarkdown || '(暂无原始来源)'}
            </pre>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-tech-text p-6">
              {JSON.stringify(data.meta, null, 2) || '(暂无元信息)'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function RenderMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeContent = '';

  const elements: React.ReactNode[] = [];

  const flushCodeBlock = () => {
    if (codeContent) {
      elements.push(
        <pre key={elements.length} className="rounded-lg bg-tech-bg border border-tech-border p-4 my-3 overflow-x-auto">
          <code className="text-sm font-mono">{codeContent.trim()}</code>
        </pre>
      );
      codeContent = '';
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += (codeContent ? '\n' : '') + line;
      continue;
    }

    // Frontmatter detection
    if (i === 0 && line === '---') {
      let j = i + 1;
      while (j < lines.length && lines[j] !== '---') j++;
      if (j < lines.length) {
        const fmLines = lines.slice(i + 1, j);
        elements.push(
          <div key={elements.length} className="rounded-lg bg-tech-bg border border-tech-border p-3 my-3 font-mono text-sm text-tech-muted">
            {fmLines.map((fl, fi) => (
              <div key={fi}>{fl}</div>
            ))}
          </div>
        );
        i = j;
        continue;
      }
    }

    // Headings
    if (line.startsWith('### ')) {
      elements.push(<h3 key={elements.length} className="text-base font-semibold text-tech-text mt-5 mb-2">{line.slice(4)}</h3>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<h2 key={elements.length} className="text-lg font-bold text-tech-text mt-6 mb-3 border-b border-tech-border pb-1">{line.slice(3)}</h2>);
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(<h1 key={elements.length} className="text-xl font-bold text-tech-text mt-6 mb-3">{line.slice(2)}</h1>);
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      elements.push(
        <div key={elements.length} className="flex gap-2 text-sm text-tech-text ml-4 my-0.5">
          <span className="text-tech-muted min-w-[1.5em] text-right">{olMatch[1]}.</span>
          <span>{renderInline(olMatch[2])}</span>
        </div>
      );
      continue;
    }

    // Unordered list item
    if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '');
      elements.push(
        <div key={elements.length} className="flex gap-2 text-sm text-tech-text ml-4 my-0.5">
          <span className="text-tech-muted">•</span>
          <span>{renderInline(text)}</span>
        </div>
      );
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      elements.push(<div key={elements.length} className="h-2" />);
      continue;
    }

    // Bold text only
    if (/^\*\*.+\*\*$/.test(line.trim())) {
      elements.push(
        <p key={elements.length} className="text-sm font-semibold text-tech-text my-1">
          {line.trim().replace(/\*\*/g, '')}
        </p>
      );
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={elements.length} className="text-sm text-tech-text leading-relaxed my-1">
        {renderInline(line)}
      </p>
    );
  }

  flushCodeBlock();

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    const codeParts = part.split(/(`[^`]+`)/g);
    return codeParts.map((cp, j) => {
      if (cp.startsWith('`') && cp.endsWith('`')) {
        return <code key={j} className="bg-tech-bg px-1 py-0.5 rounded text-xs font-mono text-tech-purple">{cp.slice(1, -1)}</code>;
      }
      return cp;
    });
  });
}
