import React, { useEffect, useState } from 'react';
import { MODERN_WECHAT_LAYOUTS, WECHAT_LAYOUTS, WRITING_STRUCTURES, type WechatLayoutOptions, type WechatLayoutDefaults } from '../../../src/lib/wechat-templates';
import { apiClient, parseApiError } from '../services/api';
const selectClass='mt-2 w-full rounded-lg border border-line-ui bg-canvas px-3 py-2 text-sm text-ink focus:border-accent focus:ring-1 focus:ring-accent';
export function ArticleTemplatePicker({value,layoutVersion,options={},onChange,previewHtml,previewTitle,previewBusy=false,previewError=''}:{
  value:string;layoutVersion?:2|null;options?:WechatLayoutOptions;onChange:(id:string,version:2|null,options?:WechatLayoutOptions)=>void;
  previewHtml?:string;previewTitle?:string;previewBusy?:boolean;previewError?:string;
}) {
  const layout=MODERN_WECHAT_LAYOUTS.find(t=>t.id===value);
  const modern=layoutVersion===2&&!!layout;
  const [defaults,setDefaults]=useState<WechatLayoutDefaults>();const [saving,setSaving]=useState(false);const [message,setMessage]=useState('');const [defaultError,setDefaultError]=useState('');
  useEffect(()=>{let live=true;void apiClient.getArticleLayoutDefaults().then(v=>{if(live)setDefaults(v);}).catch(e=>{if(live)setDefaultError(parseApiError(e).message);});return()=>{live=false;};},[]);
  const adjust=(patch:WechatLayoutOptions)=>onChange(value,2,{...options,...patch});
  const setDefault=async(reset=false)=>{
    if(!defaults||saving)return;setSaving(true);setMessage('');setDefaultError('');
    try{setDefaults(await apiClient.saveArticleLayoutDefaults(reset?{version:defaults.version,reset:true}:{version:defaults.version,layoutTemplate:value,layoutOptions:options}));setMessage(reset?'已恢复新文章的默认排版，当前文章保持原样':'已设为新文章默认，已有文章保持原样');}
    catch(e){setDefaultError(parseApiError(e).message);try{setDefaults(await apiClient.getArticleLayoutDefaults());}catch{/* Keep current article selection. */}}
    finally{setSaving(false);}
  };
  return <section aria-label="公众号模板与排版" className="rounded-xl border border-line bg-canvas p-4 sm:p-5">
    <div className="mb-5"><h3 className="text-base font-semibold text-ink">选择文章的阅读方式</h3><p className="mt-2 text-xs leading-6 text-ink-muted">切换只改变排版，正文与事实引用保留。右侧预览当前稿件，保存编辑后用于交付。</p></div>
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(260px,.9fr)_minmax(0,1.1fr)]">
      <div className="min-w-0 space-y-5"><div role="group" aria-label="六类公众号模板" className="grid grid-cols-2 gap-2">{MODERN_WECHAT_LAYOUTS.map((t,i)=><button key={t.id} type="button" aria-label={`选择${t.name}模板`} aria-pressed={modern&&value===t.id} onClick={()=>onChange(t.id,2,{})} className={`min-w-0 rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${modern&&value===t.id?'border-accent bg-accent-soft':'border-line bg-panel hover:border-accent'}`}>
        <span className="mb-3 flex h-10 items-center gap-2 overflow-hidden" aria-hidden="true"><span style={{backgroundColor:t.color}} className={`block ${i===4?'h-10 w-full rounded-sm':i===5?'h-8 w-8 rounded-md':'h-1 w-9'}`}/>{i!==4&&<span className="flex-1 space-y-1"><span className="block h-1 w-4/5 rounded bg-ink/15"/><span className="block h-1 w-3/5 rounded bg-ink/10"/>{i===1&&<span className="block h-3 w-full rounded bg-ink/5"/>}</span>}</span>
        <span className="block text-sm font-semibold text-ink">{t.name}</span><span className="mt-1 block text-[11px] leading-5 text-ink-muted">{t.description}</span>
      </button>)}</div>
      <details open={!modern}><summary className="cursor-pointer text-xs text-ink-muted">保留的旧模板</summary><label className="mt-3 block text-xs text-ink-muted">旧版排版<select aria-label="旧版排版模板" className={selectClass} value={modern?'':value} onChange={e=>{if(e.target.value)onChange(e.target.value,null);}}><option value="">选择旧模板</option>{WECHAT_LAYOUTS.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><p className="mt-2 text-xs leading-5 text-ink-muted">旧文章不会自动升级；选择上方模板才启用新版结构。</p></details>
      <fieldset disabled={!modern} className="space-y-4 rounded-lg border border-line p-4"><legend className="px-2 text-xs font-medium text-ink">阅读细节</legend>
        <label className="flex items-center justify-between gap-3 text-xs text-ink-muted">主题色<input aria-label="模板主题色" type="color" value={options.themeColor??layout?.color??'#2563eb'} onChange={e=>adjust({themeColor:e.target.value})} className="h-8 w-12 cursor-pointer rounded border border-line bg-transparent"/></label>
        <label className="block text-xs text-ink-muted">正文字号<select aria-label="正文字号" className={selectClass} value={options.fontSize??layout?.fontSize??16} onChange={e=>adjust({fontSize:Number(e.target.value)})}>{[15,16,17,18].map(n=><option key={n} value={n}>{n} px</option>)}</select></label>
        <label className="block text-xs text-ink-muted">行距 <output className="float-right font-mono">{options.lineHeight??layout?.lineHeight??1.85}</output><input aria-label="正文行距" type="range" min="1.5" max="2.1" step="0.05" value={options.lineHeight??layout?.lineHeight??1.85} onChange={e=>adjust({lineHeight:Number(e.target.value)})} className="mt-3 w-full accent-accent"/></label>
        <button type="button" onClick={()=>onChange(value,2,{})} className="text-xs font-medium text-accent hover:underline">恢复这套模板的初始样式</button>
      </fieldset>
      <div className="space-y-3 border-t border-line pt-4"><p className="text-xs leading-5 text-ink-muted">新文章默认：{defaults?(MODERN_WECHAT_LAYOUTS.find(t=>t.id===defaults.layoutTemplate)?.name??defaults.layoutTemplate):'正在读取…'}</p><div className="flex flex-wrap gap-3"><button type="button" disabled={!modern||!defaults||saving} onClick={()=>void setDefault()} className="rounded-md border border-line-ui px-3 py-2 text-xs font-medium text-ink disabled:opacity-40">设为新文章默认</button><button type="button" disabled={!defaults||saving} onClick={()=>void setDefault(true)} className="px-1 py-2 text-xs text-ink-muted disabled:opacity-40">恢复默认设置</button></div>{message&&<p role="status" className="text-xs leading-5 text-accent">{message}</p>}{defaultError&&<p role="alert" className="text-xs text-danger">{defaultError}</p>}</div>
      </div>
      <section aria-label="当前文章模板预览" className="min-w-0 rounded-xl border border-line bg-panel p-3"><div className="mb-3 flex items-start justify-between gap-3"><div><p className="text-xs font-medium text-ink">当前文章 · 手机预览</p><p className="mt-1 text-xs text-ink-muted">{previewTitle??'完成初稿后查看真实文章'}</p></div><span className="shrink-0 text-[11px] text-ink-subtle">{modern?layout?.name:'保留旧样式'}</span></div>
        {previewBusy?<div role="status" className="flex h-[600px] items-center justify-center text-sm text-ink-muted">正在更新排版…</div>:previewError?<p role="alert" className="min-h-40 p-5 text-sm text-danger">{previewError}</p>:previewHtml?<iframe title="当前文章手机排版预览" sandbox="" srcDoc={`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0">${previewHtml}</body>`} className="mx-auto h-[600px] w-full max-w-[390px] rounded-lg border border-line bg-white"/>:<p className="flex min-h-60 items-center justify-center p-5 text-sm leading-7 text-ink-muted">尚无初稿。先完成文章初稿，再用这篇文章选择排版。</p>}
      </section>
    </div>
  </section>;
}
export function WritingStructurePicker({value,onChange}:{value:string;onChange:(value:string)=>void}){
  const choice=WRITING_STRUCTURES.find(t=>t.value===value);
  return <label className="block text-xs font-medium text-ink-muted">写作结构模板<select aria-label="写作结构模板" value={choice?.value??'custom'} onChange={e=>onChange(e.target.value)} className={selectClass}>{WRITING_STRUCTURES.map(t=><option key={t.name} value={t.value}>{t.name}</option>)}{!choice&&<option value="custom">自定义结构</option>}</select></label>;
}
