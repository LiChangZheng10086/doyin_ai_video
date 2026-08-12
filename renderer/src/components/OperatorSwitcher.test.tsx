import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperatorSwitcher } from './OperatorSwitcher';

test('operator switcher uses a compact identity trigger instead of a native select', () => {
  const markup = renderToStaticMarkup(<OperatorSwitcher onRequestRecovery={() => undefined} />);

  assert.doesNotMatch(markup, /<select/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />选择操作者<\/span>/);
  assert.match(markup, />只读模式<\/span>/);
});
