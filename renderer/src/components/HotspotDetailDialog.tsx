import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './ui/Modal';
import { ResearchPanel, ResearchSourceLink } from './ResearchPanel';
import { apiClient } from '../services/api';
import type { HotspotItem } from '../../../src/lib/hotspots';
export type HotspotDetailItem=HotspotItem&{sourceName?:string;fetchedAt?:string};
export function HotspotDetailDialog({item,onClose}:{item:HotspotDetailItem|null;onClose:()=>void}){
  const navigate=useNavigate();const [creating,setCreating]=useState(false);
  return <Modal open={!!item} onClose={onClose} title={item?.title} ariaLabel="热点详情" size="xl" busy={creating}>
    {item&&<div className="space-y-5"><div className="space-y-2 border-b border-line pb-4"><p className="text-xs text-ink-muted">{item.sourceName??item.sourceId} · 榜单排名 {item.rank}{item.heat?` · 原始热度 ${item.heat}`:''}</p>{item.fetchedAt&&<p className="text-xs text-ink-muted">榜单获取于 {new Date(item.fetchedAt).toLocaleString('zh-CN')}</p>}{item.summary&&<><p className="text-xs text-ink-muted">榜单摘要</p><p className="whitespace-pre-wrap text-sm leading-7 text-ink">{item.summary}</p></>}<ResearchSourceLink url={item.url}>打开来源原文</ResearchSourceLink></div>
      <ResearchPanel key={`${item.sourceId}:${item.itemId}`} initialQuery={item.title} initialItem={item} importLabel="用于文章创作" onImport={async selections=>{
        setCreating(true);try{const article=await apiClient.createArticle({keyword:item.title,hotspot:{sourceId:item.sourceId,itemId:item.itemId},researchSelections:selections});onClose();navigate(`/articles/${article.id}`);}finally{setCreating(false);}
      }}/>
    </div>}
  </Modal>;
}
