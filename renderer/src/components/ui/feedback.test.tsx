import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { EmptyState } from './EmptyState.js';
import { IconButton } from './IconButton.js';
import { InlineNotice } from './InlineNotice.js';
import { StatusIndicator } from './StatusIndicator.js';

test('status and notices expose text in addition to semantic color', () => {
  const status = renderToStaticMarkup(<StatusIndicator tone="processing" label="生成中" busy />);
  const notice = renderToStaticMarkup(<InlineNotice tone="warning" title="缺少封面">发布前补充封面</InlineNotice>);
  assert.match(status, />生成中</);
  assert.match(status, /role="status"/);
  assert.match(notice, /role="status"/);
  assert.match(notice, />缺少封面</);
});

test('icon buttons have an accessible label and empty states accept one action', () => {
  const button = renderToStaticMarkup(<IconButton label="刷新" icon={RefreshCw} />);
  const empty = renderToStaticMarkup(<EmptyState icon={AlertTriangle} title="没有作品" action={<button>创建作品</button>} />);
  assert.match(button, /aria-label="刷新"/);
  assert.match(button, /title="刷新"/);
  assert.match(empty, />没有作品</);
  assert.equal((empty.match(/<button/g) ?? []).length, 1);
});
