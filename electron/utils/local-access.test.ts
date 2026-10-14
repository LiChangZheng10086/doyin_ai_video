import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopAccessHeaders } from './local-access.js';

test('desktop token reaches only API requests from the trusted top-level renderer', () => {
  const trusted = 'file:///app/dist-renderer/index.html';
  const headers = { Accept: '*/*' };
  const frame = { url: `${trusted}#/jobs/1`, top: { url: trusted } };
  assert.deepEqual(desktopAccessHeaders(headers, frame, trusted, 'test-token'), { ...headers, 'X-Desktop-Access': 'test-token' });
  for (const bad of [undefined, { url: 'about:blank', top: { url: trusted } }, { url: trusted, top: { url: 'https://evil.example' } }]) {
    assert.deepEqual(desktopAccessHeaders({ ...headers, 'x-desktop-access': 'forged' }, bad, trusted, 'test-token'), headers);
  }
  assert.deepEqual(desktopAccessHeaders(headers, { url: 'http://localhost:5173/jobs/1', top: { url: 'http://localhost:5173/' } }, 'http://localhost:5173', 'test-token'), { ...headers, 'X-Desktop-Access': 'test-token' });
});
