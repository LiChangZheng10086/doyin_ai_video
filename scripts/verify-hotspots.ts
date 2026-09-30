/** --live: public sources only; default: isolated UI cache, first note PATCH intentionally fails. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOTSPOT_SOURCES, fetchHotspotSource } from '../src/lib/hotspot-sources.js';
import { LocalStorage } from '../src/lib/storage.js';
import { createExpressApp } from '../src/app.js';

if (process.argv.includes('--live')) {
  await Promise.all(HOTSPOT_SOURCES.map(async source => {
    try {
      const items = await fetchHotspotSource(source.id);
      assert.ok(items.length > 0);
      console.log(JSON.stringify({ source: source.name, ok: true, count: items.length, hasHeat: items.some(item => item.heat) }));
    } catch (error) {
      console.log(JSON.stringify({ source: source.name, ok: false, error: error instanceof Error ? error.message : 'failed' }));
      process.exitCode = 1;
    }
  }));
} else {
  const root = await mkdtemp(path.join(tmpdir(), 'hotspots-ui-'));
  const storage = new LocalStorage(root); const now = new Date().toISOString();
  for (const source of HOTSPOT_SOURCES) {
    const items = Array.from({ length: 15 }, (_, index) => ({ sourceId: source.id, itemId: String(index + 1), title: `验收选题 ${index + 1} · ${source.name}`, url: source.home, rank: index + 1, heat: '测试热度' }));
    await storage.writeJsonAtomic(`cache/hotspots/${source.id}.json`, { items, fetchedAt: now, checkedAt: now });
  }
  const app = await createExpressApp({ rootDir: root, storagePath: root });
  let failNote = true;
  const server = createServer((req, res) => {
    if (failNote && req.method === 'PATCH' && req.url?.startsWith('/api/hotspots/favorites/')) {
      failNote = false; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'qa_failure', message: '模拟保存失败：你的输入应继续保留' })); return;
    }
    app(req, res);
  });
  server.listen(3100, '127.0.0.1', () => console.log('Isolated hotspots UI fixture on 3100; no account credentials or publishing calls. First note save returns 503 intentionally.'));
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    server.close(() => { void rm(root, { recursive: true, force: true }).then(() => process.exit(0)); });
  };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
