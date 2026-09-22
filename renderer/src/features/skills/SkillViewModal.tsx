import React, { useCallback, useState } from 'react';
import { Brain, CheckCircle2, Copy, Loader2, X } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';

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
  /*
   * 焦点陷阱 / Esc / 滚动锁 / #root inert 全部交给共享的 `Modal`。
   * 这里原本自己实现，但有两个真实缺陷：
   *   ① 依赖数组是 `[onClose]`，而调用方传的是每次渲染新建的内联箭头函数
   *      ⇒ 父组件一重渲染就 cleanup→setup，参考焦点被覆盖、且关闭时归位的焦点
   *      可能已卸载；② `loading` 分支是**另一个 return**、没有挂 ref，
   *      于是「dialog 为 null 就 return」让它永不注册 —— 那一帧里
   *      `aria-modal="true"` 是假的（Esc 关不掉、Tab 能跑到遮罩后面、body 没锁滚动）。
   */

  const getCurrentContent = useCallback((): string => {
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
  }, [tab, data]);

  const [copyError, setCopyError] = useState('');
  const handleCopy = async () => {
    /* 改造前不 await 也不 catch：写剪贴板失败照样提示「已复制」，
       用户粘贴出空内容会去怀疑 Skill 生成有问题。 */
    try {
      await navigator.clipboard.writeText(getCurrentContent());
      setCopied(true);
      setCopyError('');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('复制失败，请手动选择文本');
    }
  };

  if (loading) {
    return (
      <Modal open onClose={onClose} size="sm" ariaLabel="加载 Skill 内容">
        <div className="flex items-center gap-3 py-3">
          <Loader2 size={24} className="animate-spin text-ai" aria-hidden="true" />
          <span className="text-ink">加载 Skill 内容…</span>
        </div>
      </Modal>
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
    <Modal open onClose={onClose} size="xl" ariaLabel={data.skillName} bodyClassName="p-0" hideClose>
      <div className="flex h-[90vh] w-full flex-col">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Brain size={20} className="shrink-0 text-ai" />
            <div className="min-w-0">
              <h2 id="skill-view-title" className="truncate text-lg font-semibold text-ink">{data.skillName}</h2>
              <p className="mt-0.5 truncate text-xs text-ink-muted">{data.skillPath}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-elevated"
            >
              {copied ? <CheckCircle2 size={16} className="text-success" /> : <Copy size={16} />}
              {copied ? '已复制' : '复制'}
            </button>
            {copyError && <span className="text-xs text-danger">{copyError}</span>}
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
              aria-label="关闭 Skill 查看"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-canvas px-6 py-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
                tab === t.id
                  ? 'bg-panel text-ink shadow-sm'
                  : 'text-ink-muted hover:text-ink'
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
              {/* `prose prose-sm` 在本项目里是**空转**的：package.json 没有
                  @tailwindcss/typography，这两个类不产出任何样式。正文可读性靠限宽实现。 */}
              <div className="max-w-[72ch]">
                <RenderMarkdown content={currentContent} />
              </div>
            </div>
          ) : tab === 'source' ? (
            <pre className="whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed text-ink">
              {data.sourceMarkdown || '(暂无原始来源)'}
            </pre>
          ) : (
            <pre className="whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed text-ink">
              {JSON.stringify(data.meta, null, 2) || '(暂无元信息)'}
            </pre>
          )}
        </div>
      </div>
    </Modal>
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
          className="my-3 overflow-x-auto rounded-lg border border-line bg-canvas p-4"
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
            className="my-3 rounded-lg border border-line bg-canvas p-3 font-mono text-sm text-ink-muted"
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
        <h3 key={elements.length} className="mt-5 mb-2 text-base font-semibold text-ink">
          {line.slice(4)}
        </h3>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h2
          key={elements.length}
          className="mt-6 mb-3 border-b border-line pb-1 text-lg font-bold text-ink"
        >
          {line.slice(3)}
        </h2>
      );
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={elements.length} className="mt-6 mb-3 text-xl font-bold text-ink">
          {line.slice(2)}
        </h1>
      );
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      elements.push(
        <div key={elements.length} className="my-0.5 ml-4 flex gap-2 text-sm text-ink">
          <span className="min-w-[1.5em] text-right text-ink-muted">{olMatch[1]}.</span>
          <span>{renderInline(olMatch[2])}</span>
        </div>
      );
      continue;
    }

    // Unordered list item
    if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '');
      elements.push(
        <div key={elements.length} className="my-0.5 ml-4 flex gap-2 text-sm text-ink">
          <span className="text-ink-muted">•</span>
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
        <p key={elements.length} className="my-1 text-sm font-semibold text-ink">
          {line.trim().replace(/\*\*/g, '')}
        </p>
      );
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={elements.length} className="my-1 text-sm leading-relaxed text-ink">
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
          <code key={j} className="rounded bg-canvas px-1 py-0.5 font-mono text-xs text-ai">
            {cp.slice(1, -1)}
          </code>
        );
      }
      return cp;
    });
  });
}
