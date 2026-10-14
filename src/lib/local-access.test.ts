import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import type { Request, Response } from 'express';
import { localAccess } from './local-access.js';

test('a non-loopback connection cannot claim a localhost Host', () => {
  let status: number | undefined;
  const req = { socket: { remoteAddress: '192.0.2.10' }, get: (name: string) => name === 'Host' ? 'localhost:3100' : undefined } as Request;
  const res = { status: (value: number) => { status = value; return res; }, json: () => {} } as unknown as Response;
  localAccess()(req, res, () => assert.fail('remote connection entered API'));
  assert.equal(status, 403);
});

test('local API rejects untrusted origins, opaque frames and rebound hosts before handlers', async t => {
  const app = express();
  let mutations = 0;
  app.use(localAccess());
  app.all('/api/local-sessions/auto', (_req, res) => { mutations++; res.json({ ok: true }); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  for (const headers of [
    { Origin: 'https://evil.example' }, { Origin: 'null' },
    { Origin: 'http://localhost.evil.example:5173' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await fetch(`${base}/api/local-sessions/auto`, { method: 'POST', headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}/api/local-sessions/auto`, { method: 'POST', headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebound, 403);
  assert.equal(mutations, 0);
  for (const origin of [undefined, base, 'http://localhost:5173']) {
    const response = await fetch(`${base}/api/local-sessions/auto`, { method: 'POST', headers: origin ? { Origin: origin } : {} });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin ?? null);
  }
  const options = await fetch(`${base}/api/local-sessions/auto`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(options.status, 204);
  assert.equal(mutations, 3);
});

test('opaque desktop origin needs the main-process token, including preflight and media', async t => {
  const app = express(); app.use(localAccess('test-desktop-token'));
  app.all('/api/media', (_req, res) => { res.send('media'); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/media`;
  assert.equal((await fetch(url, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await fetch(url, { headers: { Origin: 'null', 'X-Desktop-Access': 'wrong' } })).status, 403);
  for (const method of ['GET', 'OPTIONS']) {
    const response = await fetch(url, { method, headers: { Origin: 'null', 'X-Desktop-Access': 'test-desktop-token' } });
    assert.equal(response.status, method === 'OPTIONS' ? 204 : 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  }
});
