import React, { useState } from 'react';
import { Brain, CheckCircle2, Copy, Loader2, X } from 'lucide-react';

export interface SkillViewData {
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
}

export interface SkillViewModalProps {
  data: SkillViewData;
  loading: boolean;
  onClose: () => void;
}

export function SkillViewModal({ data, loading, onClose }: SkillViewModalProps) {
  const [tab, setTab] = useState<string>('skill');
  const [copied, setCopied] = useState(false);

  const getCurrentContent = (): string => {
    switch (tab) {
      case 'skill':
        return data.skillMarkdown;
      case 'source':
        return data.sourceMarkdown;
      case 'knowledge_base':
        return data.knowledgeBase || '';
      case 'case_library':
        return data.caseLibrary || '';
      case 'quotes':
        return data.quotesCollection || '';
      case 'checklist':
        return data.checklist || '';
      case 'decision':
        return data.decisionFramework || '';
      case 'evals':
        return data.evalCases || '';
      case 'meta':
        return JSON.stringify(data.meta, null, 2);
      default:
        if (tab.startsWith('tpl_') && data.templates) {
          const tplName = tab.slice(4);
          return data.templates.find((t) => t.name === tplName)?.content || '';
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
        <div className="flex items-center gap-3 rounded-xl bg-white p-8 shadow-2xl">
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
    ...(data.templates || []).map((t) => ({ id: `tpl_${t.name}`, label: t.name })),
    { id: 'source', label: '原始来源' },
    { id: 'meta', label: '元信息' },
  ];

  const currentContent = getCurrentContent();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-tech-border px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Brain size={20} className="shrink-0 text-tech-purple" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-tech-text">{data.skillName}</h2>
              <p className="mt-0.5 truncate text-xs text-tech-muted">{data.skillPath}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text transition-colors hover:bg-tech-bg"
            >
              {copied ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Copy size={16} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-tech-muted transition-colors hover:bg-tech-bg hover:text-tech-text"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-tech-border bg-tech-bg px-6 py-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
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
          {tab === 'skill' ||
          tab === 'knowledge_base' ||
          tab === 'case_library' ||
          tab === 'quotes' ||
          tab === 'checklist' ||
          tab === 'decision' ||
          tab === 'evals' ||
          tab.startsWith('tpl_') ? (
            <div className="p-6">
              <div className="prose prose-sm max-w-none">
                <RenderMarkdown content={currentContent} />
              </div>
            </div>
          ) : tab === 'source' ? (
            <pre className="whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed text-tech-text">
              {data.sourceMarkdown || '(暂无原始来源)'}
            </pre>
          ) : (
            <pre className="whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed text-tech-text">
              {JSON.stringify(data.meta, null, 2) || '(暂无元信息)'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Markdown Renderer ──────────────────────────────────────────────

export function RenderMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeContent = '';

  const elements: React.ReactNode[] = [];

  const flushCodeBlock = () => {
    if (codeContent) {
      elements.push(
        <pre
          key={elements.length}
          className="my-3 overflow-x-auto rounded-lg border border-tech-border bg-tech-bg p-4"
        >
          <code className="font-mono text-sm">{codeContent.trim()}</code>
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
          <div
            key={elements.length}
            className="my-3 rounded-lg border border-tech-border bg-tech-bg p-3 font-mono text-sm text-tech-muted"
          >
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
      elements.push(
        <h3 key={elements.length} className="mt-5 mb-2 text-base font-semibold text-tech-text">
          {line.slice(4)}
        </h3>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h2
          key={elements.length}
          className="mt-6 mb-3 border-b border-tech-border pb-1 text-lg font-bold text-tech-text"
        >
          {line.slice(3)}
        </h2>
      );
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={elements.length} className="mt-6 mb-3 text-xl font-bold text-tech-text">
          {line.slice(2)}
        </h1>
      );
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      elements.push(
        <div key={elements.length} className="my-0.5 ml-4 flex gap-2 text-sm text-tech-text">
          <span className="min-w-[1.5em] text-right text-tech-muted">{olMatch[1]}.</span>
          <span>{renderInline(olMatch[2])}</span>
        </div>
      );
      continue;
    }

    // Unordered list item
    if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '');
      elements.push(
        <div key={elements.length} className="my-0.5 ml-4 flex gap-2 text-sm text-tech-text">
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
        <p key={elements.length} className="my-1 text-sm font-semibold text-tech-text">
          {line.trim().replace(/\*\*/g, '')}
        </p>
      );
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={elements.length} className="my-1 text-sm leading-relaxed text-tech-text">
        {renderInline(line)}
      </p>
    );
  }

  flushCodeBlock();

  return <>{elements}</>;
}

export function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    const codeParts = part.split(/(`[^`]+`)/g);
    return codeParts.map((cp, j) => {
      if (cp.startsWith('`') && cp.endsWith('`')) {
        return (
          <code key={j} className="rounded bg-tech-bg px-1 py-0.5 font-mono text-xs text-tech-purple">
            {cp.slice(1, -1)}
          </code>
        );
      }
      return cp;
    });
  });
}
