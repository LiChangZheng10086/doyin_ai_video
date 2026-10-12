import React, { useEffect, useRef, useState } from 'react';
import { apiClient, parseApiError } from '../services/api';
import { Button } from './ui/Button';
import type { ArticleRecord } from '../../../src/lib/article-types';
import type { AssetRecord } from '../types';

export function ArticleImageBindings({article:a,disabled,onUpdated,onProtected,onBusyChange}:{article:ArticleRecord;disabled:boolean;onUpdated:(a:ArticleRecord)=>void;onProtected:(value:boolean)=>void;onBusyChange:(value:boolean)=>void}) {
  const live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const [assets,setAssets]=useState<AssetRecord[]>([]),[urls,setUrls]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [descriptions,setDescriptions]=useState<Record<number,string>>({});
  const locked=disabled||busy;
  useEffect(()=>{onProtected(busy||Object.values(descriptions).some(Boolean));},[busy,descriptions,onProtected]);
  useEffect(()=>()=>onProtected(false),[onProtected]);
  useEffect(()=>{onBusyChange(busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
  const load=async()=>{
    const images=(await apiClient.searchImageAssets()).assets;
    const matching=images.filter(asset=>a.illustrations.some(image=>asset.generationPrompt===image.prompt));
    const previews=await Promise.all(matching.map(async image=>[image.id,await apiClient.getAssetRawUrl(image.id)] as const));
    setAssets(matching);setUrls(Object.fromEntries(previews));
  };
  useEffect(()=>{let live=true;void apiClient.searchImageAssets().then(async({assets})=>{
    const matching=assets.filter(asset=>a.illustrations.some(image=>asset.generationPrompt===image.prompt));
    const previews=await Promise.all(matching.map(async image=>[image.id,await apiClient.getAssetRawUrl(image.id)] as const));
    if(live){setAssets(matching);setUrls(Object.fromEntries(previews));}
  }).catch(()=>{if(live)setError('读取已绑定素材失败，请刷新图片');});return()=>{live=false;};},[a.id,a.illustrations]);
  const bind=async(index:number,assetId:string)=>{
    const updated=await apiClient.bindArticleIllustration(a.id,index,a.version,assetId);
    if(live.current){onUpdated(updated);setDescriptions(current=>({...current,[index]:''}));setNotice('已绑定并用于文章，可在预览检查位置。');}
  };
  const select=async(index:number,assetId:string)=>{setBusy(true);setError('');try{await bind(index,assetId);}catch(e){setError(parseApiError(e).message);}finally{setBusy(false);}};
  const upload=async(index:number,file:File)=>{
    setBusy(true);setError('');setNotice('');let uploaded=false;
    try{
      const result=await apiClient.uploadImageAssets([file],[{description:descriptions[index]??'',tags:[],generationPrompt:a.illustrations[index].prompt}]);
      if(!result.assets[0])throw new Error(result.failures?.[0]?.message??'图片上传失败');
      uploaded=true;setAssets(current=>[result.assets[0],...current]);
      const asset=result.assets[0];setUrls(current=>({...current,[asset.id]:''}));
      await bind(index,asset.id);await load();
    }catch(e){setError(uploaded?`图片已入库；${parseApiError(e).message}。请载入最新文章，再从下方素材绑定，无需重新上传。`:`${parseApiError(e).message}。若请求中断，请先刷新图片核对入库结果，再决定是否重传。`);}
    finally{setBusy(false);}
  };
  if(a.steps.illustrations!=='succeeded'||!a.illustrations.length)return null;
  return <section className="space-y-4 rounded-xl border border-line bg-panel p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold text-ink">按提示词绑定配图</h2><Button size="sm" variant="outline" disabled={locked} onClick={()=>{setBusy(true);void load().catch(e=>setError(parseApiError(e).message)).finally(()=>setBusy(false));}}>刷新图片</Button></div>
    <p className="text-sm leading-6 text-ink-muted">复制提示词到你使用的生图工具，生成后在对应位置上传。图片保存提示词快照，绑定后直接用于封面或对应章节。</p>
    {error&&<p role="alert" className="text-sm text-danger">{error}</p>}{notice&&<p role="status" className="text-sm text-success">{notice}</p>}
    {a.illustrations.map((image,index)=>{
      const selected=image.assetId&&(image.section===0?a.coverAssetId===image.assetId:a.bodyImageAssetIds.includes(image.assetId));
      return <article key={index} className="space-y-3 rounded-lg border border-line bg-canvas p-4">
        <h3 className="font-medium text-ink">{image.section===0?'封面':`第${image.section}节配图`} · {image.purpose}{selected?' · 已使用':''}</h3>
        <p className="text-xs leading-6 text-ink-muted">{image.caption}</p><p className="whitespace-pre-wrap text-sm leading-7 text-ink">{image.prompt}</p>
        <Button size="sm" variant="outline" disabled={locked} onClick={()=>void navigator.clipboard.writeText(image.prompt).then(()=>setNotice('提示词已复制')).catch(()=>setError('复制失败，请手动选择文字'))}>复制提示词</Button>
        <label className="block text-xs text-ink-muted">实际画面描述（可选）<input aria-label={`${image.section===0?'封面':`第${image.section}节`}图片描述`} disabled={locked} value={descriptions[index]??''} maxLength={1000} onChange={e=>setDescriptions(current=>({...current,[index]:e.target.value}))} className="mt-2 w-full rounded-lg border border-line-ui bg-panel p-2 text-sm text-ink"/></label>
        <label className="block text-sm text-ink">{selected?'上传新图替换此位置':'上传图片并绑定此提示词'}<input aria-label={`上传${image.section===0?'封面':`第${image.section}节配图`}`} type="file" accept=".jpg,.jpeg,.png,.webp" disabled={locked} className="mt-2 block max-w-full text-xs" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void upload(index,file);}}/></label>
        <div className="flex flex-wrap gap-3">{assets.filter(asset=>asset.generationPrompt===image.prompt).map(asset=><figure key={asset.id} className="w-36 rounded border border-line p-2">{urls[asset.id]&&<img src={urls[asset.id]} alt={asset.description||asset.originalName} className="h-24 w-full object-contain"/>}<figcaption className="mt-2 truncate text-xs text-ink-muted">{asset.originalName}</figcaption><Button size="sm" disabled={locked} variant={selected&&image.assetId===asset.id?'primary':'outline'} onClick={()=>void select(index,asset.id)}>{selected&&image.assetId===asset.id?'当前使用':'绑定并使用'}</Button></figure>)}</div>
      </article>;
    })}
  </section>;
}
