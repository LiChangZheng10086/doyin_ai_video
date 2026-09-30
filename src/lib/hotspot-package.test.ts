import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('actual electron-builder file matcher includes the NewsNow license in distribution', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const require = createRequire(import.meta.url);
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
  const matcher = new FileMatcher(root, '/tmp/unused-package-target', (value: string) => value, pkg.build.files);
  const filename = path.join(root, 'docs/third-party/newsnow-LICENSE.txt');
  assert.equal(matcher.createFilter()(filename, await stat(filename)), true);
});
