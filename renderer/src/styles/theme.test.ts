import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('creative canvas tokens and accessibility rules are defined globally', async () => {
  const css = await readFile(new URL('../index.css', import.meta.url), 'utf8');
  assert.match(css, /--color-canvas:\s*#F6F8FB/i);
  assert.match(css, /--color-brand-blue:\s*#2563EB/i);
  assert.match(css, /--color-brand-violet:\s*#7C3AED/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /letter-spacing:\s*0/);
});
