import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSauConfig, sauConfigToRemember, rememberSauConfig } from './sau-config.js';

test('explicit env wins; blank env falls back to saved desktop paths', () => {
  const config = { sauBinary: '/saved/sau', sauBaseDir: '/saved' };
  assert.deepEqual(resolveSauConfig(config, {}), config);
  assert.deepEqual(resolveSauConfig(config, { SAU_BINARY: ' /override/sau ', SAU_BASE_DIR: '/override' }), { sauBinary: '/override/sau', sauBaseDir: '/override' });
  assert.deepEqual(resolveSauConfig(config, { SAU_BINARY: ' ', SAU_BASE_DIR: '' }), config);
});
test('optional persistence failure does not reject startup or discard resolved runtime paths', async () => {
  const paths = { sauBinary: '/installed/sau', sauBaseDir: '/installed' };
  assert.equal(await rememberSauConfig({}, paths, async () => { throw new Error('disk write failed'); }), false);
  assert.deepEqual(paths, { sauBinary: '/installed/sau', sauBaseDir: '/installed' });
});
test('complete first-time paths survive future env-less startup; temporary overrides do not replace saved paths', () => {
  const resolved = { sauBinary: '/installed/sau', sauBaseDir: '/installed' };
  const saved = sauConfigToRemember({}, resolved); assert.deepEqual(saved, resolved);
  assert.deepEqual(resolveSauConfig(saved, {}), resolved);
  assert.deepEqual(sauConfigToRemember(resolved, { sauBinary: '/temp/sau', sauBaseDir: '/temp' }), {});
  assert.deepEqual(sauConfigToRemember({ sauBinary: '/custom/sau' }, resolved), {});
  assert.deepEqual(sauConfigToRemember({}, { sauBinary: '/incomplete/sau' }), {});
});
