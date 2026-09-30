import type { HotspotItem } from './hotspots.js';

// Source formats/endpoints adapted from MIT ourongxing/newsnow; see docs/third-party/newsnow-LICENSE.txt.
export const HOTSPOT_SOURCES = [
  { id: 'douyin', name: '抖音', label: '热搜榜', home: 'https://www.douyin.com/hot', url: 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1' },
  { id: 'toutiao', name: '今日头条', label: '热榜', home: 'https://www.toutiao.com/', url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc' },
  { id: 'baidu', name: '百度', label: '热搜榜', home: 'https://top.baidu.com/board?tab=realtime', url: 'https://top.baidu.com/board?tab=realtime' },
  { id: 'zhihu', name: '知乎', label: '热榜', home: 'https://www.zhihu.com/hot', url: 'https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true' },
  { id: 'bilibili', name: 'B站', label: '热搜榜', home: 'https://www.bilibili.com/', url: 'https://s.search.bilibili.com/main/hotword?limit=30' },
] as const;

const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const domain: Record<string, string> = { douyin: 'douyin.com', toutiao: 'toutiao.com', baidu: 'baidu.com', zhihu: 'zhihu.com', bilibili: 'bilibili.com' };

export function validHotspotItem(value: unknown, sourceId: string): value is HotspotItem {
  const item = obj(value);
  if (item.sourceId !== sourceId || typeof item.itemId !== 'string' || !item.itemId.trim() || item.itemId.length > 2048
    || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500
    || !Number.isInteger(item.rank) || Number(item.rank) < 1 || Number(item.rank) > 1000
    || (item.heat !== undefined && (typeof item.heat !== 'string' || item.heat.length > 100))
    || (item.summary !== undefined && (typeof item.summary !== 'string' || item.summary.length > 1000))) return false;
  try {
    if (typeof item.url !== 'string' || item.url.length > 4096) return false;
    const url = new URL(item.url);
    return !!domain[sourceId] && url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === domain[sourceId] || url.hostname.endsWith(`.${domain[sourceId]}`));
  } catch { return false; }
}

export function parseHotspotSource(sourceId: string, payload: unknown): HotspotItem[] {
  if (!HOTSPOT_SOURCES.some(source => source.id === sourceId)) throw new Error('未知热点来源');
  let data = obj(payload); let rows: unknown;
  if (sourceId === 'baidu') {
    const match = typeof payload === 'string' ? payload.match(/<!--s-data:(.*?)-->/s) : null;
    if (!match) throw new Error('来源页面未返回榜单数据');
    data = obj(JSON.parse(match[1]));
    const cards = obj(data.data).cards;
    rows = Array.isArray(cards) ? obj(cards[0]).content : undefined;
    if (Array.isArray(rows)) rows = rows.filter(value => !obj(value).isTop);
  } else if (sourceId === 'douyin') rows = obj(data.data).word_list;
  else if (sourceId === 'bilibili') rows = data.code === 0 ? data.list : undefined;
  else rows = data.data;
  if (!Array.isArray(rows)) throw new Error('来源响应格式已变化或需要验证');
  const items: HotspotItem[] = []; const seen = new Set<string>();
  for (const [index, value] of rows.slice(0, 1000).entries()) {
    const row = obj(value); const target = obj(row.target);
    let id = ''; let title = ''; let url = ''; let heat = ''; let summary = '';
    switch (sourceId) {
      case 'douyin': id = text(row.sentence_id); title = text(row.word); heat = text(row.hot_value); url = `https://www.douyin.com/hot/${encodeURIComponent(id)}`; break;
      case 'toutiao': id = text(row.ClusterIdStr); title = text(row.Title); heat = text(row.HotValue); url = `https://www.toutiao.com/trending/${encodeURIComponent(id)}/`; break;
      case 'baidu': id = text(row.rawUrl); title = text(row.word); url = id; heat = text(row.hotScore); summary = text(row.desc); break;
      case 'zhihu': url = text(obj(target.link).url); id = url; title = text(obj(target.title_area).text); heat = text(obj(target.metrics_area).text); summary = text(obj(target.excerpt_area).text); break;
      case 'bilibili': id = text(row.keyword); title = text(row.show_name) || id; heat = text(row.heat_score); url = `https://search.bilibili.com/all?keyword=${encodeURIComponent(id)}`; break;
    }
    const item: HotspotItem = { sourceId, itemId: id, title, url, rank: index + 1, ...(heat ? { heat: heat.slice(0, 100) } : {}), ...(summary ? { summary: summary.slice(0, 1000) } : {}) };
    if (!validHotspotItem(item, sourceId) || seen.has(id)) continue;
    seen.add(id); items.push(item);
    if (items.length === 100) break;
  }
  if (!items.length) throw new Error('来源未返回有效条目，请稍后重试或打开来源网站');
  return items;
}

async function readBounded(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`来源返回 HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 1024 * 1024) { await response.body?.cancel(); throw new Error('来源响应过大'); }
  if (!response.body) throw new Error('来源返回空响应');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 1024 * 1024) throw new Error('来源响应过大');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!total) throw new Error('来源返回空响应');
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchHotspotSource(sourceId: string, fetcher: typeof fetch = fetch): Promise<HotspotItem[]> {
  const source = HOTSPOT_SOURCES.find(source => source.id === sourceId);
  if (!source) throw new Error('未知热点来源');
  const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/html' };
  if (sourceId === 'douyin') {
    const response = await fetcher('https://login.douyin.com/', { redirect: 'error', signal: AbortSignal.timeout(8000), headers });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`匿名会话获取失败 HTTP ${response.status}`); }
    headers.cookie = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    await response.body?.cancel();
  }
  const response = await fetcher(source.url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers });
  const raw = await readBounded(response);
  return parseHotspotSource(sourceId, sourceId === 'baidu' ? raw : JSON.parse(raw));
}
