import { articlePublicUrl } from './article-sources.js';
import type { ArticleRecord, ArticleAutoResearch } from './article-types.js';
import type { ResearchCandidate } from './research-types.js';

// Only public idea text, explicitly supplied search terms, or a public page title/domain
// may enter search. Mixed/pasted body, requirements and style samples never do.
export function articleResearchQuery(a:ArticleRecord):string|undefined {
 if(a.input?.searchQuery)return a.input.searchQuery;
 if(a.input?.confirmPublicQuery)return;
 const hasMaterial=a.sources.some(s=>s.included&&s.status==='readable'&&s.text.trim());
 if(hasMaterial)return;
 if(a.input?.kind==='idea')return `${a.keyword.slice(0,360)} 官方 原始资料`;
 if(a.input?.kind==='url'||a.input?.kind==='mixed'){
  const web=a.sources.find(s=>s.included&&s.kind==='web'&&s.status!=='readable');
  if(web){const u=new URL(web.url);return `${u.hostname} ${u.pathname.replace(/[^\p{L}\p{N}._/-]/gu,' ').slice(0,200)}`.trim();} // No URL query tokens or surrounding text.
 }
}
export function researchUrlKey(raw:string):string {
 const url=articlePublicUrl(raw);
 for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||/^(fbclid|gclid|msclkid)$/i.test(key))url.searchParams.delete(key);
 url.searchParams.sort();return url.href;
}
const primaryDomains=['mozilla.org','openai.com','anthropic.com','deepseek.com','github.com','microsoft.com','apple.com','google.com','research.google','docs.python.org','nodejs.org','w3.org','arxiv.org'];
function priority(url:string):number {
 const u=new URL(url),host=u.hostname.toLowerCase();
 // A bounded preference, not a claim that the publisher or page is independently verified.
 return /\.(gov|edu)(\.[a-z]{2})?$/.test(host)||primaryDomains.some(d=>host===d||host.endsWith('.'+d))?2:/\/(docs?|documentation|research|papers?|releases?)\//i.test(u.pathname)?1:0;
}
export function articleResearchCandidates(items:ResearchCandidate[]):ArticleAutoResearch['candidates'] {
 const seen=new Set<string>();const safe:ResearchCandidate[]=[];
 for(const item of items.slice(0,5)){
  try{const key=researchUrlKey(item.url);if(seen.has(key)||!item.title?.trim())continue;seen.add(key);safe.push({...item,url:articlePublicUrl(item.url).href});}catch{/* Unsafe candidates cannot enter the reader. */}
 }
 const sorted=safe.sort((a,b)=>priority(b.url)-priority(a.url));
 // Give other publishers a chance before several pages on the same host.
 const hosts=new Set<string>(),first:ResearchCandidate[]=[],rest:ResearchCandidate[]=[];
 for(const c of sorted){const h=new URL(c.url).hostname;hosts.has(h)?rest.push(c):(hosts.add(h),first.push(c));}
 return [...first,...rest].map(c=>({url:c.url,title:c.title.slice(0,500),domain:new URL(c.url).hostname,status:'pending',...(c.publishedAt&&Number.isFinite(Date.parse(c.publishedAt))?{publishedAt:c.publishedAt}:{} )}));
}
export function sameResearchText(a:string,b:string):boolean {
 // Keep changed numbers, negations, casing and attribution: a near-copy may contain
 // a correction or contradiction. Only whitespace differences are ignored.
 return a.replace(/\s+/g,'')===b.replace(/\s+/g,'');
}
