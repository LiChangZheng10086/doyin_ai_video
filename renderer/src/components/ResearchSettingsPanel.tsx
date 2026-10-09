import React, { useEffect, useState } from 'react';
import { Button } from './ui/Button';
import { apiClient, parseApiError } from '../services/api';
import type { ResearchConfig, ResearchStatus } from '../../../src/lib/research-types';
export function ResearchSettingsPanel(){
  const [status,setStatus]=useState<ResearchStatus>();const [config,setConfig]=useState<ResearchConfig>({jinaEnabled:false,exaEnabled:false});const [busy,setBusy]=useState(false);const [dirty,setDirty]=useState(false);const [message,setMessage]=useState('');
  useEffect(()=>{let live=true;void apiClient.getResearchStatus().then(result=>{if(live){setStatus(result);setConfig(result.config);}}).catch(e=>{if(live)setMessage(parseApiError(e).message);});return()=>{live=false;};},[]);
  const desktop=status?.configurationSource==='desktop'&&!!window.electron?.saveConfig;
  const save=async()=>{setBusy(true);setMessage('');try{await window.electron.saveConfig!({research:config});const latest=await apiClient.getResearchStatus();setStatus(latest);setConfig(latest.config);setDirty(false);setMessage('设置已保存，立即生效。读取与搜索由你主动触发。');}catch(e){setMessage(e instanceof Error?e.message:'保存失败，本次修改未保存');}finally{setBusy(false);}};
  return <section className="space-y-4 rounded-xl border border-line bg-panel p-6"><h2 className="text-lg font-semibold text-ink">资料搜索与阅读</h2><p className="text-sm leading-7 text-ink-muted">为热点和文章获取公开资料。服务只接收公开链接或搜索词，不携带平台登录凭据。可读性与免费限额由来源服务决定。</p>
    {(['jinaEnabled','exaEnabled'] as const).map(key=><label key={key} className="flex items-start gap-3 text-sm text-ink"><input type="checkbox" checked={config[key]} disabled={!desktop||busy} onChange={e=>{setConfig(c=>({...c,[key]:e.target.checked}));setDirty(true);setMessage('');}}/><span>{key==='jinaEnabled'?'启用 Jina 阅读：向该服务发送公开网页链接':'启用 Exa 搜索：向该服务发送搜索词，受免费限额约束'}</span></label>)}
    {desktop?<Button disabled={busy||!dirty} onClick={()=>void save()}>{busy?'正在保存…':'保存资料设置'}</Button>:<p className="break-words text-sm leading-7 text-ink-muted">独立后端设置 RESEARCH_JINA_ENABLED=1 / RESEARCH_EXA_ENABLED=1 并重启；本页面显示后端状态，不在浏览器中写入配置。</p>}
    {status&&Object.entries(status.providers).map(([name,report])=><p key={name} className="text-xs text-ink-muted">{name}：{report.state==='unverified'?'尚未验证（请主动读取或搜索）':report.state==='ok'?'最近请求成功':'最近请求失败'}{report.message?` · ${report.message}`:''}</p>)}
    {message&&<p role="status" className="text-sm text-ink">{message}</p>}
  </section>;
}
