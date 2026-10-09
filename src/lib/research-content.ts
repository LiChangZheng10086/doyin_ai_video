import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { extractArticlePage } from './article-sources.js';
import { researchPublicUrl } from './research-http.js';
import { ResearchError, type ResearchCandidate, type ResearchContent, type ResearchProvider } from './research-types.js';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function researchTopicUrl(url:URL):boolean {
  return /^(?:search|so)\./i.test(url.hostname) || /(?:^|\/)(?:search|hot|trending)(?:\/|$)/i.test(url.pathname)
    || (url.hostname.endsWith('baidu.com') && url.pathname==='/s') || (url.hostname.endsWith('zhihu.com') && /^\/question\/\d+\/?$/.test(url.pathname));
}
function candidate(title:unknown,input:unknown,provider:ResearchProvider,extra:{snippet?:string;publishedAt?:string}={}):ResearchCandidate|null{
  if(typeof title!=='string'||typeof input!=='string'||!title.trim())return null;
  try {const url=researchPublicUrl(input);return {id:hash(url.href),title:title.trim().slice(0,500),url:url.href,domain:url.hostname,provider,...extra};}catch{return null;}
}
function plainMarkdown(text:string):string {
  return text.replace(/!\[[^\n]*?\]\([^\n]*?\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/<[^>]*>/g,'').replace(/^\s*#{1,6}\s*/gm,'').replace(/^\s*[-*]\s*(.{0,35})$/gm,'')
    .replace(/^\s*(?:登录|注册|搜索|关注|推荐|返回顶部|复制链接|微信扫码分享)\s*$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
}
export function parseResearchContent(input:{url:string;provider:'direct'|'jina';body:string;format:'html'|'markdown'}):ResearchContent {
  const url=researchPublicUrl(input.url); const topic=researchTopicUrl(url);
  let title=url.hostname,text='',publishedAt:string|undefined;const candidates:ResearchCandidate[]=[];let truncated=false;
  const add=(label:string,target:string)=>{const item=candidate(label,target,input.provider);if(item&&item.url!==url.href&&!candidates.some(c=>c.url===item.url)&&candidates.length<10)candidates.push(item);};
  let blocked=false;
  if(input.format==='html'){
    const page=extractArticlePage(input.body,url.href);title=page.title;text=page.text;publishedAt=page.publishedAt;truncated=page.truncated;
    const $=load(input.body);$('a[href]').each((_i,node)=>{const label=$(node).text().trim();if(label.length>=4)try{add(label,new URL($(node).attr('href')!,url).href);}catch{}});
    blocked=/安全验证|访问验证|验证码|just a moment|access denied|^登录/i.test(title);
    if(topic){$('script,style,nav,header,footer,form').remove();text=$('main,article').first().text().trim();}
  }else{
    title=/^Title:\s*(.*)$/m.exec(input.body)?.[1]?.trim()||url.hostname;
    const body=input.body.split(/Markdown Content:\s*\n/)[1]??'';
    blocked=/Warning:.*(?:error\s+(?:4\d\d|5\d\d)|captcha|verification)/im.test(input.body)
      || /登录|安全验证|访问验证|验证码|sign[ -]?in|log[ -]?in|access denied|captcha|security (?:check|verification)|verify (?:you are|your)|just a moment|attention required|forbidden/i.test(title)
      || /^\s*(?:#+\s*)?(?:please (?:sign|log) in|verify (?:you are|your)|checking your browser|complete the captcha)/im.test(body);
    for(const match of body.matchAll(/(?<!!)\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g))if(match[1].length>=4)add(match[1],match[2]);
    text=plainMarkdown(body);
    // A long menu/link list is not substantive prose.
    if(!topic && (text.match(/[。！？.!?]/g)?.length??0)<3)text='';
  }
  const kind=blocked?'unreadable':topic?'topic':text.length>=200?'article':'unreadable';
  const excerpt=kind==='topic'?text.slice(0,1000):undefined;
  truncated ||=kind==='article'&&text.length>20000;
  text=kind==='article'?text.slice(0,20000):'';
  return {url:url.href,title:title.slice(0,500),kind,status:kind==='article'?'readable':'needs_material',text,excerpt,publishedAt,
    readAt:new Date().toISOString(),hash:hash(text),truncated,provider:input.provider,candidates:blocked?[]:candidates,
    ...(kind==='article'?{}:{error:{code:blocked?'blocked':'not_found',message:blocked?'来源要求登录或验证，未读取到正文':'这是话题、搜索线索或未读到正文，请选择相关报道'}})};
}
export function parseExaCandidates(input:unknown):ResearchCandidate[]{
  const result=input as {structuredContent?:{results?:unknown[]};content?:Array<{type:string;text?:string}>;isError?:boolean};
  if(result?.isError)throw new ResearchError(502,'upstream','搜索服务未返回有效结果');
  let rows:unknown[]|undefined=result?.structuredContent?.results;
  if(!rows){
    const text=result?.content?.filter(c=>c.type==='text').map(c=>c.text??'').join('\n')??'';
    try {const parsed=JSON.parse(text);rows=Array.isArray(parsed)?parsed:parsed.results;}catch{
      // Exa's observed text contract: records headed by Title, URL, then Text.
      const records=text.split(/(?=^Title: )/m).filter(s=>s.trim());
      if(records.length&&records.every(s=>/^Title: .+\n(?:Published Date: .*\n)?URL: https?:\/\/[^\n]+\n/.test(s)&&/^((?:Text|Content|Highlights):)/m.test(s)))
        rows=records.map(s=>({title:/^Title: (.*)$/m.exec(s)?.[1],url:/^URL: (.*)$/m.exec(s)?.[1],text:s.split(/\n(?:Text:|Content:|Highlights:)\s*/)[1],publishedDate:/^(?:Published Date|Published): (.*)$/m.exec(s)?.[1]}));
    }
  }
  if(!Array.isArray(rows))throw new ResearchError(502,'unsupported_format','搜索返回格式已变化，请手动添加链接');
  const out:ResearchCandidate[]=[];
  for(const raw of rows.slice(0,100)){
    if(!raw||typeof raw!=='object')throw new ResearchError(502,'unsupported_format','搜索返回格式不受支持');
    const row=raw as Record<string,unknown>;
    if(typeof row.title!=='string'||typeof row.url!=='string')throw new ResearchError(502,'unsupported_format','搜索返回格式已变化，请手动添加链接');
    const item=candidate(row.title,row.url,'exa',{
      ...(typeof row.text==='string'?{snippet:row.text.slice(0,1000)}:{}),
      ...(typeof row.publishedDate==='string'&&Number.isFinite(Date.parse(row.publishedDate))?{publishedAt:row.publishedDate}:{}),
    });
    if(item&&!out.some(c=>c.url===item.url))out.push(item);if(out.length===5)break;
  }
  if(rows.length && !out.length)throw new ResearchError(502,'unsupported_format','搜索结果未包含有效公开链接');
  return out;
}
