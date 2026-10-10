import {articlePublicUrl} from './article-sources.js';
export interface ParsedArticleInput {kind:'idea'|'text'|'url'|'mixed';text:string;urls:string[];keyword:string;raw:string;confirmPublicQuery?:boolean}
export function parseArticleInput(value:unknown):ParsedArticleInput {
 if(typeof value!=='string'||!value.trim()||value.length>30000)throw new Error('请填写灵感、正文或公开链接，最多30000字符');
 const raw=value.trim(),urls:string[]=[];
 if(/(?:file|ftp):\/\//i.test(raw))throw new Error('仅支持公开 HTTPS 网页链接与文字资料');
 const text=raw.replace(/https?:\/\/[^\s<>「」“”，。；！？、]+/gi,link=>{const clean=link.replace(/[，。；、）)]+$/u,'');const url=articlePublicUrl(clean).href;if(!urls.includes(url))urls.push(url);return '';}).trim();
 if(urls.length>3)throw new Error('一次最多读取3个公开链接，请减少链接后重试');
 const requestedIdea=text.length<200&&/^(?:我?想|帮我|写一篇|聊聊|介绍一下|关于|讨论)/.test(text);
 // Question-only outlines are ideas; a declarative answer or pasted body remains text.
 const clauses=text.split(/[。！？!?\n]+/).map(s=>s.trim()).filter(Boolean);
 const questionIdea=text.length<200&&clauses.length>0&&clauses.every(s=>/^(?:什么(?:是|叫)|何为|如何|怎样|怎么|为什么|为何|是否|能否|有哪些|what\b|how\b|why\b)/i.test(s));
 const shortLabel=text.length<80&&!/[。！？\n]/.test(text);
 const kind=urls.length?(text?'mixed':'url'):(requestedIdea||questionIdea||shortLabel)?'idea':'text';
 const keyword=(text.split(/\n/).find(l=>l.trim())??(urls.length?new URL(urls[0]).hostname:'文章创作')).slice(0,500);
 // Inferred ideas need explicit public search terms. Never forward an ambiguous
 // short note, private question, or pasted body merely because of its length.
 return {kind,text,urls,keyword,raw,...(kind==='idea'&&!requestedIdea?{confirmPublicQuery:true}:{})};
}
export function recommendArticleLayout(text:string):{id:string;reason:string} {
 if(/教程|安装|操作步骤|操作指南|how.to/i.test(text))return{id:'practical-guide',reason:'内容包含操作与步骤，使用实操教程'};
 if(/清单|推荐|资源合集|工具对比/i.test(text))return{id:'resource-list',reason:'内容以工具或资源分组，使用清单推荐'};
 if(/简报|新闻|行业动态|财报/i.test(text))return{id:'business-brief',reason:'内容偏新闻或行业变化，使用商务简报'};
 if(/深度|深入分析|观点|长文/i.test(text))return{id:'deep-reading',reason:'内容偏长篇分析，使用深度长文'};
 if(/图片故事|图说|旅行记录|案例/i.test(text))return{id:'image-story',reason:'内容偏图片与案例叙事，使用图片故事'};
 return{id:'tech-explainer',reason:'以概念和用途解释为主，使用科技解读'};
}
