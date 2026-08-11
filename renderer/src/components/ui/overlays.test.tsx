import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmDialog } from './ConfirmDialog.js';
import { BottomSheet } from './BottomSheet.js';

const noop = () => {};

test('confirm dialog exposes title, description, tone, and dialog semantics', () => {
  const dialog = renderToStaticMarkup(
    <ConfirmDialog
      open
      title="永久删除作品"
      description="删除后无法恢复"
      confirmLabel="永久删除"
      tone="danger"
      onConfirm={noop}
      onClose={noop}
    />,
  );
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /永久删除作品/);
  assert.match(dialog, /data-tone="danger"/);
});

test('bottom sheet returns empty string when closed', () => {
  const closed = renderToStaticMarkup(
    <BottomSheet open={false} title="筛选" onClose={noop}>
      内容
    </BottomSheet>,
  );
  assert.equal(closed, '');
});

test('bottom sheet renders dialog semantics when open', () => {
  const open = renderToStaticMarkup(
    <BottomSheet open title="筛选" onClose={noop}>
      <p>筛选内容</p>
    </BottomSheet>,
  );
  assert.match(open, /role="dialog"/);
  assert.match(open, /aria-modal="true"/);
  assert.match(open, />筛选</);
  assert.match(open, />筛选内容</);
});
