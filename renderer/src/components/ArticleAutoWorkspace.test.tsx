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

test('legacy input recovery requires explicit public keywords and confirmation before enabling search',()=>{
 const a={id:'old',version:14,keyword:'什么是skills？',input:{kind:'text',raw:'什么是skills？',hash:'fixture'},sources:[],bodyImageAssetIds:[],coverAssetId:'',adopted:'draft',automation:{runId:'run',status:'failed',stage:'evidence',checkpoints:{},error:{code:'ai_facts_empty',message:'请补充正文'}}} as unknown as ArticleRecord;
 const html=renderToStaticMarkup(<MemoryRouter><ArticleAutoWorkspace article={a} onUpdated={()=>{}} onAdvanced={()=>{}} onProtected={()=>{}}/></MemoryRouter>);
 for(const value of ['确认输入类型并继续','完整正文，直接使用','恢复公开搜索关键词','确认公开搜索词','诊断代码：','ai_facts_empty'])assert.ok(html.includes(value),value);
 assert.match(html,/disabled=""[^>]*>按所选类型继续创作/);
 assert.ok(!html.includes('value="什么是skills？"'));
});

test('AI request failures with existing readable material offer continuation without asking to correct input',()=>{
 const a={id:'network',version:34,keyword:'什么是skills？',input:{kind:'idea',raw:'什么是skills？',hash:'fixture'},sources:[{id:'source',included:true,status:'readable',text:'公开资料'}],bodyImageAssetIds:[],coverAssetId:'',adopted:'draft',automation:{runId:'run',status:'failed',stage:'evidence',checkpoints:{},error:{code:'ai_connection_interrupted',message:'AI连接中断'}}} as unknown as ArticleRecord;
 const html=renderToStaticMarkup(<MemoryRouter><ArticleAutoWorkspace article={a} onUpdated={()=>{}} onAdvanced={()=>{}} onProtected={()=>{}}/></MemoryRouter>);
 assert.ok(html.includes('继续自动创作'));
 assert.ok(html.includes('ai_connection_interrupted'));
 assert.ok(!html.includes('确认输入类型并继续'));
 assert.ok(!html.includes('恢复公开搜索关键词'));
});

test('legacy generic output failures allow correcting only the original misclassified text',()=>{
 const raw='什么是skills？';
 const a={id:'old-output',version:14,keyword:raw,input:{kind:'text',raw,hash:'fixture'},sources:[{id:'original',kind:'text',included:true,status:'readable',text:raw}],bodyImageAssetIds:[],coverAssetId:'',adopted:'draft',automation:{runId:'run',status:'failed',stage:'evidence',checkpoints:{},error:{code:'ai_output_invalid',message:'旧版错误'}}} as unknown as ArticleRecord;
 const render=()=>renderToStaticMarkup(<MemoryRouter><ArticleAutoWorkspace article={a} onUpdated={()=>{}} onAdvanced={()=>{}} onProtected={()=>{}}/></MemoryRouter>);
 assert.ok(render().includes('确认输入类型并继续'));
 a.sources.push({id:'public-source',kind:'web',included:true,status:'readable',text:'完整公开资料'} as any);
 assert.ok(!render().includes('确认输入类型并继续'));
});
