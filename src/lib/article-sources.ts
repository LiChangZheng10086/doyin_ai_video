import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export interface ArticleSourceRead {
  url: string; title: string; text: string; status: 'readable' | 'needs_material';
  readAt: string; hash: string; publishedAt?: string; truncated: boolean;
  links: Array<{ title: string; url: string }>; error?: string;
  readProvider?: 'direct' | 'jina'; sourceKind?: 'article' | 'topic' | 'unreadable';
}
const MAX_BYTES = 2 * 1024 * 1024;
const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) denied.addSubnet(address, prefix);
// Public webpage fetches do not use special IETF protocol addresses (including their globally routed exceptions).
denied.addSubnet('2001::', 23, 'ipv6');
denied.addSubnet('3fff::', 20, 'ipv6');
denied.addSubnet('2001:db8::', 32, 'ipv6');
denied.addSubnet('2002::', 16, 'ipv6');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');

export function articlePublicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('资料必须是公开 HTTPS 链接'); }
  if (input.length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.port
    || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/i.test(url.hostname)) {
    throw new Error('资料必须是公开 HTTPS 链接，不能使用本机、IP、凭据或非默认端口');
  }
  url.hash = '';
  return url;
}

export async function resolveArticleAddress(input: string, resolver = (hostname: string) => lookup(hostname, { all: true })) {
  const url = articlePublicUrl(input);
  const addresses = await resolver(url.hostname);
  if (!addresses.length || addresses.some(item => {
    const family = isIP(item.address);
    return family === 4 ? denied.check(item.address, 'ipv4') : family !== 6
      || !global6.check(item.address, 'ipv6') || denied.check(item.address, 'ipv6');
  })) throw new Error('资料来源必须解析到公网地址');
  return { url, address: addresses[0]!.address, family: isIP(addresses[0]!.address) };
}

export async function downloadArticleHtml(input: string, externalSignal?: AbortSignal): Promise<string> {
  const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  signal.throwIfAborted();
  const pinned = await Promise.race([resolveArticleAddress(input), new Promise<never>((_,reject) => { signal.addEventListener('abort', () => reject(new Error('资料读取超时')), { once: true }); })]);
  return new Promise((resolve, reject) => {
    const req = request(pinned.url, {
      agent: false, signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
      // DNS is checked once, and that address is the only address the socket can use.
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
        const address = { address: pinned.address, family: pinned.family };
        if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
      }) as any,
    }, response => {
      if (response.statusCode !== 200 || !/text\/html|application\/xhtml\+xml/i.test(String(response.headers['content-type'] ?? ''))
        || Number(response.headers['content-length']) > MAX_BYTES || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); reject(new Error('网页不可直接读取或响应过大')); return;
      }
      const chunks: Buffer[] = []; let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) { response.destroy(new Error('网页响应超过 2 MiB')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(String(response.headers['content-type']))?.[1] ?? 'utf-8';
        try { resolve(new TextDecoder(charset).decode(Buffer.concat(chunks))); } catch { reject(new Error('网页编码不可读取')); }
      });
    });
    req.on('error', reject); req.end();
  });
}

function plain(input: string): string {
  return input.replace(/<(script|style|nav|header|footer|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/(?:p|div|section|h[1-6]|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value: string) => {
      const code = value[0]?.toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]!)
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

export function extractArticlePage(html: string, input: string) {
  const url = articlePublicUrl(input);
  let title = plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || url.hostname;
  const pageTitle = title;
  let body = ''; let publishedAt: string | undefined;
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 5) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
    const object = value as Record<string, unknown>;
    if (typeof object.articleBody === 'string' && object.articleBody.length > body.length) {
      body = plain(object.articleBody); if (typeof object.headline === 'string') title = plain(object.headline);
      if (typeof object.datePublished === 'string' && Number.isFinite(Date.parse(object.datePublished))) publishedAt = object.datePublished;
    }
    visit(object['@graph'], depth + 1);
  };
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1]!)); } catch { /* Broken metadata is not evidence. */ }
  }
  // ponytail: explicit article metadata/containers only; dynamic or ambiguous pages need supplied material.
  const visibleHtml = html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|nav|header|footer|form|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  for (const match of visibleHtml.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const candidate = plain(match[2]!);
    if (candidate.length > body.length && (match[2]!.match(/<p\b/gi)?.length ?? 0) > 0) body = candidate;
  }
  if (/搜索结果|安全验证|访问验证|验证码|登录|just a moment|access denied|sign in|login/i.test(pageTitle)
    || /^(?:search|so)\./i.test(url.hostname)
    || /(?:^|\/)(?:search|hot|trending)(?:\/|$)/i.test(url.pathname)
    || (url.hostname.endsWith('baidu.com') && url.pathname === '/s')
    || (url.hostname.endsWith('zhihu.com') && /^\/question\/\d+\/?$/.test(url.pathname))) body = '';
  if (body.length < 200 || /^(?:请登录|登录后|验证码|安全验证|访问验证)/.test(body)) body = '';
  const links: Array<{ title: string; url: string }> = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = plain(match[2]!).slice(0, 200);
    if (label.length < 6) continue;
    try {
      const next = articlePublicUrl(new URL(match[1]!.replaceAll('&amp;', '&'), url).href);
      const root = url.hostname.replace(/^(?:www|search|m)\./, '');
      if ((next.hostname === root || next.hostname.endsWith(`.${root}`)) && next.href !== url.href && !links.some(item => item.url === next.href)) links.push({ title: label, url: next.href });
    } catch { /* Non-public candidates are not offered. */ }
    if (links.length === 10) break;
  }
  return { title: title.slice(0, 500), text: body.slice(0, 20000), publishedAt, truncated: body.length > 20000, links };
}

export async function readArticleSource(input: string, fetchHtml = downloadArticleHtml): Promise<ArticleSourceRead> {
  const url = articlePublicUrl(input).href;
  const base = { url, readAt: new Date().toISOString() };
  try {
    const html = await fetchHtml(url);
    if (Buffer.byteLength(html) > MAX_BYTES) throw new Error('网页响应超过 2 MiB');
    const page = extractArticlePage(html, url);
    return { ...base, ...page, hash: createHash('sha256').update(page.text).digest('hex'),
      status: page.text ? 'readable' : 'needs_material', ...(page.text ? {} : { error: '未读取到完整正文，请选择相关报道或补充文字资料' }) };
  } catch {
    return { ...base, title: new URL(url).hostname, text: '', hash: '', links: [], truncated: false, status: 'needs_material', error: '公开页面无法读取，请补充可访问链接或文字资料' };
  }
}
