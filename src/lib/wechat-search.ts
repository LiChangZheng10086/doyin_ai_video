import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { downloadArticleHtml } from './article-sources.js';

export interface WechatSearchArticle {
  id: string; title: string; url: string; accountName: string; summary: string; dateText: string;
}

export function wechatReferenceUrl(input: string): string {
  let url: URL;
  try { url = new URL(input, 'https://weixin.sogou.com'); } catch { throw new Error('请输入公众号文章或搜狗微信链接'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['mp.weixin.qq.com', 'weixin.sogou.com'].includes(url.hostname)
    || (url.hostname === 'weixin.sogou.com' && url.pathname !== '/link')
    || (url.hostname === 'mp.weixin.qq.com' && !['/s', '/s/'].includes(url.pathname) && !url.pathname.startsWith('/s/'))) throw new Error('请输入公众号文章或搜狗微信链接');
  url.hash = '';
  return url.href;
}

export function parseWechatSearch(html: string): WechatSearchArticle[] {
  const $ = load(html);
  if ($('form[action*="antispider"], #seccodeImage, input[name="c"]').length || /请输入验证码|访问过于频繁/.test($('body').text())) throw new Error('搜狗要求验证码或已限频，请手动搜索并录入');
  if (!$('ul.news-list').length) {
    if ($('.no-result, .no-results').length || /没有找到|未找到相关/.test($('body').text())) return [];
    throw new Error('搜索页面结构变化，暂不可自动解析，请手动录入');
  }
  const items: WechatSearchArticle[] = [];
  $('ul.news-list > li').each((_i, node) => {
    if (items.length >= 50) return false;
    const li = $(node); const title = li.find('h3').text().trim().slice(0,500);
    const accountName = li.find('.account, .all-time-y2').first().text().trim().slice(0,100);
    if (!title || !accountName) return;
    let url: string;
    try { url = wechatReferenceUrl(li.find('h3 a').first().attr('href') ?? ''); } catch { return; }
    const id = createHash('sha256').update(url).digest('hex');
    if (items.some(item => item.id === id)) return;
    const timestamp = /timeConvert\(['"](\d{10})['"]\)/.exec(li.find('.s2').html() ?? '')?.[1];
    const dateText = timestamp ? new Date(Number(timestamp)*1000).toISOString() : li.find('.s2').clone().find('script').remove().end().text().trim().slice(0,100);
    items.push({ id, title, accountName, url, summary: li.find('.txt-info').clone().find('script,style').remove().end().text().trim().slice(0,2000), dateText });
  });
  if (!items.length && $('ul.news-list > li').length) throw new Error('搜索页面结构变化，暂不可自动解析，请手动录入');
  return items;
}

export async function searchWechatArticles(keyword: string, read = downloadArticleHtml): Promise<WechatSearchArticle[]> {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100) throw new Error('搜索关键词应为 1～100 字');
  const url = new URL('https://weixin.sogou.com/weixin');
  for (const [key,value] of Object.entries({query:keyword.trim(),s_from:'input',type:'2',page:'1',ie:'utf8'})) url.searchParams.set(key,value);
  return parseWechatSearch(await read(url.href));
}
