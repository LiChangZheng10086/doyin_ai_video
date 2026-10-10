import React from 'react';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {ArticleAutoWorkspace} from './ArticleAutoWorkspace.js';
import type {ArticleRecord} from '../../../src/lib/article-types.js';
test('automatic workspace distinguishes read-body date, search-reported date and fetching, and exposes failed candidates without a draft',()=>{
 const a={id:'fixture',version:1,keyword:'公开选题',sources:[{id:'source',readAt:'2026-10-10T09:00:00Z',publishedAt:undefined}],bodyImageAssetIds:[],coverAssetId:'',adopted:'draft',
  automation:{runId:'run',status:'needs_input',stage:'search',checkpoints:{search:{status:'failed'}},error:{code:'needs_material',message:'请补充正文'},research:{query:'公开资料',status:'complete',fetchedAt:'2026-10-10T08:00:00Z',message:'部分来源未读到正文',candidates:[{url:'https://example.com/article',title:'公开文章',domain:'example.com',publishedAt:'2026-09-01T08:00:00Z',status:'readable',sourceId:'source'},{url:'https://example.com/blocked',title:'受限页面',domain:'example.com',status:'failed',message:'搜索摘要未作为资料'}]}}} as unknown as ArticleRecord;
 const html=renderToStaticMarkup(<MemoryRouter><ArticleAutoWorkspace article={a} onUpdated={()=>{}} onAdvanced={()=>{}} onProtected={()=>{}}/></MemoryRouter>);
 for(const text of ['搜索并读取公开资料','公开资料检索','正文发布日期：未知','搜索报告日期：2026-09-01','正文读取：2026-10-10','检索时间：2026-10-10','搜索摘要未作为资料','补充可用正文'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('确认保存公众号草稿'));
});
