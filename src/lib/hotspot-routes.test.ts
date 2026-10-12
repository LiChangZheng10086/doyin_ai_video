import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../app.js';
import { ResearchService } from './research-service.js';
import { parseResearchContent } from './research-content.js';

test('hotspot API exposes boards, guards favorite writes and rejects forged input and stale note versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hotspot-api-'));
  let readUrl = '';
  const researchService = new ResearchService({validateUrl:async()=>{},readDirect:async url=>{
    readUrl=url;
    return parseResearchContent({url,provider:'direct',format:'html',body:'<title>隔离验收官方正文</title><article><h1>隔离验收官方正文</h1><p>这是隔离测试提供的文章正文，不是 RSS 摘要。模型能力需要结合具体任务和限制进行评估，不能仅凭榜单或标题作出结论。正式创作应核对原始发布信息、实验条件与证据来源，保留不确定性和原文措辞。在引用技术数据时需要检查任务范围、样本选择和评估标准，说明哪些结论已经有公开材料支持，哪些仍需后续验证。不能为了吸引读者而增加未经原文证实的效果或把实验结果推及所有用户。来源里的边界条件也应一并保留，不能为了缩短文字而删去对理解结论有必要的信息。</p></article>'});
  }});
  const app = await createExpressApp({ storagePath: root, rootDir: root, researchService });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let token = '';
  const request = async (url: string, method = 'GET', data?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() as any : {} };
  };
  try {
    assert.equal((await request('/api/hotspots/favorites')).status, 200);
    assert.equal((await request('/api/hotspots/favorites', 'POST', { sourceId: 'toutiao', itemId: '123' })).status, 401);
    token = (await request('/api/local-sessions/auto', 'POST')).body.session.token;
    assert.equal((await request('/api/hotspots/favorites', 'POST', { sourceId: '../config', itemId: '123' })).status, 400);
    assert.equal((await request('/api/hotspots/favorites', 'POST', { sourceId: 'toutiao', itemId: 'invented', url: 'https://evil.example' })).status, 404);
    // Seed only isolated API cache; do not contact real platforms in regression tests.
    const { LocalStorage } = await import('./storage.js');
    const storage = new LocalStorage(root); const now = new Date().toISOString();
    await storage.writeJsonAtomic('cache/hotspots/toutiao.json', { items: [{ sourceId: 'toutiao', itemId: '123', title: 'API选题', url: 'https://www.toutiao.com/trending/123/', rank: 1 }], fetchedAt: now, checkedAt: now });
    const saved = await request('/api/hotspots/favorites', 'POST', { sourceId: 'toutiao', itemId: '123', title: '不可注入' });
    assert.equal(saved.status, 201); assert.equal(saved.body.favorite.title, 'API选题');
    const url = `/api/hotspots/favorites/${saved.body.favorite.id}`;
    app.locals.localSessions.close(token);
    const expired = await request(url, 'PATCH', { note: '过期会话', version: 1 });
    assert.equal(expired.status, 401); assert.equal(expired.body.code, 'local_session_required');
    token = (await request('/api/local-sessions/auto', 'POST')).body.session.token;
    assert.equal((await request(url, 'PATCH', { note: '选题角度', version: 1 })).status, 200);
    assert.equal((await request(url, 'PATCH', { note: '旧编辑', version: 1 })).status, 409);
    assert.equal((await request(url, 'DELETE')).status, 400);
    assert.equal((await request(url, 'DELETE', { version: 2 })).status, 200);
    assert.deepEqual((await request('/api/hotspots/favorites')).body.favorites, []);
    const newsUrl='https://openai.com/index/qa/';
    await storage.writeJsonAtomic('cache/hotspots/openai.json',{items:[{sourceId:'openai',itemId:newsUrl,title:'官方资讯',url:newsUrl,rank:1,publishedAt:'2026-10-10T10:00:00.000Z',summary:'RSS 摘要不能代替正文'}],fetchedAt:now,checkedAt:now});
    const newsSaved=await request('/api/hotspots/favorites','POST',{sourceId:'openai',itemId:newsUrl,url:'https://evil.example/'});
    assert.equal(newsSaved.status,201);assert.equal(newsSaved.body.favorite.url,newsUrl);
    const detail=await request('/api/hotspots/detail','POST',{sourceId:'openai',itemId:newsUrl});
    assert.equal(detail.status,200);assert.equal(readUrl,newsUrl);assert.equal(detail.body.result.status,'readable');
    const input={hotspot:{sourceId:'openai',itemId:newsUrl},researchSelections:[{readId:detail.body.result.readId,hash:detail.body.result.hash}]};
    const forged=await request('/api/articles','POST',{...input,researchSelections:[{readId:detail.body.result.readId,hash:'forged'}]});
    assert.equal(forged.status,409);
    const created=await request('/api/articles','POST',input);
    assert.equal(created.status,201);assert.equal(created.body.article.hotspot.url,newsUrl);
    assert.equal(created.body.article.sources.length,1);assert.equal(created.body.article.sources[0].status,'readable');
    assert.equal(created.body.article.sources[0].hash,detail.body.result.hash);
    assert.ok(created.body.article.sources[0].text.includes('隔离测试提供的文章正文'));
    assert.ok(!created.body.article.sources[0].text.includes('RSS 摘要不能代替正文'));
    assert.equal((await request('/api/articles','POST',{hotspot:input.hotspot})).body.article.sources[0].status,'needs_material');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
