import React, { useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';
import { apiClient, parseApiError } from '../services/api';
import type { HotspotItem } from '../../../src/lib/hotspots';
import type { ResearchCandidate, ResearchReadResult, ResearchSelection, ResearchSearchResult } from '../../../src/lib/research-types';

export function toggleResearchSelection(items:ResearchSelection[],item:ResearchSelection,max:number):ResearchSelection[]{
  return items.some(s=>s.readId===item.readId)?items.filter(s=>s.readId!==item.readId):items.length<max?[...items,item]:items;
}
export function ResearchSourceLink({url,children}:{url:string;children:React.ReactNode}){
  return <a href={url} target="_blank" rel="noopener noreferrer" className="break-all text-xs text-accent hover:underline" onClick={event=>{if(window.electron?.openExternal){event.preventDefault();void window.electron.openExternal(url);}}}>{children}</a>;
}
export function ResearchReadView({read,selected,onSelect,disabled=false}:{read:ResearchReadResult;selected:boolean;onSelect:()=>void;disabled?:boolean}){
  const readable=read.kind==='article'&&read.status==='readable';
  return <article className="min-w-0 space-y-3 rounded-lg border border-line bg-canvas p-4">
    <div className="flex items-start justify-between gap-3"><h4 className="break-words text-sm font-semibold text-ink">{read.title}</h4><span className="shrink-0 text-xs text-ink-muted">{readable?'报道正文':read.kind==='topic'?'话题线索':'未读取到正文'}</span></div>
    <ResearchSourceLink url={read.url}>打开原文 · {new URL(read.url).hostname}</ResearchSourceLink>
    <p className="text-xs text-ink-muted">读取方式：{read.provider} · {read.publishedAt?`来源发布时间 ${new Date(read.publishedAt).toLocaleString('zh-CN')}`:'来源发布时间未知'}{read.truncated?' · 正文已截断':''}</p>
    {read.error&&<p role="status" className="text-sm text-warning">{read.error.message}</p>}
    {(read.text||read.excerpt)&&<div className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-7 text-ink-muted">{read.text||read.excerpt}</div>}
    {readable&&<label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={selected} disabled={disabled} onChange={onSelect}/>选择这份正文用于文章</label>}
  </article>;
}
export function ResearchPanel({initialQuery,initialItem,maxSelection=3,onImport,importDisabled=false,importLabel='加入文章资料'}:{initialQuery:string;initialItem?:HotspotItem;maxSelection?:number;onImport:(selections:ResearchSelection[])=>Promise<void>;importDisabled?:boolean;importLabel?:string}){
  const [query,setQuery]=useState(initialQuery);const [url,setUrl]=useState('');const [search,setSearch]=useState<ResearchSearchResult>();
  const [reads,setReads]=useState<ResearchReadResult[]>([]);const [selections,setSelections]=useState<ResearchSelection[]>([]);
  const [searching,setSearching]=useState(false);const [reading,setReading]=useState(false);const [importing,setImporting]=useState(false);const [error,setError]=useState('');
  const requests=useRef({search:0,read:0});const controllers=useRef<{search?:AbortController;read?:AbortController}>({});const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controllers.current.search?.abort();controllers.current.read?.abort();};},[]);
  const searchSources=async()=>{
    controllers.current.search?.abort();const controller=new AbortController();controllers.current.search=controller;const id=++requests.current.search;setSearching(true);setError('');
    try{const result=await apiClient.searchResearch(query,controller.signal);if(alive.current&&id===requests.current.search)setSearch(result);}
    catch(e){if(alive.current&&!controller.signal.aborted&&id===requests.current.search)setError(parseApiError(e).message);}finally{if(alive.current&&id===requests.current.search)setSearching(false);}
  };
  const readSource=async(target?:ResearchCandidate)=>{
    controllers.current.read?.abort();const controller=new AbortController();controllers.current.read=controller;const id=++requests.current.read;setReading(true);setError('');
    try{
      const result=target?await apiClient.readResearch({url:target.url},controller.signal):initialItem?(await apiClient.getHotspotDetail(initialItem.sourceId,initialItem.itemId,controller.signal)).result:await apiClient.readResearch({url},controller.signal);
      if(!alive.current||id!==requests.current.read)return;
      setReads(items=>[result,...items.filter(item=>item.url!==result.url)]);
      setSelections(items=>items.filter(item=>!reads.some(read=>read.readId===item.readId&&read.url===result.url)||item.readId===result.readId));
    }catch(e){if(alive.current&&!controller.signal.aborted&&id===requests.current.read)setError(parseApiError(e).message);}finally{if(alive.current&&id===requests.current.read)setReading(false);}
  };
  const importSources=async()=>{setImporting(true);setError('');try{await onImport(selections);if(alive.current)setSelections([]);}catch(e){if(alive.current)setError(parseApiError(e).message);}finally{if(alive.current)setImporting(false);}};
  const candidates=[...(search?.candidates??[]),...reads.flatMap(read=>read.candidates)].filter((item,i,all)=>all.findIndex(c=>c.url===item.url)===i);
  return <section className="min-w-0 space-y-4" aria-label="资料搜索与阅读">
    <p className="text-xs leading-6 text-ink-muted">搜索线索与话题描述需要进一步读取；只有报道正文能加入文章。外部服务可在设置「资料搜索与阅读」中启用。</p>
    {initialItem?<Button disabled={reading||importing} onClick={()=>void readSource()}>{reading?'正在读取…':'读取来源'}</Button>:<div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-xs text-ink-muted">公开报道链接<input value={url} maxLength={4096} onChange={e=>setUrl(e.target.value)} className="mt-2 w-full rounded-lg border border-line-ui bg-well p-2 text-sm text-ink"/></label><Button disabled={!url.trim()||reading||importing} onClick={()=>void readSource()}>{reading?'正在读取…':'读取链接'}</Button></div>}
    <form className="flex flex-wrap items-end gap-2" onSubmit={e=>{e.preventDefault();if(!searching&&query.trim())void searchSources();}}><label className="min-w-0 flex-1 text-xs text-ink-muted">搜索词<input aria-label="资料搜索词" value={query} maxLength={500} onChange={e=>setQuery(e.target.value)} className="mt-2 w-full rounded-lg border border-line-ui bg-well p-2 text-sm text-ink"/></label><Button type="submit" disabled={!query.trim()||searching||importing}>{searching?'正在搜索…':'搜索相关报道'}</Button></form>
    {error&&<p role="alert" className="rounded-lg border border-danger-line bg-danger-soft p-3 text-sm text-danger">{error}</p>}
    {search&&<p role="status" className="text-xs text-ink-muted">「{search.query}」· {search.candidates.length}条搜索线索{search.cached?' · 缓存结果':''}{search.candidates.length===0?'，可调整搜索词或手动补充链接。':''}</p>}
    {candidates.length>0&&<ul className="divide-y divide-line rounded-lg border border-line">{candidates.map(item=><li key={item.url} className="min-w-0 space-y-2 p-3"><h4 className="break-words text-sm text-ink">{item.title}</h4><ResearchSourceLink url={item.url}>{item.domain}</ResearchSourceLink>{item.snippet&&<p className="whitespace-pre-wrap break-words text-xs leading-6 text-ink-muted">搜索摘录：{item.snippet}</p>}<Button size="sm" disabled={reading||importing} onClick={()=>void readSource(item)}>读取这篇报道</Button></li>)}</ul>}
    {reads.map(read=><ResearchReadView key={read.readId} read={read} selected={selections.some(s=>s.readId===read.readId)} disabled={importing||(!selections.some(s=>s.readId===read.readId)&&selections.length>=maxSelection)} onSelect={()=>setSelections(items=>toggleResearchSelection(items,{readId:read.readId,hash:read.hash},maxSelection))}/>)}
    <div className="flex flex-wrap items-center gap-3"><Button variant="primary" disabled={importDisabled||importing||selections.length===0} onClick={()=>void importSources()}>{importing?'正在加入…':importLabel}</Button><p className="text-xs text-ink-muted">已选 {selections.length} / {maxSelection} 份正文{importDisabled?' · 请先保存文章编辑或等待当前操作完成':''}</p></div>
  </section>;
}
