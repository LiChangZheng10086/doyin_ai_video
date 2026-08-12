import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOutputLimit, toOutputLimitForm } from './ai-output-limit';

test('missing values map to automatic mode', () => {
  assert.deepEqual(toOutputLimitForm(undefined), {
    mode: 'automatic',
    value: '8192',
  });
});

test('custom values round-trip to the API payload', () => {
  assert.deepEqual(toOutputLimitForm(16384), {
    mode: 'custom',
    value: '16384',
  });
  assert.equal(parseOutputLimit('custom', '16384'), 16384);
});

test('automatic mode clears a previous value', () => {
  assert.equal(parseOutputLimit('automatic', '16384'), undefined);
});

test('invalid custom form values return a readable error', () => {
  assert.throws(() => parseOutputLimit('custom', ''), /请输入/);
  assert.throws(() => parseOutputLimit('custom', '255'), /至少为 256/);
  assert.throws(() => parseOutputLimit('custom', '1024.5'), /整数/);
});
