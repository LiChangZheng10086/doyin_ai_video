import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResearchPanel, ResearchReadView, toggleResearchSelection } from './ResearchPanel.js';
import type { ResearchReadResult } from '../../../src/lib/research-types.js';
test('panel starts without requests and labels evidence separately from search clues',()=>{
  const html=renderToStaticMarkup(<ResearchPanel initialQuery="人工智能" onImport={async()=>{}}/>);
  assert.match(html,/搜索相关报道/);assert.match(html,/搜索线索/);assert.match(html,/公开报道链接/);
});
test('topics and challenge text cannot be selected; article text is escaped',()=>{
  const read={readId:'id',url:'https://news.example.com/a',title:'<script>坏标题</script>',kind:'topic',status:'needs_material',text:'',excerpt:'榜单信息',readAt:'2026-10-08T00:00:00Z',expiresAt:'2026-10-08T00:30:00Z',hash:'hash',truncated:false,provider:'jina',candidates:[]} as ResearchReadResult;
  const topic=renderToStaticMarkup(<ResearchReadView read={read} selected={false} onSelect={()=>{}}/>);assert.doesNotMatch(topic,/type="checkbox"/);assert.match(topic,/话题线索/);
  const article=renderToStaticMarkup(<ResearchReadView read={{...read,kind:'article',status:'readable',text:'<img src=x onerror=alert(1)>'}} selected={false} onSelect={()=>{}}/>);
  assert.match(article,/type="checkbox"/);assert.doesNotMatch(article,/<script>|<img/);assert.match(article,/&lt;img/);
  assert.deepEqual(toggleResearchSelection([{readId:'1',hash:'h'},{readId:'2',hash:'h'},{readId:'3',hash:'h'}],{readId:'4',hash:'h'},3),[{readId:'1',hash:'h'},{readId:'2',hash:'h'},{readId:'3',hash:'h'}]);
});
