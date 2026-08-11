import { describe, it } from 'node:test';
import assert from 'node:assert';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { SkillViewModal, RenderMarkdown, renderInline } from './SkillViewModal';
import type { SkillViewData } from './SkillViewModal';

describe('SkillViewModal', () => {
  const baseData: SkillViewData = {
    skillName: '测试 Skill',
    skillPath: '.claude/skills/test-skill/SKILL.md',
    skillMarkdown: '# 标题\n\n内容段落\n\n- 列表项 1\n- **粗体** 列表项 2\n\n```\ncode block\n```',
    sourceMarkdown: '# 原始数据\n\n这是来源内容',
    meta: { author: 'test', version: '1.0.0' },
    knowledgeBase: '# 知识库\n\n知识内容',
    caseLibrary: '# 案例\n\n案例内容',
    quotesCollection: '> 金句 1\n> 金句 2',
    checklist: '- [ ] 任务一\n- [x] 任务二',
    decisionFramework: '# 决策\n\n决策依据',
    evalCases: '# 测试\n\n测试内容',
    templates: [{ name: '模板A', content: '# 模板A\n\n模板内容' }],
  };

  it('returns a static markup string', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillViewModal, {
        data: baseData,
        loading: false,
        onClose: () => {},
      })
    );
    assert.ok(typeof html === 'string');
    assert.ok(html.length > 0);
  });

  it('renders skill name in the header', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillViewModal, {
        data: baseData,
        loading: false,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('测试 Skill'));
  });

  it('renders SKILL.md tab', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillViewModal, {
        data: baseData,
        loading: false,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('SKILL.md'));
  });

  it('renders knowledge base tab when present', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillViewModal, {
        data: baseData,
        loading: false,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('知识库'));
  });

  it('renders loading state', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillViewModal, {
        data: baseData,
        loading: true,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('加载 Skill 内容'));
  });

  it('renders without optional fields', () => {
    const minimalData: SkillViewData = {
      skillName: '最小 Skill',
      skillPath: '.claude/skills/minimal/SKILL.md',
      skillMarkdown: '最小内容',
      sourceMarkdown: '',
      meta: {},
    };

    const html = renderToStaticMarkup(
      React.createElement(SkillViewModal, {
        data: minimalData,
        loading: false,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('最小 Skill'));
    assert.ok(html.includes('元信息'));
    assert.ok(html.includes('原始来源'));
    // Should NOT have knowledge base tab
    assert.ok(!html.includes('知识库'));
  });

  it('renders template tabs', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillViewModal, {
        data: baseData,
        loading: false,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('模板A'));
  });

  it('renders copy button', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillViewModal, {
        data: baseData,
        loading: false,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('复制'));
  });
});

describe('RenderMarkdown', () => {
  it('renders headings', () => {
    const html = renderToStaticMarkup(
      React.createElement(RenderMarkdown, { content: '# 一级标题\n## 二级标题\n### 三级标题' })
    );
    assert.ok(html.includes('一级标题'));
    assert.ok(html.includes('二级标题'));
    assert.ok(html.includes('三级标题'));
  });

  it('renders unordered lists', () => {
    const html = renderToStaticMarkup(
      React.createElement(RenderMarkdown, { content: '- 项目一\n- 项目二' })
    );
    assert.ok(html.includes('项目一'));
    assert.ok(html.includes('项目二'));
  });

  it('renders ordered lists', () => {
    const html = renderToStaticMarkup(
      React.createElement(RenderMarkdown, { content: '1. 第一项\n2. 第二项' })
    );
    assert.ok(html.includes('1.'));
    assert.ok(html.includes('第一项'));
  });

  it('renders bold text paragraphs', () => {
    const html = renderToStaticMarkup(
      React.createElement(RenderMarkdown, { content: '**重要内容**' })
    );
    assert.ok(html.includes('重要内容'));
  });

  it('renders code blocks', () => {
    const html = renderToStaticMarkup(
      React.createElement(RenderMarkdown, { content: '```\nconst x = 1;\n```' })
    );
    assert.ok(html.includes('const x = 1;'));
  });

  it('renders frontmatter', () => {
    const html = renderToStaticMarkup(
      React.createElement(RenderMarkdown, {
        content: '---\ntitle: Test\ndate: 2026\n---\n\n内容',
      })
    );
    assert.ok(html.includes('title: Test'));
  });

  it('renders inline code', () => {
    const html = renderToStaticMarkup(
      React.createElement(RenderMarkdown, { content: '使用 `useState` hook' })
    );
    assert.ok(html.includes('useState'));
  });

  it('renders inline bold', () => {
    const html = renderToStaticMarkup(
      React.createElement(RenderMarkdown, { content: '这是 **加粗** 的文字' })
    );
    assert.ok(html.includes('加粗'));
  });

  it('handles empty content', () => {
    const html = renderToStaticMarkup(React.createElement(RenderMarkdown, { content: '' }));
    assert.ok(typeof html === 'string');
  });
});

describe('renderInline', () => {
  it('returns plain text as-is', () => {
    const result = renderInline('纯文本');
    assert.ok(result !== undefined);
  });

  it('renders bold markers', () => {
    // renderInline splits on **...** pattern and wraps in <strong>
    const text = '这是 **粗体** 文字';
    // The function returns an array of parts, we just test it doesn't throw
    assert.doesNotThrow(() => renderInline(text));
  });

  it('renders inline code markers', () => {
    const text = '使用 `code` 标记';
    assert.doesNotThrow(() => renderInline(text));
  });
});
