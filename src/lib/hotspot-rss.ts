import { load } from 'cheerio';
import type { HotspotItem } from './hotspots.js';

export const OFFICIAL_RSS_SOURCES = [
  { id: 'openai', name: 'OpenAI', label: '官方 RSS', category: 'ai-tech', home: 'https://openai.com/news/', url: 'https://openai.com/news/rss.xml', domain: 'openai.com' },
  { id: 'deepmind', name: 'Google DeepMind', label: '官方 RSS', category: 'ai-tech', home: 'https://deepmind.google/blog/', url: 'https://deepmind.google/blog/rss.xml', domain: 'deepmind.google' },
  { id: 'microsoft-research', name: 'Microsoft Research', label: '官方 RSS', category: 'ai-tech', home: 'https://www.microsoft.com/en-us/research/blog/', url: 'https://www.microsoft.com/en-us/research/feed/', domain: 'www.microsoft.com' },
] as const;

export function parseOfficialRss(sourceId: string, raw: unknown, valid: (item: unknown, sourceId: string) => boolean): HotspotItem[] {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('来源 RSS 格式无效或响应过大');
  const $ = load(raw, { xml: true });
  const root = $.root().children();
  const atom = root.is('feed');
  if (root.length !== 1 || (!atom && !root.is('rss')) || !(atom ? /<\/feed>\s*$/ : /<\/rss>\s*$/).test(raw)) throw new Error('来源未返回有效 RSS 或 Atom');
  const plain = (value: string) => {
    const html = load(value); html('script,style,iframe').remove();
    return html.root().text().replace(/\s+/g, ' ').trim();
  };
  const items: HotspotItem[] = []; const seen = new Set<string>();
  for (const entry of (atom ? root.children('entry') : root.children('channel').children('item')).slice(0, 2000).toArray()) {
    const node = $(entry);
    const link = atom ? node.children('link').filter((_, element) => !$(element).attr('rel') || $(element).attr('rel') === 'alternate').first().attr('href') : node.children('link').first().text();
    let url: string;
    try { const parsed = new URL(link?.trim() ?? ''); parsed.hash = ''; url = parsed.href; } catch { continue; }
    const date = Date.parse(node.children(atom ? 'published' : 'pubDate').first().text().trim());
    if (!Number.isFinite(date)) continue;
    const title = plain(node.children('title').first().text());
    const summary = plain(node.children(atom ? 'summary' : 'description').first().text()).slice(0, 1000);
    const item: HotspotItem = { sourceId, itemId: url, title, url, rank: 1, publishedAt: new Date(date).toISOString(), ...(summary ? { summary } : {}) };
    if (!valid(item, sourceId) || seen.has(url)) continue;
    seen.add(url); items.push(item);
  }
  items.sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!) || a.url.localeCompare(b.url));
  if (!items.length) throw new Error('来源未返回有效资讯，请稍后重试或打开来源网站');
  return items.slice(0, 100).map((item, index) => ({ ...item, rank: index + 1 }));
}
